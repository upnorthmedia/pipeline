/**
 * Port of `GET /api/profiles` in `api/src/api/profiles.py`.
 *
 * Rows are scoped to the authenticated user by `website_profiles.user_id`
 * (Alembic 010) and ordered newest first, matching the Python query exactly.
 * `POST /api/profiles` lands in ledger item 5.2b together with the other write
 * endpoints, because it also has to encrypt two credential columns.
 */
import { desc, eq } from "drizzle-orm"

import { getDb, websiteProfiles } from "@/db"
import { getRequestUser, unauthorized } from "@/lib/request-auth"

import { serializeProfile, type ProfileResponse } from "./serialize"

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
