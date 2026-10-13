/**
 * Port of `POST /api/queue/resume-all` in `api/src/api/queue.py`.
 *
 * Pausing overwrote `current_stage`, so resuming cannot simply put it back:
 * the next stage is recovered per post from `stage_status`, the first stage it
 * does not call complete. That is the same scan `_next_stage()` does, so the
 * helper the per-post run endpoints already share is reused here.
 *
 * Two details of the Python loop are load-bearing and preserved:
 *
 * - a post whose six stages are all complete has no next stage, so it is
 *   written to `current_stage = "complete"`. It still counts towards the
 *   response's `count`, which is the number of posts that were paused, not
 *   the number of runs started.
 * - the enqueue names the stage (`enqueue_job("run_pipeline_stage", id,
 *   next_stage)`), so it is the single-stage form: `run_pipeline_stage` turned
 *   a named stage into `stages=[stage]` and ran it with no gate checks.
 *   "Resume all" therefore advances each post by exactly one stage and does
 *   not stop for review on that stage, which is narrower than the name
 *   suggests but is what the endpoint has always done.
 */
import { and, eq } from "drizzle-orm"

import { getDb, posts, websiteProfiles } from "@/db"
import { getRequestUser, unauthorized } from "@/lib/request-auth"
import { withServerError } from "@/lib/route-error"
import { startPipeline } from "@/mastra/start-pipeline"
import type { Stage } from "@/mastra/state"

import { nextStage } from "../../posts/run-control"

async function postHandler(request: Request): Promise<Response> {
  const user = await getRequestUser(request)
  if (!user) return unauthorized()

  const db = getDb()
  const rows = await db
    .select({ id: posts.id, stageStatus: posts.stageStatus })
    .from(posts)
    .innerJoin(websiteProfiles, eq(posts.profileId, websiteProfiles.id))
    .where(and(eq(websiteProfiles.userId, user.id), eq(posts.currentStage, "paused")))

  // The stage each post resumes at, or `null` for a post that has no stage
  // left. Both shapes are started; only the first names a stage.
  const resumed: { id: string; stage: Stage | null }[] = []

  // Python committed the whole batch once, after the loop, so either every
  // post moves off "paused" or none does. A transaction keeps that.
  await db.transaction(async (tx) => {
    for (const row of rows) {
      const stage = nextStage(row.stageStatus)
      resumed.push({ id: row.id, stage })
      await tx
        .update(posts)
        .set({ currentStage: stage ?? "complete", updatedAt: new Date() })
        .where(eq(posts.id, row.id))
    }
  })

  // Python enqueued inside the loop, before the commit, so a worker could read
  // a post whose new `current_stage` was not visible yet. Starting the runs
  // after the transaction closes that window. Nothing observable changes: the
  // workflow derives the stages it runs from `stage_status`, not from
  // `current_stage`.
  // A post with no stage left is a pause that landed after `ready` rather
  // than in front of a stage (`isPausedBeforeFinish()`). Python started
  // nothing for it, which left the row a full run leaves minus everything
  // `pipeline-complete` does: no `completed_at`, no auto-publish and no
  // `pipeline_complete` frame. Resuming a run has to reach its finish, so it
  // is started in the full form, the one `POST /api/posts/{id}/run-all` uses
  // for the same row: no stage selection, so the six complete stages are
  // skipped and only the finish runs. Ledger item P5.5.
  for (const { id, stage } of resumed) {
    await startPipeline(id, stage ? [stage] : undefined)
  }

  return Response.json({ status: "resumed", count: rows.length }, { status: 200 })
}

export const POST = withServerError(postHandler)
