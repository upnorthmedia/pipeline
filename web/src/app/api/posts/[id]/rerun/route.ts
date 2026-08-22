/**
 * Port of `POST /api/posts/{post_id}/rerun` in `api/src/api/posts.py`.
 *
 * "Re-run the stuck stage": find the first stage `stage_status` does not call
 * complete, reset it and everything downstream to `"pending"`, clear those
 * stages' content columns so the detail page cannot show stale output from a
 * stage that is about to run again, then start a plain full pipeline. The
 * completed stages upstream keep their status, so the run skips them.
 *
 * Two details of Python's loop are load-bearing and preserved. It rewrites
 * only `STAGES[rerun_idx:]`, so any key `stage_status` holds outside that
 * slice survives, including keys that are not stage names at all. And when
 * every stage is already complete there is no first non-complete stage, so it
 * falls back to the *last* stage: "rerun" on a finished post re-runs `ready`
 * alone rather than doing nothing.
 */
import { and, eq } from "drizzle-orm"

import { getDb, posts, websiteProfiles } from "@/db"
import type { StageStatusJson } from "@/db"
import { getRequestUser, unauthorized } from "@/lib/request-auth"
import { startPipeline } from "@/mastra/start-pipeline"
import { STAGES, STATUS_COMPLETE, STATUS_PENDING } from "@/mastra/state"
import type { Stage } from "@/mastra/state"

import { isUuid, ownedByCaller, postNotFound, unprocessableUuid } from "../../params"
import { STAGE_CONTENT_COLUMN } from "../../run-control"

export async function POST(
  request: Request,
  { params }: { params: Promise<{ id: string }> },
): Promise<Response> {
  const user = await getRequestUser(request)
  if (!user) return unauthorized()

  const { id } = await params
  if (!isUuid(id)) return unprocessableUuid(id)

  const db = getDb()
  const rows = await db
    .select({ id: posts.id, stageStatus: posts.stageStatus })
    .from(posts)
    .innerJoin(websiteProfiles, eq(posts.profileId, websiteProfiles.id))
    .where(and(eq(posts.id, id), eq(websiteProfiles.userId, user.id)))
    .limit(1)

  if (rows.length === 0) return postNotFound()

  const stageStatus: StageStatusJson = { ...(rows[0].stageStatus ?? {}) }
  const rerunFrom = STAGES.find((stage) => stageStatus[stage] !== STATUS_COMPLETE) ?? STAGES.at(-1)!

  const cleared: Partial<Record<(typeof STAGE_CONTENT_COLUMN)[Stage], null>> = {}
  for (const stage of STAGES.slice(STAGES.indexOf(rerunFrom))) {
    stageStatus[stage] = STATUS_PENDING
    cleared[STAGE_CONTENT_COLUMN[stage]] = null
  }

  await db
    .update(posts)
    .set({
      ...cleared,
      stageStatus,
      // The literal `"pending"` here is a value from `stage_status`'s
      // vocabulary, not a stage name; the two columns happen to spell it the
      // same way, which is why there is no shared constant for it.
      currentStage: "pending",
      completedAt: null,
      updatedAt: new Date(),
    })
    .where(ownedByCaller(id, user.id))

  await startPipeline(rows[0].id)

  return Response.json(
    { status: "queued", mode: "rerun", rerun_from: rerunFrom, post_id: rows[0].id },
    { status: 202 },
  )
}
