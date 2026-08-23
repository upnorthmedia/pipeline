/**
 * Port of `_subscribe_and_stream()` in `api/src/api/events.py`, the generator
 * both SSE endpoints shared.
 *
 * Python opened a Redis pub/sub per request, subscribed to one channel, and
 * forwarded whatever landed on it. The transport is now the retained Redis
 * stream `publishPipelineEvent()` writes to, and the channel name is gone: the
 * per-post channel and the global channel collapsed into one topic in ledger
 * item 5.5a, so the endpoint that used to pick a channel now picks a
 * `matches` predicate instead. Everything else is the same shape, including
 * the decision to open one subscription per request rather than share a
 * process-wide one, which is what `redis.pubsub()` per request did.
 *
 * Three things the transport swap forces, each of which is a real behaviour and
 * not boilerplate:
 *
 * - **`startFrom: "latest"`.** `subscribe()` anchors a new consumer group at
 *   `0` by default, so a browser connecting mid-run would be handed the whole
 *   retained stream (up to `maxStreamLength`, 10000 events) as if it were live.
 *   Python's `PUBLISH` retained nothing, so a connection saw only what arrived
 *   after it. Replay is a feature, but it is ledger item 5.5e and it has to be
 *   asked for, not delivered to every connection by accident.
 * - **Every delivery is acked, including the filtered-out ones.** Redis Streams
 *   keeps an unacked entry in the group's pending list for the life of the
 *   subscription; a dashboard left open for a day would accumulate one entry
 *   per event published installation-wide.
 * - **Teardown on abort.** Each subscription owns a Redis connection and a
 *   private consumer group, and `unsubscribe()` is what quits the one and
 *   destroys the other. Without it a browser refresh leaks both.
 * - **Deliveries are considered one at a time.** `RedisStreamsPubSub` invokes a
 *   subscriber with `sub.cb(event, ack, nack)` and does not await the promise
 *   it returns, so two events whose `matches` calls take different amounts of
 *   time would race and reach the browser out of publication order. That is
 *   invisible while `matches` is synchronous, which is all the per-post
 *   endpoint needs, and becomes real as soon as one has to ask the database
 *   (ledger 5.5d-ii). Chaining every delivery onto the previous one restores
 *   the ordering `PUBLISH` gave for free.
 */
import type { Event } from "@mastra/core/events"

import { pubsub } from "@/mastra"
import { TOPIC_PIPELINE_EVENTS, type PipelineEventPayload } from "@/mastra/pipeline-events"

import { eventAnchor } from "./anchor"
import { SSE_HEADERS, SSE_PING_INTERVAL_MS, encodeSseEvent, encodeSsePing } from "./sse"

/**
 * The published payload, or `null` for anything else on the topic.
 *
 * Python parsed the channel message with `json.loads` and fell back to a raw
 * `update` event when that raised. Nothing unparseable can reach here (the
 * transport carries a decoded object), but an event without a `post_id` still
 * cannot be routed to either endpoint, so it is dropped rather than guessed at.
 */
function payloadOf(event: Event): PipelineEventPayload | null {
  const data = event.data
  if (typeof data !== "object" || data === null) return null
  const postId = (data as { post_id?: unknown }).post_id
  return typeof postId === "string" ? (data as PipelineEventPayload) : null
}

/** `parsed.get("event", "update")`. */
function eventName(payload: PipelineEventPayload): string {
  return typeof payload.event === "string" && payload.event.length > 0 ? payload.event : "update"
}

/**
 * A 200 streaming the pipeline events `matches` accepts, in the shape
 * `web/src/hooks/use-sse.ts` parses: a named event whose `data` is the whole
 * published payload, `event` and `post_id` included, exactly as Python's
 * `json.dumps(parsed)` sent it, carrying the `id:` field `anchor.ts` describes.
 *
 * The subscription is established before the response is returned, so an event
 * published after the caller has its `Response` cannot fall into a gap between
 * the handler returning and the stream being read.
 */
export async function pipelineEventStream(
  request: Request,
  matches: (payload: PipelineEventPayload) => boolean | Promise<boolean>,
): Promise<Response> {
  const encoder = new TextEncoder()
  let ping: ReturnType<typeof setInterval> | undefined
  let listener: ((event: Event, ack?: () => Promise<void>) => Promise<void>) | undefined
  let done = false

  async function teardown(): Promise<void> {
    if (done) return
    done = true
    if (ping !== undefined) clearInterval(ping)
    if (listener !== undefined) await pubsub.unsubscribe(TOPIC_PIPELINE_EVENTS, listener)
  }

  let onSubscribed: () => void
  let onSubscribeFailed: (error: unknown) => void
  const subscribed = new Promise<void>((resolve, reject) => {
    onSubscribed = resolve
    onSubscribeFailed = reject
  })

  const stream = new ReadableStream<Uint8Array>({
    async start(controller) {
      // A client that has already gone leaves the controller closed, so every
      // write is guarded rather than assumed: `enqueue()` throws on a closed
      // stream and would otherwise take down the ack with it.
      const send = (frame: string) => {
        if (done) return
        try {
          controller.enqueue(encoder.encode(frame))
        } catch {
          void teardown()
        }
      }

      // Publication order, preserved across an asynchronous `matches`. The
      // link is added synchronously, inside the same turn the transport called
      // the listener in, so the chain is built in delivery order; a `matches`
      // that rejects is swallowed here rather than left to stall every event
      // behind it, and the event it concerns is not sent, which is the
      // fail-closed answer for a predicate that decides who may see what.
      let tail: Promise<void> = Promise.resolve()

      listener = async (event, ack) => {
        const payload = payloadOf(event)
        // The anchor is read from the delivered envelope, not from the payload:
        // it names the event's position in the retained stream, which is a
        // property of the transport rather than of what the pipeline published.
        const anchor = eventAnchor(event)
        const delivery = tail.then(async () => {
          if (payload !== null && (await matches(payload)))
            send(encodeSseEvent(eventName(payload), payload, anchor))
        })
        tail = delivery.catch(() => {})
        try {
          await tail
        } finally {
          await ack?.()
        }
      }

      try {
        await pubsub.subscribe(TOPIC_PIPELINE_EVENTS, listener, { startFrom: "latest" })
      } catch (error) {
        listener = undefined
        onSubscribeFailed(error)
        return
      }

      ping = setInterval(() => send(encodeSsePing(new Date())), SSE_PING_INTERVAL_MS)
      // `request.signal` aborts when the browser disconnects, which is the
      // `await request.is_disconnected()` poll at the top of Python's loop.
      request.signal.addEventListener("abort", () => {
        void teardown().then(() => {
          try {
            controller.close()
          } catch {
            // Already closed by the consumer cancelling first.
          }
        })
      })
      onSubscribed()
    },
    async cancel() {
      await teardown()
    },
  })

  await subscribed
  return new Response(stream, { status: 200, headers: SSE_HEADERS })
}
