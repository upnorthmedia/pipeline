/**
 * Port of `POST /api/queue/pause-all` in `api/src/api/queue.py`, with the
 * selection narrowed to the run states the button claims to act on.
 *
 * The value means what it means on the per-post endpoint, which since ledger
 * item P2.115 is a control signal every stage step reads before it spends
 * anything: each run stops in front of its next stage rather than carrying on
 * to the end. The stage in flight still finishes, and the stage the post was on
 * is overwritten rather than remembered, which is why `resume-all` has to
 * recover the next stage from `stage_status`.
 *
 * Two guards, and they are not the same guard:
 *
 * - The column guard is Python's `["pending", *STAGES]`. It bounds the write to
 *   rows a run actually placed somewhere, so a null or unrecognised
 *   `current_stage` is left alone by a bulk control the way it always was.
 * - The state guard is `PAUSABLE_RUN_STATES`, read through `deriveRunState()`,
 *   the same function the badge column and `GET /api/queue` use. The column
 *   alone cannot tell a run in flight from one parked at a review gate or one
 *   that died at a stage: all three sit on a stage name. Pausing the second
 *   overwrote the only column saying a person was being waited on and let the
 *   next `resume-all` run that stage without an approval, since the
 *   single-stage form skips the gate; pausing the third overwrote the only
 *   column saying the run was dead.
 *
 * Deriving in TypeScript rather than in SQL costs a two-column read of every
 * owned post, the same trade `GET /api/queue` documents and for the same
 * reason: one vocabulary across the count, the badge and the button beats a
 * second copy of the precedence rules living in a `case` expression.
 */
import { and, eq, inArray } from "drizzle-orm"

import { getDb, posts, websiteProfiles } from "@/db"
import type { PostStage, StageStatusMap } from "@/lib/api"
import { getRequestUser, unauthorized } from "@/lib/request-auth"
import { withServerError } from "@/lib/route-error"
import { deriveRunState, PAUSABLE_RUN_STATES } from "@/lib/run-state"
import { announceRunPaused } from "@/mastra/announce-pause"
import { CURRENT_STAGE_PAUSED, STAGES } from "@/mastra/state"

/** Python's `["pending", *STAGES]`. */
const PAUSABLE: string[] = ["pending", ...STAGES]

async function postHandler(request: Request): Promise<Response> {
  const user = await getRequestUser(request)
  if (!user) return unauthorized()

  const db = getDb()

  // The `SELECT ... JOIN website_profiles WHERE user_id` Python ran, followed
  // by the per-row write it committed once. Drizzle's `update()` takes no
  // join, so the join stays on the read and the write matches by id.
  const rows = await db
    .select({ id: posts.id, stage: posts.currentStage, stageStatus: posts.stageStatus })
    .from(posts)
    .innerJoin(websiteProfiles, eq(posts.profileId, websiteProfiles.id))
    .where(and(eq(websiteProfiles.userId, user.id), inArray(posts.currentStage, PAUSABLE)))

  const pausable = rows.filter((row) => {
    const state = deriveRunState({
      currentStage: row.stage as PostStage,
      stageStatus: (row.stageStatus ?? {}) as StageStatusMap,
    })
    return PAUSABLE_RUN_STATES.includes(state.kind)
  })

  if (pausable.length > 0) {
    await db
      .update(posts)
      .set({ currentStage: CURRENT_STAGE_PAUSED, updatedAt: new Date() })
      .where(
        inArray(
          posts.id,
          pausable.map((row) => row.id),
        ),
      )
    // One frame per row the write actually moved, after the commit and for the
    // rows that passed both guards only. A reader holding the queue-wide feed
    // open filters it by post id, so a frame for a row this call left alone
    // would make it refetch a post nothing had happened to.
    await announceRunPaused(pausable.map((row) => row.id))
  }

  return Response.json({ status: CURRENT_STAGE_PAUSED, count: pausable.length }, { status: 200 })
}

export const POST = withServerError(postHandler)
