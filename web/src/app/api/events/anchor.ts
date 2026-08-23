/**
 * The value that goes in an SSE frame's `id:` field, and the position it names
 * in the retained Redis stream.
 *
 * A browser that reconnects mid-run has to tell the server where it stopped,
 * and `EventSource` only ever offers back the last `id:` it saw. So the id has
 * to be enough, on its own, to find that position again in the stream
 * `publishPipelineEvent()` writes to. Two facts about the transport decide the
 * format:
 *
 * - **The Redis entry id is not visible to a subscriber.** `#deliverMessage()`
 *   in `@mastra/redis-streams` reads `entry.id` and passes only the decoded
 *   payload to the callback, so the `1755859200000-0` that Redis assigned is
 *   unreachable from here. What the payload does carry is `id`, a `randomUUID()`
 *   the transport stamps in `publish()`, which is unique and matches exactly one
 *   entry.
 * - **`SubscribeOptions.startFrom` is `'earliest' | 'latest'` and nothing else**
 *   (`@mastra/core/dist/events/types.d.ts`), so a replay cannot ask Redis for a
 *   position: it re-reads the retained stream from the start and drops what the
 *   client already has. That is ledger item 5.5e-ii's problem, but it is why the
 *   uuid alone is not sufficient. `maxStreamLength` is 10000, so the anchor
 *   event can have been trimmed away, and a replay that skips until it sees a
 *   uuid that no longer exists skips forever. `createdAt` bounds that: any event
 *   stamped later than the anchor was published after it, trimmed anchor or not.
 *
 * Hence `<createdAt milliseconds>-<transport uuid>`: the uuid is the exact
 * match, the timestamp is the fallback ordering when the exact match is gone.
 * The separator is `-`, which also occurs inside the uuid, so a parser must
 * split on the first one rather than the last.
 */
import type { Event } from "@mastra/core/events"

/**
 * The anchor for one delivered event, or `undefined` for an event the transport
 * did not stamp.
 *
 * Every event published through `RedisStreamsPubSub.publish()` has both fields,
 * so `undefined` means something else wrote to the topic. Such a frame goes out
 * without an `id:` rather than with a made-up one: an id that does not name a
 * real position would send a later replay to the wrong place, and omitting the
 * field leaves `Last-Event-ID` on the previous frame's value, which is a real
 * position.
 */
export function eventAnchor(event: Event): string | undefined {
  if (typeof event.id !== "string" || event.id.length === 0) return undefined
  const createdAt = event.createdAt instanceof Date ? event.createdAt : new Date(event.createdAt)
  const millis = createdAt.getTime()
  if (!Number.isFinite(millis)) return undefined
  return `${millis}-${event.id}`
}
