/**
 * Port of `POST /api/queue/dead-letter/{post_id}/retry` in
 * `api/src/api/queue.py:162`.
 *
 * Python removed the post's entries from the Redis list, reset the post to
 * `pending`, popped `_error` out of `stage_logs`, and enqueued
 * `run_pipeline_stage(post_id)` with no stage, which is a full pipeline that
 * honours the review gates. All of that is preserved except the Redis list,
 * which item 5.4d-i did not port: popping `_error` *is* the removal now, since
 * `listDeadLetterEntries` reads that key as the acknowledgement.
 *
 * Two deviations, both closing holes:
 *
 * - **The post is looked up scoped to the caller.** Python used a bare
 *   `session.get(Post, post_id)`, so any authenticated user could reset any
 *   other user's post and start a run that spends the owner's provider
 *   credits. Here another user's post answers 404 the way it does in every
 *   `/api/posts/{post_id}` handler.
 * - **A malformed id answers 422 rather than a database error.** Python passed
 *   the raw string to `session.get()` on a `uuid` column; FastAPI did not parse
 *   it, because the parameter is annotated `str` here rather than `UUID`.
 *
 * The two 404s Python distinguished are kept apart: "Post not found" for a post
 * the caller has none of, "Post not found in dead letter queue" for one that
 * exists but has no unacknowledged failed run.
 */
import { and, eq } from "drizzle-orm"

import { getDb, posts, websiteProfiles } from "@/db"
import { getRequestUser, unauthorized } from "@/lib/request-auth"
import { listDeadLetterEntries } from "@/mastra/dead-letter"
import { retryFailedPost } from "@/mastra/post-state"
import { startPipeline } from "@/mastra/start-pipeline"

import { isUuid, postNotFound, unprocessableUuid } from "../../../../posts/params"

export async function POST(
  request: Request,
  { params }: { params: Promise<{ post_id: string }> },
): Promise<Response> {
  const user = await getRequestUser(request)
  if (!user) return unauthorized()

  const { post_id: postId } = await params
  if (!isUuid(postId)) return unprocessableUuid(postId)

  const owned = await getDb()
    .select({ id: posts.id })
    .from(posts)
    .innerJoin(websiteProfiles, eq(posts.profileId, websiteProfiles.id))
    .where(and(eq(posts.id, postId), eq(websiteProfiles.userId, user.id)))
    .limit(1)
  if (owned.length === 0) return postNotFound()

  const entries = await listDeadLetterEntries(user.id)
  if (!entries.some((entry) => entry.postId === postId)) {
    return Response.json({ detail: "Post not found in dead letter queue" }, { status: 404 })
  }

  // Written before the run starts, not after: the worker reads the post out of
  // the database, so a run started first could read the row while it still
  // says `failed`. Python enqueued after its commit for the same reason.
  await retryFailedPost(postId)
  await startPipeline(postId)

  return Response.json({ status: "retrying", post_id: postId }, { status: 202 })
}
