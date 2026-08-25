/**
 * Port of `GET /api/profiles` in `api/src/api/profiles.py`.
 *
 * Rows are scoped to the authenticated user by `website_profiles.user_id`
 * (Alembic 010) and ordered newest first, matching the Python query exactly.
 */
import { desc, eq, sql } from "drizzle-orm"

import { getDb, posts, websiteProfiles } from "@/db"
import { getRequestUser, unauthorized } from "@/lib/request-auth"
import { withServerError } from "@/lib/route-error"
import { logger } from "@/mastra"
import { startSitemapCrawl } from "@/mastra/start-crawl"

import { encryptCredentials } from "./secrets"
import { serializeProfile, type ProfileListResponse } from "./serialize"
import { invalidJsonBody, profileCreateSchema, toColumns, unprocessableBody } from "./validation"

async function getHandler(request: Request): Promise<Response> {
  const user = await getRequestUser(request)
  if (!user) return unauthorized()

  // The left join keeps a profile with no posts in the list, and grouping by
  // the primary key is enough for Postgres to accept every other column.
  const rows = await getDb()
    .select({
      profile: websiteProfiles,
      postCount: sql<number>`count(${posts.id})`.mapWith(Number),
    })
    .from(websiteProfiles)
    .leftJoin(posts, eq(posts.profileId, websiteProfiles.id))
    .where(eq(websiteProfiles.userId, user.id))
    .groupBy(websiteProfiles.id)
    .orderBy(desc(websiteProfiles.createdAt))

  const body: ProfileListResponse[] = rows.map((row) => ({
    ...serializeProfile(row.profile),
    post_count: row.postCount,
  }))
  return Response.json(body)
}

export const GET = withServerError(getHandler)

/**
 * Port of `POST /api/profiles`.
 *
 * The row is written with the full `model_dump()` of `ProfileCreate`, so every
 * pydantic default is materialised rather than left to the column default. The
 * two still differ for `default_stage_settings` (six "auto" stages against the
 * column's five "review" ones), and the pydantic value is the one the Python
 * stack wrote. They differed for `output_format` too until `drizzle/0003`
 * moved the column default off `both`, a value no publish step handles and the
 * picker cannot render.
 *
 * `user_id` comes from the session, never from the body, which is what makes
 * the row unreachable from another account.
 *
 * The sitemap crawl is started on success, as Python did. Its `except: pass`
 * is reproduced rather than tidied away: a dead queue must still return the
 * 201, because the profile is written and refusing to report it would leave the
 * client believing the create failed. The swallowed error is logged, which
 * Python did not do, so an outage is visible somewhere.
 */
async function postHandler(request: Request): Promise<Response> {
  const user = await getRequestUser(request)
  if (!user) return unauthorized()

  let body: unknown
  try {
    body = await request.json()
  } catch {
    return invalidJsonBody()
  }

  const parsed = profileCreateSchema.safeParse(body)
  if (!parsed.success) return unprocessableBody(parsed.error.issues, body)

  const [row] = await getDb()
    .insert(websiteProfiles)
    .values({ ...encryptCredentials(toColumns(parsed.data)), userId: user.id })
    .returning()

  try {
    await startSitemapCrawl(row.id)
  } catch (error) {
    logger.warn("Profile created but the sitemap crawl could not be started", {
      profileId: row.id,
      error: error instanceof Error ? error.message : String(error),
    })
  }

  return Response.json(serializeProfile(row), { status: 201 })
}

export const POST = withServerError(postHandler)
