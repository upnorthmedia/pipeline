/**
 * Port of `GET /api/posts` in `api/src/api/posts.py`.
 *
 * The Python query joined `posts` to `website_profiles` and filtered on
 * `website_profiles.user_id`, so a post with a null `profile_id` never
 * appeared in the list. That exclusion is preserved: it follows from the
 * `user_id` predicate rather than from the join strategy, since an unowned row
 * cannot match any user, but the join is kept inner to mirror the original.
 */
import { and, asc, desc, eq, ilike, or, type SQL } from "drizzle-orm"

import { getDb, posts, websiteProfiles } from "@/db"
import { getRequestUser, unauthorized } from "@/lib/request-auth"
import { logger } from "@/mastra"
import { startPipeline } from "@/mastra/start-pipeline"
import { STAGES, STATUS_RUNNING } from "@/mastra/state"

import { applyProfilePrefill } from "./prefill"
import { parseListPostsQuery } from "./query"
import { serializePost, type PostResponse } from "./serialize"
import {
  invalidJsonBody,
  postCreateSchema,
  toColumns,
  unprocessableBody,
  type PostWriteInput,
} from "./validation"

export async function GET(request: Request): Promise<Response> {
  const user = await getRequestUser(request)
  if (!user) return unauthorized()

  const query = parseListPostsQuery(new URL(request.url))
  if (query instanceof Response) return query

  const conditions: SQL[] = [eq(websiteProfiles.userId, user.id)]

  // `status or stage`: either name filters `current_stage`, `status` first.
  const stageFilter = query.status || query.stage
  if (stageFilter) conditions.push(eq(posts.currentStage, stageFilter))
  if (query.profileId) conditions.push(eq(posts.profileId, query.profileId))
  if (query.q) {
    const pattern = `%${query.q}%`
    conditions.push(or(ilike(posts.topic, pattern), ilike(posts.slug, pattern)) as SQL)
  }

  const rows = await getDb()
    .select({ post: posts })
    .from(posts)
    .innerJoin(websiteProfiles, eq(posts.profileId, websiteProfiles.id))
    .where(and(...conditions))
    .orderBy(query.order === "desc" ? desc(query.sort) : asc(query.sort))
    .offset((query.page - 1) * query.perPage)
    .limit(query.perPage)

  const body: PostResponse[] = rows.map((row) => serializePost(row.post))
  return Response.json(body)
}

/**
 * Port of `POST /api/posts`.
 *
 * The row is written with the full `model_dump()` of `PostCreate` folded
 * through `prefill.ts`, so every pydantic default is materialised rather than
 * left to the column default. The two disagree for `output_format` ("markdown"
 * against the column's "both") and for `stage_settings` (six "auto" stages
 * against the column's five "review" ones), and the pydantic value is the one
 * the Python stack wrote.
 *
 * A `profile_id` the caller does not own is a 404, which is what keeps another
 * account's settings from being read through the prefill. A body with no
 * `profile_id` is accepted, as Python accepted it, even though the resulting
 * row is invisible to every read handler: they all join through
 * `website_profiles` to reach `user_id`.
 *
 * `current_stage` and `stage_status` are stamped after the prefill, so a body
 * or profile cannot set them.
 *
 * The pipeline is started on success, replacing
 * `enqueue_job("run_pipeline_stage", post.id)`. Python let a queue failure
 * escape as a 500 here, which would report a create that in fact succeeded, so
 * the failure is logged and the 201 returned instead. That is the same
 * treatment `POST /api/profiles` already gives its crawl enqueue, where Python
 * itself swallowed the error.
 */
export async function POST(request: Request): Promise<Response> {
  const user = await getRequestUser(request)
  if (!user) return unauthorized()

  let body: unknown
  try {
    body = await request.json()
  } catch {
    return invalidJsonBody()
  }

  const parsed = postCreateSchema.safeParse(body)
  if (!parsed.success) return unprocessableBody(parsed.error.issues, body)

  let values: PostWriteInput = parsed.data
  if (values.profile_id) {
    const [profile] = await getDb()
      .select()
      .from(websiteProfiles)
      .where(and(eq(websiteProfiles.id, values.profile_id), eq(websiteProfiles.userId, user.id)))
      .limit(1)
    if (!profile) return Response.json({ detail: "Profile not found" }, { status: 404 })
    values = applyProfilePrefill(values, profile)
  }

  const [row] = await getDb()
    .insert(posts)
    .values({
      ...toColumns(values),
      currentStage: STAGES[0],
      stageStatus: { [STAGES[0]]: STATUS_RUNNING },
    })
    .returning()

  try {
    await startPipeline(row.id)
  } catch (error) {
    logger.warn("Post created but the pipeline could not be started", {
      postId: row.id,
      error: error instanceof Error ? error.message : String(error),
    })
  }

  return Response.json(serializePost(row), { status: 201 })
}
