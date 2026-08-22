/**
 * Port of `POST /api/posts/{post_id}/pause` in `api/src/api/posts.py`.
 *
 * Pausing is a label, not a control signal: Python wrote `"paused"` into
 * `current_stage` and nothing else. No worker reads that value, so a stage
 * already executing runs to completion and the next stage still starts; what
 * the flag actually does is stop the post appearing as in-flight in the posts
 * list and the queue counts, and give `POST /api/queue/resume-all` something
 * to find. The port keeps that exactly, including the loss of the stage the
 * post was on: `current_stage` is overwritten, not remembered.
 *
 * It is also the one pipeline-control endpoint that enqueues nothing.
 */
import { getDb, posts } from "@/db"
import { getRequestUser, unauthorized } from "@/lib/request-auth"

import { isUuid, ownedByCaller, postNotFound, unprocessableUuid } from "../../params"

export async function POST(
  request: Request,
  { params }: { params: Promise<{ id: string }> },
): Promise<Response> {
  const user = await getRequestUser(request)
  if (!user) return unauthorized()

  const { id } = await params
  if (!isUuid(id)) return unprocessableUuid(id)

  // `_get_user_post()` plus the single field write, collapsed into one
  // statement: the ownership predicate is the same correlated `EXISTS`, and no
  // matching row is the same 404 the lookup raised.
  const db = getDb()
  const updated = await db
    .update(posts)
    .set({ currentStage: "paused", updatedAt: new Date() })
    .where(ownedByCaller(id, user.id))
    .returning({ id: posts.id })

  if (updated.length === 0) return postNotFound()

  return Response.json({ status: "paused", post_id: updated[0].id }, { status: 200 })
}
