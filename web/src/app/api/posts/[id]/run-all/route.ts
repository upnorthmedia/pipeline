/**
 * Port of `POST /api/posts/{post_id}/run-all` in `api/src/api/posts.py`.
 *
 * "Run to completion" is expressed entirely through `stage_settings`: every
 * stage `stage_status` does not already call complete is forced to `"auto"`,
 * which is the one value the gate branch of `_run_pipeline()` does not park on.
 * A stage already marked complete keeps whatever mode it had, so re-running the
 * post later still stops for review where the profile asked it to.
 *
 * The run itself is a plain full pipeline with no stage selection, so it skips
 * the completed stages the settings pass just left alone.
 */
import { and, eq } from "drizzle-orm"

import { getDb, posts, websiteProfiles } from "@/db"
import type { StageSettingsJson } from "@/db"
import { getRequestUser, unauthorized } from "@/lib/request-auth"
import { startPipeline } from "@/mastra/start-pipeline"
import { STAGES, STATUS_COMPLETE } from "@/mastra/state"

import { isUuid, ownedByCaller, postNotFound, unprocessableUuid } from "../../params"

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
    .select({
      id: posts.id,
      stageStatus: posts.stageStatus,
      stageSettings: posts.stageSettings,
    })
    .from(posts)
    .innerJoin(websiteProfiles, eq(posts.profileId, websiteProfiles.id))
    .where(and(eq(posts.id, id), eq(websiteProfiles.userId, user.id)))
    .limit(1)

  if (rows.length === 0) return postNotFound()

  const stageStatus = rows[0].stageStatus ?? {}
  const stageSettings: StageSettingsJson = { ...(rows[0].stageSettings ?? {}) }
  for (const stage of STAGES) {
    if (stageStatus[stage] !== STATUS_COMPLETE) stageSettings[stage] = "auto"
  }

  await db
    .update(posts)
    .set({ stageSettings, updatedAt: new Date() })
    .where(ownedByCaller(id, user.id))

  await startPipeline(rows[0].id)

  return Response.json({ status: "queued", mode: "run-all", post_id: rows[0].id }, { status: 202 })
}
