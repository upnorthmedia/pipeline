/**
 * Port of `GET /api/profiles/{profile_id}` in `api/src/api/profiles.py`.
 *
 * `_get_user_profile()` matched on both the id and the owner and raised
 * `HTTPException(404, "Profile not found")` when either missed, so another
 * user's profile is indistinguishable from one that does not exist. That is
 * the multi-tenancy boundary and it is preserved verbatim.
 *
 * `PATCH` and `DELETE` land in ledger item 5.2b.
 */
import { and, eq } from "drizzle-orm"

import { getDb, websiteProfiles } from "@/db"
import { getRequestUser, unauthorized } from "@/lib/request-auth"

import { serializeProfile } from "../serialize"

/**
 * FastAPI parsed `profile_id` as a `uuid.UUID` path parameter and rejected a
 * malformed one with a 422 before the handler ran. Postgres would instead
 * raise on the comparison and surface a 500, so the same check happens here.
 * The body carries FastAPI's `type`/`loc`/`msg`/`input` keys; its `ctx` and
 * `url` keys are not reproduced, and nothing in `web/src/lib/api.ts` reads
 * them.
 */
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

function unprocessableUuid(input: string): Response {
  return Response.json(
    {
      detail: [
        {
          type: "uuid_parsing",
          loc: ["path", "profile_id"],
          msg: "Input should be a valid UUID",
          input,
        },
      ],
    },
    { status: 422 },
  )
}

function notFound(): Response {
  return Response.json({ detail: "Profile not found" }, { status: 404 })
}

export async function GET(
  request: Request,
  { params }: { params: Promise<{ id: string }> },
): Promise<Response> {
  const user = await getRequestUser(request)
  if (!user) return unauthorized()

  const { id } = await params
  if (!UUID_PATTERN.test(id)) return unprocessableUuid(id)

  const rows = await getDb()
    .select()
    .from(websiteProfiles)
    .where(and(eq(websiteProfiles.id, id), eq(websiteProfiles.userId, user.id)))
    .limit(1)

  if (rows.length === 0) return notFound()
  return Response.json(serializeProfile(rows[0]))
}
