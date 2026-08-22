/**
 * Port of `POST /api/posts/batch` in `api/src/api/posts.py`.
 *
 * The body is a list of `PostCreate`, each folded through the same profile
 * prefill `POST /api/posts` uses, written in one transaction and answered with
 * the full list of created posts. All-or-nothing is load-bearing: Python called
 * `session.commit()` once after adding every post, so an item that violates the
 * `uq_posts_profile_slug` constraint rolls the whole batch back rather than
 * leaving a partial batch behind. A single multi-row INSERT keeps that, and
 * Postgres returns its RETURNING rows in the order of the VALUES list, which is
 * the order the dashboard's batch page submitted.
 *
 * Two differences from `create_post`, both deliberate on the Python side and
 * preserved:
 *
 *  - `current_stage` and `stage_status` are not stamped. `create_post` set them
 *    to "research" and `{research: "running"}` before writing; `batch` writes
 *    neither, so the column defaults apply and every batch post starts at
 *    "pending" with an empty `stage_status`. The pytest coverage asserts that
 *    directly (`post["current_stage"] == "pending"`).
 *  - An empty list is a 201 carrying `[]`, not an error.
 *
 * One deviation. Python looked the profile up with `session.get(WebsiteProfile,
 * id)`, which is not scoped to the caller, and then skipped the prefill when it
 * came back empty. Two holes follow: another account's profile is read for its
 * niche, tone, brand voice and WordPress defaults, and the post is written with
 * that account's `profile_id`, which hands it to them and hides it from its
 * creator, since every read handler joins through `website_profiles` to reach
 * `user_id`. The lookup here is scoped to the caller and a miss is the same
 * `404 {"detail": "Profile not found"}` that `create_post` already answers
 * with, so the two create paths agree. The only case that changes for a
 * legitimate caller is a `profile_id` that does not exist at all, which was a
 * 500 from the foreign key before and is now a 404.
 */
import { and, eq, inArray } from "drizzle-orm"

import { getDb, posts, websiteProfiles } from "@/db"
import { getRequestUser, unauthorized } from "@/lib/request-auth"
import { logger } from "@/mastra"
import { startPipeline } from "@/mastra/start-pipeline"

import { applyProfilePrefill } from "../prefill"
import { serializePost, type PostResponse } from "../serialize"
import {
  invalidJsonBody,
  postCreateSchema,
  toColumns,
  unprocessableBody,
  type PostWriteInput,
} from "../validation"

const batchSchema = postCreateSchema.array()

export async function POST(request: Request): Promise<Response> {
  const user = await getRequestUser(request)
  if (!user) return unauthorized()

  let body: unknown
  try {
    body = await request.json()
  } catch {
    return invalidJsonBody()
  }

  const parsed = batchSchema.safeParse(body)
  if (!parsed.success) return unprocessableBody(parsed.error.issues, body)
  if (parsed.data.length === 0) return Response.json([], { status: 201 })

  const db = getDb()

  // One query for every profile the batch names, rather than one per item.
  const profileIds = [
    ...new Set(parsed.data.map((item) => item.profile_id).filter((id) => id !== null)),
  ]
  const profiles = profileIds.length
    ? await db
        .select()
        .from(websiteProfiles)
        .where(and(inArray(websiteProfiles.id, profileIds), eq(websiteProfiles.userId, user.id)))
    : []
  const profileById = new Map(profiles.map((profile) => [profile.id, profile]))

  const values = []
  for (const item of parsed.data) {
    let write: PostWriteInput = item
    if (write.profile_id) {
      const profile = profileById.get(write.profile_id)
      if (!profile) return Response.json({ detail: "Profile not found" }, { status: 404 })
      write = applyProfilePrefill(write, profile)
    }
    values.push(toColumns(write))
  }

  const rows = await db.insert(posts).values(values).returning()

  // `enqueue_job("run_pipeline_stage", post.id)` per created post, after the
  // commit. As on `POST /api/posts`, a start that fails is logged rather than
  // raised: the posts are written, and a 500 here would report otherwise.
  for (const row of rows) {
    try {
      await startPipeline(row.id)
    } catch (error) {
      logger.warn("Post created but the pipeline could not be started", {
        postId: row.id,
        error: error instanceof Error ? error.message : String(error),
      })
    }
  }

  const created: PostResponse[] = rows.map((row) => serializePost(row))
  return Response.json(created, { status: 201 })
}
