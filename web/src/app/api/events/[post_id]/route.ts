/**
 * Port of `GET /api/events/{post_id}` in `api/src/api/events.py`.
 *
 * Python subscribed the request to `pipeline:post:<post_id>` and forwarded
 * everything on it. There is now one topic for every pipeline event and the
 * post id is a field on the payload, so selecting a post's feed is a filter
 * rather than a channel name (ledger 5.5a).
 *
 * **Deviation, deliberate: this endpoint is authenticated and scoped, and the
 * Python one was not.** `post_events()` took `post_id: str` with no session
 * dependency and no ownership check, so any caller who knew or guessed a post
 * id received that post's live feed, and the feed carries stage messages and
 * model names. Every other handler in Phase 5 scopes its rows through
 * `website_profiles.user_id`, and an endpoint that streams another tenant's
 * pipeline is a defect to close rather than a behaviour to transcribe.
 * `EventSource` cannot set headers but does send same-origin cookies, so the
 * BetterAuth session `use-sse.ts` already carries is what authenticates it.
 *
 * The consequence of adding the check is the 422: Python typed the parameter
 * `str`, so `/api/events/not-a-uuid` opened a stream on a channel nothing ever
 * published to. Resolving ownership means comparing against a uuid column, so a
 * malformed id is rejected the same way every other `{post_id}` handler rejects
 * it instead of reaching Postgres.
 */
import { and, eq, sql } from "drizzle-orm"

import { getDb, posts, websiteProfiles } from "@/db"
import { getRequestUser, unauthorized } from "@/lib/request-auth"

import { isUuid, postNotFound, unprocessableUuid } from "../../posts/params"
import { pipelineEventStream } from "../stream"

export async function GET(
  request: Request,
  context: { params: Promise<{ post_id: string }> },
): Promise<Response> {
  const user = await getRequestUser(request)
  if (!user) return unauthorized()

  const { post_id: postId } = await context.params
  if (!isUuid(postId)) return unprocessableUuid(postId)

  // The same inner join `_get_user_post()` used, so another user's post and a
  // post whose `profile_id` is null are both the 404 a missing post gets.
  const owned = await getDb()
    .select({ one: sql<number>`1` })
    .from(posts)
    .innerJoin(websiteProfiles, eq(posts.profileId, websiteProfiles.id))
    .where(and(eq(posts.id, postId), eq(websiteProfiles.userId, user.id)))
    .limit(1)
  if (owned.length === 0) return postNotFound()

  return pipelineEventStream(request, (payload) => payload.post_id === postId)
}
