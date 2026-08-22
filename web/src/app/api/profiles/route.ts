/**
 * Port of `GET /api/profiles` in `api/src/api/profiles.py`.
 *
 * Rows are scoped to the authenticated user by `website_profiles.user_id`
 * (Alembic 010) and ordered newest first, matching the Python query exactly.
 */
import { desc, eq } from "drizzle-orm"

import { getDb, websiteProfiles } from "@/db"
import { getRequestUser, unauthorized } from "@/lib/request-auth"

import { encryptCredentials } from "./secrets"
import { serializeProfile, type ProfileResponse } from "./serialize"
import { invalidJsonBody, profileCreateSchema, toColumns, unprocessableBody } from "./validation"

export async function GET(request: Request): Promise<Response> {
  const user = await getRequestUser(request)
  if (!user) return unauthorized()

  const rows = await getDb()
    .select()
    .from(websiteProfiles)
    .where(eq(websiteProfiles.userId, user.id))
    .orderBy(desc(websiteProfiles.createdAt))

  const body: ProfileResponse[] = rows.map(serializeProfile)
  return Response.json(body)
}

/**
 * Port of `POST /api/profiles`.
 *
 * The row is written with the full `model_dump()` of `ProfileCreate`, so every
 * pydantic default is materialised rather than left to the column default. The
 * two differ for `output_format` ("markdown" against the column's "both") and
 * for `default_stage_settings` (six "auto" stages against the column's five
 * "review" ones), and the pydantic value is the one the Python stack wrote.
 *
 * `user_id` comes from the session, never from the body, which is what makes
 * the row unreachable from another account.
 *
 * Not ported here: the `crawl_profile_sitemap` job this endpoint enqueued on
 * success, which has no TypeScript equivalent yet. It is ledger item 5.2c,
 * with the rest of the crawl endpoint. Python wrapped the enqueue in a bare
 * `except` so that a dead queue still returned a 201, meaning the response is
 * the same either way; only the follow-up crawl is missing.
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

  const parsed = profileCreateSchema.safeParse(body)
  if (!parsed.success) return unprocessableBody(parsed.error.issues, body)

  const [row] = await getDb()
    .insert(websiteProfiles)
    .values({ ...encryptCredentials(toColumns(parsed.data)), userId: user.id })
    .returning()

  return Response.json(serializeProfile(row), { status: 201 })
}
