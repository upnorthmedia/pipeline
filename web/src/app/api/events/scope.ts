/**
 * Who may see an event on the global feed.
 *
 * `global_events()` in `api/src/api/events.py` subscribed every caller to
 * `pipeline:global` and forwarded the channel verbatim, so one tenant's
 * dashboard received every other tenant's stage messages, model names and
 * error text. Phase 5's multi-tenancy rule closes that, and the global
 * endpoint cannot close it the way the per-post one does: there is no single
 * post to resolve before the stream opens, and the feed legitimately spans
 * posts the caller has not created yet, so a snapshot of owned ids taken at
 * connect time would go stale the moment a run starts on a new post.
 *
 * So ownership is resolved per post id, lazily, and remembered for the life of
 * the connection. Two properties fall out of that and both matter:
 *
 * - **One query per distinct post, not per event.** A run publishes tens of
 *   events for the same post; the first one pays for the lookup and the rest
 *   read the memo. Concurrent events for the same unseen post share a single
 *   in-flight query because the promise is cached, not its result.
 * - **A negative answer is remembered too.** Re-querying every event for a post
 *   the caller does not own would make an unowned run more expensive than an
 *   owned one, which is the wrong way round. The cost is that a post whose
 *   profile is reassigned to the caller mid-connection stays invisible until
 *   the browser reconnects, which `useSSE()` does on any transport error and
 *   on every page load.
 *
 * The test is the same inner join `_get_user_post()` used, through
 * `ownedByCaller()`, so the three cases the per-post endpoint answers with a
 * 404 are the three cases this one silently drops: a post that does not exist,
 * a post owned by someone else, and a post whose `profile_id` is null.
 */
import { getDb, posts } from "@/db"
import type { PipelineEventPayload } from "@/mastra/pipeline-events"

import { ownedByCaller } from "../posts/params"
import type { SelectPayload } from "./stream"

/**
 * A `select` function for `pipelineEventStream()` that sends only events about
 * posts `userId` owns, each one carrying the post's `topic`.
 *
 * The topic rides along because this is the only layer that has it. A step
 * publishes a post id and nothing else, and the browser that receives the frame
 * has never loaded the post: `global-notifications.tsx` toasts off this feed
 * from any route, so before item P3.3c-i it named the post by the first eight
 * characters of its uuid. The lookup that answers "may this caller see it" is
 * already reading the row, so naming it costs one more column.
 *
 * The payload is spread first and the column written over it, so a `topic` on
 * the published payload cannot pass itself off as the stored one.
 *
 * The cache is per call, which means per connection: a long-lived dashboard
 * holds one entry per post id it has seen an event for, and the whole map is
 * dropped when the stream ends. A post renamed mid-connection therefore keeps
 * announcing itself under the topic it had when the first event arrived, until
 * the browser reconnects.
 */
export function ownedByUser(userId: string): SelectPayload {
  const resolved = new Map<string, Promise<string | null>>()

  return async (payload): Promise<PipelineEventPayload | null> => {
    const cached = resolved.get(payload.post_id)
    if (cached !== undefined) return withTopic(payload, await cached)

    // A failed lookup must not be remembered as a decision, so the memo is
    // dropped on rejection and the next event for that post tries again. The
    // rejection itself propagates: `pipelineEventStream()` treats a `select`
    // that throws as "do not send".
    const lookup = ownedTopic(payload.post_id, userId).catch((error) => {
      resolved.delete(payload.post_id)
      throw error
    })
    resolved.set(payload.post_id, lookup)
    return withTopic(payload, await lookup)
  }
}

function withTopic(payload: PipelineEventPayload, topic: string | null): PipelineEventPayload | null {
  return topic === null ? null : { ...payload, topic }
}

/** The post's topic when `userId` owns it, `null` when they do not. */
async function ownedTopic(postId: string, userId: string): Promise<string | null> {
  const rows = await getDb()
    .select({ topic: posts.topic })
    .from(posts)
    .where(ownedByCaller(postId, userId))
    .limit(1)
  return rows.length > 0 ? rows[0].topic : null
}
