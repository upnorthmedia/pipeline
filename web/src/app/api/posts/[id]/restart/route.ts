/**
 * Port of `POST /api/posts/{post_id}/restart` in `api/src/api/posts.py`.
 *
 * The blunt instrument next to `/rerun`: every stage back to `"pending"`,
 * every content column cleared, `stage_logs` emptied, then a full pipeline
 * from `research`.
 *
 * Three differences from `/rerun` are Python's, not incidental. `stage_status`
 * is *replaced* by a fresh six-key map rather than updated, so any other key it
 * held is dropped. `final_html_content` is cleared even though no stage owns it
 * (it is not in `STAGE_CONTENT_MAP`), which is why the columns are written out
 * here instead of walked. And `stage_logs` is set to `{}`, not null, matching
 * the column's own default.
 *
 * `stage_settings` is deliberately untouched: a restart replays the post's
 * configured review gates rather than forcing the run through them.
 */
import { and, eq } from "drizzle-orm"

import { getDb, posts, websiteProfiles } from "@/db"
import type { StageStatusJson } from "@/db"
import { getRequestUser, unauthorized } from "@/lib/request-auth"
import { startPipeline } from "@/mastra/start-pipeline"
import { STAGES, STATUS_PENDING } from "@/mastra/state"

import { isUuid, ownedByCaller, postNotFound, unprocessableUuid } from "../../params"

const ALL_PENDING: StageStatusJson = Object.fromEntries(
  STAGES.map((stage) => [stage, STATUS_PENDING]),
)

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
    .select({ id: posts.id })
    .from(posts)
    .innerJoin(websiteProfiles, eq(posts.profileId, websiteProfiles.id))
    .where(and(eq(posts.id, id), eq(websiteProfiles.userId, user.id)))
    .limit(1)

  if (rows.length === 0) return postNotFound()

  await db
    .update(posts)
    .set({
      stageStatus: { ...ALL_PENDING },
      currentStage: "pending",
      completedAt: null,
      researchContent: null,
      outlineContent: null,
      draftContent: null,
      finalMdContent: null,
      finalHtmlContent: null,
      imageManifest: null,
      readyContent: null,
      stageLogs: {},
      updatedAt: new Date(),
    })
    .where(ownedByCaller(id, user.id))

  await startPipeline(rows[0].id)

  return Response.json({ status: "queued", mode: "restart", post_id: rows[0].id }, { status: 202 })
}
