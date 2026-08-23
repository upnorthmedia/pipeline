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
  const millis = eventMillis(event)
  if (millis === undefined) return undefined
  return `${millis}-${event.id}`
}

/** Milliseconds since the epoch for a delivered event, or `undefined`. */
function eventMillis(event: Event): number | undefined {
  const createdAt = event.createdAt instanceof Date ? event.createdAt : new Date(event.createdAt)
  const millis = createdAt.getTime()
  return Number.isFinite(millis) ? millis : undefined
}

/** The two halves of an anchor a client sent back, already split. */
export interface ReplayAnchor {
  /** `createdAt` in milliseconds: the ordering the replay falls back on. */
  millis: number
  /** The transport uuid: the one entry this anchor names exactly. */
  id: string
}

/** The header `EventSource` sets on its own reconnect. */
export const LAST_EVENT_ID_HEADER = "last-event-id"

/**
 * The query parameter `use-sse.ts` will carry the anchor in.
 *
 * `EventSource` sets `Last-Event-ID` only when the browser reconnects the same
 * object, and `useSSE()` never lets that happen: its `onerror` closes the
 * `EventSource` and a timer constructs a new one, whose `Last-Event-ID` buffer
 * starts empty. So the header alone would replay nothing for this client, and
 * the parameter is the path the dashboard actually takes (ledger 5.5e-iii).
 */
export const LAST_EVENT_ID_PARAM = "last_event_id"

/**
 * Splits an anchor a client sent back, or `undefined` when it names no
 * position.
 *
 * The split is on the **first** separator: `-` occurs four more times inside
 * the uuid, so splitting on the last would hand back a truncated id that
 * matches nothing.
 *
 * A value that does not parse is not an error, it is "no anchor". An
 * unparseable id cannot be turned into a position, and the alternative to
 * ignoring it is either refusing the connection or replaying the whole retained
 * stream, both of which are worse for a client whose only mistake is an id this
 * server did not write.
 */
export function parseAnchor(value: string | null | undefined): ReplayAnchor | undefined {
  if (typeof value !== "string") return undefined
  const trimmed = value.trim()
  const separator = trimmed.indexOf("-")
  if (separator <= 0) return undefined
  const millis = Number(trimmed.slice(0, separator))
  const id = trimmed.slice(separator + 1)
  if (!Number.isInteger(millis) || id.length === 0) return undefined
  return { millis, id }
}

/**
 * The anchor a request is asking to resume from, header first.
 *
 * The header wins when both are present and both parse, because they age
 * differently: the query parameter is fixed when the URL is built, and the
 * header is whatever the last frame that `EventSource` object received carried.
 * A browser that reconnects an existing object therefore sends a stale
 * parameter and a current header, and resuming from the older of the two is a
 * duplicate storm. A header that does not parse falls through to the
 * parameter rather than cancelling the replay.
 */
export function requestAnchor(request: Request): ReplayAnchor | undefined {
  const fromHeader = parseAnchor(request.headers.get(LAST_EVENT_ID_HEADER))
  if (fromHeader !== undefined) return fromHeader
  return parseAnchor(new URL(request.url).searchParams.get(LAST_EVENT_ID_PARAM))
}

/** Where a delivered event sits relative to an anchor. */
export type ReplayPosition =
  /** The client already has it. */
  | "before"
  /** It **is** the anchor: the last frame the client received. */
  | "at"
  /** Published after the anchor, so the client is missing it. */
  | "after"

/**
 * Places one delivered event against an anchor.
 *
 * The uuid is tried first and is exact. The timestamp is only consulted when
 * the uuid does not match, and is compared **strictly**: an event stamped in
 * the same millisecond as the anchor is treated as "before". That is the right
 * way round in both cases that can produce it.
 *
 * - The anchor is still on the stream. Then the exact match settles it when the
 *   replay reaches it, and anything sharing its millisecond that was published
 *   later arrives after that point and is sent.
 * - The anchor has been trimmed (`maxStreamLength` is 10000). Then the client
 *   already has an unavoidable gap: entries are trimmed oldest first, so
 *   everything between the anchor and the oldest retained entry is gone with
 *   it. The timestamp's job there is to stop the replay skipping forever, not
 *   to make a lossy stream lossless.
 *
 * An event the transport did not stamp with a usable `createdAt` cannot be
 * placed at all, and is reported as "after": a replay that stalls is worse than
 * one that repeats itself, and such an event never carried an `id:` so it can
 * never be the anchor.
 */
export function anchorPosition(anchor: ReplayAnchor, event: Event): ReplayPosition {
  if (event.id === anchor.id) return "at"
  const millis = eventMillis(event)
  if (millis === undefined) return "after"
  return millis > anchor.millis ? "after" : "before"
}
