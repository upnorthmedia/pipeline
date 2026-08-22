/**
 * Port of `POST /api/posts/{post_id}/run` in `api/src/api/posts.py`.
 *
 * Python's order is load-bearing and preserved: the post is resolved against
 * the caller first, so an unknown `stage` on someone else's post is a 404 and
 * not a 400 that would confirm the post exists. Only then is `stage` checked
 * against `STAGES`, and only then is the next stage derived.
 *
 * The row is flipped to `running` before the run is started, so the post detail
 * page's poll never sees a started run still sitting at its old status.
 *
 * The workflow is handed `stage`, not `target_stage`: `run_pipeline_stage`
 * received the raw argument, so a request with no `stage` starts a full
 * pipeline that skips whatever is already complete rather than a single-stage
 * run pinned to the stage this handler happened to name in its response.
 */
import { and, eq } from "drizzle-orm"

import { getDb, posts, websiteProfiles } from "@/db"
import { getRequestUser, unauthorized } from "@/lib/request-auth"
import { startPipeline } from "@/mastra/start-pipeline"
import { STATUS_RUNNING } from "@/mastra/state"
import type { Stage } from "@/mastra/state"

import { isUuid, ownedByCaller, postNotFound, unprocessableUuid } from "../../params"
import { badRequest, isStage, nextStage } from "../../run-control"

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

  // FastAPI declared `stage` as a bare `str | None` query parameter, read
  // through Starlette's `QueryParams`, which keeps the *last* value of a
  // repeated key: `QueryParams("stage=write&stage=edit").get("stage")` is
  // `"edit"`. `URLSearchParams.get()` returns the first, so read them all and
  // take the last. An empty value is falsy in Python, which made `?stage=`
  // behave as if the parameter were absent.
  const raw = new URL(request.url).searchParams.getAll("stage").at(-1) ?? ""
  let stage: Stage | null = null
  if (raw) {
    if (!isStage(raw)) return badRequest(`Invalid stage: ${raw}`)
    stage = raw
  }

  const targetStage = stage ?? nextStage(rows[0].stageStatus)
  if (!targetStage) return badRequest("Pipeline already complete")

  await db
    .update(posts)
    .set({
      currentStage: targetStage,
      stageStatus: { ...(rows[0].stageStatus ?? {}), [targetStage]: STATUS_RUNNING },
      updatedAt: new Date(),
    })
    .where(ownedByCaller(id, user.id))

  await startPipeline(id, stage ? [stage] : undefined)

  // `str(post_id)` in Python was the *parsed* UUID, so it came back lowercase
  // however the client cased it. Echo the stored id, which is that same form.
  return Response.json(
    { status: "queued", stage: targetStage, post_id: rows[0].id },
    { status: 202 },
  )
}
