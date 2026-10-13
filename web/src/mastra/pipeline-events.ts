/**
 * The dashboard's realtime event bus, ported from `publish_event()` in
 * `api/src/api/events.py`.
 *
 * Python published a JSON payload onto two Redis pub/sub channels per event,
 * `pipeline:post:<id>` and `pipeline:global`, and the SSE endpoints in that
 * module forwarded whatever arrived on the channel a browser had asked for.
 * The payload shape is the contract `web/src/hooks/use-sse.ts` reads, so it is
 * reproduced here byte for byte: an `event` name, a `post_id`, and whatever
 * else the call site passed, flattened into the same object.
 *
 * Two things about the transport are different, both deliberate.
 *
 * **One topic, not one per post.** `RedisStreamsPubSub` maps a topic to a
 * retained Redis stream, where Python's `PUBLISH` retained nothing. A stream
 * per post would be created on the first event of every run and, with
 * `streamIdleTtlMs` disabled, would still be there long after the post was
 * deleted. A single topic is trimmed by the transport's own `MAXLEN ~ 10000`
 * and gives one ordered sequence, which is also what a reconnecting browser
 * needs to replay without a gap. Subscribers filter on `post_id`, which is the
 * work the per-post channel used to do.
 *
 * **This exists at all because Mastra's own step events cannot cross the
 * process boundary.** The evented engine publishes its per-run watch events on
 * `workflow.events.v2.<runId>`, which `isRunLocalTopic()` in `@mastra/core`
 * matches, and the `mastra.pubsub` proxy publishes matching topics with
 * `{ localOnly: true }`. `RedisStreamsPubSub.publish` short-circuits that flag
 * to an in-process delivery and never writes to Redis, so the `web` service
 * cannot see the step events of a run executing inside `worker`. Relaying them
 * was the cheaper design and it is not available; an explicit publish from the
 * step is.
 */
import type { PubSub } from "@mastra/core/events"

/**
 * The single retained stream every pipeline event lands on.
 *
 * Named for what it carries rather than for a run or a post, because both
 * Python channels collapse into it: the global feed is this topic unfiltered,
 * and a post's feed is this topic filtered on `post_id`.
 */
export const TOPIC_PIPELINE_EVENTS = "pipeline-events"

/**
 * The wire shape `use-sse.ts` parses, which is exactly what Python's
 * `publish_event()` serialised: the event name, the post it concerns, and the
 * call site's own fields at the same level rather than nested under a key.
 */
export interface PipelineEventPayload {
  event: string
  post_id: string
  [key: string]: unknown
}

/**
 * Publish one pipeline event.
 *
 * The `Event` envelope Mastra requires carries `runId`, and the post id goes
 * there rather than the workflow run id: this bus is keyed by post, because
 * that is what a browser subscribes to and what Python's channel name held.
 * The workflow run id is not a useful correlation key for a dashboard that
 * shows a post's history across reruns, and nothing here reads the envelope's
 * `runId` back. The payload is carried in `data`, so a subscriber forwards
 * `event.data` to the browser untouched.
 */
export async function publishPipelineEvent(
  pubsub: PubSub,
  postId: string,
  event: string,
  data: Record<string, unknown> = {},
): Promise<void> {
  const payload: PipelineEventPayload = { event, post_id: postId, ...data }
  await pubsub.publish(TOPIC_PIPELINE_EVENTS, {
    type: event,
    runId: postId,
    data: payload,
  })
}
