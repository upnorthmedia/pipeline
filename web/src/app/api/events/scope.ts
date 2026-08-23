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
 * The predicate is the same inner join `_get_user_post()` used, through
 * `ownedByCaller()`, so the three cases the per-post endpoint answers with a
 * 404 are the three cases this one silently drops: a post that does not exist,
 * a post owned by someone else, and a post whose `profile_id` is null.
 */
import { sql } from "drizzle-orm"

import { getDb, posts } from "@/db"

import { ownedByCaller } from "../posts/params"

/**
 * A `matches` predicate for `pipelineEventStream()` that accepts only events
 * about posts `userId` owns.
 *
 * The cache is per call, which means per connection: a long-lived dashboard
 * holds one entry per post id it has seen an event for, and the whole map is
 * dropped when the stream ends.
 */
export function ownedByUser(userId: string): (payload: { post_id: string }) => Promise<boolean> {
  const resolved = new Map<string, Promise<boolean>>()

  return (payload) => {
    const cached = resolved.get(payload.post_id)
    if (cached !== undefined) return cached

    // A failed lookup must not be remembered as a decision, so the memo is
    // dropped on rejection and the next event for that post tries again. The
    // rejection itself propagates: `pipelineEventStream()` treats a predicate
    // that throws as "do not send".
    const lookup = isOwned(payload.post_id, userId).catch((error) => {
      resolved.delete(payload.post_id)
      throw error
    })
    resolved.set(payload.post_id, lookup)
    return lookup
  }
}

async function isOwned(postId: string, userId: string): Promise<boolean> {
  const rows = await getDb()
    .select({ one: sql<number>`1` })
    .from(posts)
    .where(ownedByCaller(postId, userId))
    .limit(1)
  return rows.length > 0
}
