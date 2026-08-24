/**
 * Port of `GET /api/profiles/{profile_id}/wordpress/authors` in
 * `api/src/api/wordpress.py`.
 *
 * The same shape as `/categories`, including the 502 that replaces Python's
 * uncaught `WordPressError` and `KeyError`. The only differences are the
 * collection (`list_users`, which carries the default
 * `roles=administrator,editor,author`) and the three-key projection, which has
 * no defaulted field at all.
 */
import { getRequestUser, unauthorized } from "@/lib/request-auth"

import { isUuid, profileNotFound, unprocessableUuid } from "../../../params"
import { requireField, resolveWpClient, upstreamFailure } from "../client"

export async function GET(
  request: Request,
  { params }: { params: Promise<{ id: string }> },
): Promise<Response> {
  const user = await getRequestUser(request)
  if (!user) return unauthorized()

  const { id } = await params
  if (!isUuid(id)) return unprocessableUuid(id)

  const resolved = await resolveWpClient(id, user.id)
  if (resolved.kind === "not-found") return profileNotFound()
  if (resolved.kind === "bad-request") {
    return Response.json({ detail: resolved.detail }, { status: 400 })
  }

  try {
    const users = await resolved.client.listUsers()
    return Response.json(
      users.map((wpUser) => {
        const item = wpUser as Record<string, unknown>
        return {
          id: requireField(item, "id"),
          name: requireField(item, "name"),
          slug: requireField(item, "slug"),
        }
      }),
    )
  } catch (error) {
    const answer = upstreamFailure(error, "author")
    if (answer) return answer
    throw error
  }
}
