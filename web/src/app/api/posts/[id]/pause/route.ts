/**
 * Port of `POST /api/posts/{post_id}/pause` in `api/src/api/posts.py`.
 *
 * One write, `current_stage = "paused"`, exactly as Python made it. What
 * changed under ledger item P2.115 is what that value now means. In Python it
 * was a label: no worker read it, so the stage in flight finished, the next one
 * started and the run went all the way to `complete` with the dashboard's badge
 * saying `Paused`. Every stage step now reads it before it spends anything
 * (`pauseGate()` in `src/mastra/steps/stage-io.ts`) and ends the run rather
 * than running, and every write a run makes to `current_stage` leaves the value
 * alone (`currentStageUnlessPaused()` in `src/mastra/post-state.ts`), which is
 * what stops the finishing stage from erasing it.
 *
 * It stays a stage-boundary signal rather than an interrupt: the stage that was
 * executing when the button was pressed runs to completion and commits its
 * column, because killing a provider call mid-flight pays for the tokens and
 * throws the answer away. `deriveRunState()` says so on screen, reading
 * "Pausing" and naming that stage until it lands.
 *
 * The stage the post was on is still overwritten rather than remembered, which
 * is why `POST /api/queue/resume-all` recovers it from `stage_status`.
 *
 * It is also the one pipeline-control endpoint that enqueues nothing.
 */
import { getDb, posts } from "@/db"
import { CURRENT_STAGE_PAUSED } from "@/mastra/state"
import { getRequestUser, unauthorized } from "@/lib/request-auth"
import { withServerError } from "@/lib/route-error"

import { isUuid, ownedByCaller, postNotFound, unprocessableUuid } from "../../params"

async function postHandler(
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
    .set({ currentStage: CURRENT_STAGE_PAUSED, updatedAt: new Date() })
    .where(ownedByCaller(id, user.id))
    .returning({ id: posts.id })

  if (updated.length === 0) return postNotFound()

  return Response.json({ status: CURRENT_STAGE_PAUSED, post_id: updated[0].id }, { status: 200 })
}

export const POST = withServerError(postHandler)
