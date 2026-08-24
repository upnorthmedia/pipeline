/**
 * Port of `GET /api/profiles/{profile_id}/wordpress/categories` in
 * `api/src/api/wordpress.py`.
 *
 * `_get_wp_client`'s two 400s come out as real 400s, because the dashboard's
 * category picker needs to tell "no credentials yet" apart from "the site
 * rejected us".
 *
 * Python caught nothing beyond that, so a `WordPressError` from the install
 * and a payload missing a projected key both left the handler as a 500 with no
 * reason attached. `upstreamFailure` answers both as a 502 carrying the
 * message instead: a picker that cannot say why it is empty is the whole
 * complaint behind this endpoint.
 *
 * The projection drops every WordPress field but four and defaults `count` to
 * 0, matching `c.get("count", 0)`; the other three are subscripts that raised
 * `KeyError` on an item missing them.
 */
import { getRequestUser, unauthorized } from "@/lib/request-auth"
import { withServerError } from "@/lib/route-error"

import { isUuid, profileNotFound, unprocessableUuid } from "../../../params"
import { requireField, resolveWpClient, upstreamFailure } from "../client"

async function getHandler(
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
    const categories = await resolved.client.listCategories()
    return Response.json(
      categories.map((category) => {
        const item = category as Record<string, unknown>
        return {
          id: requireField(item, "id"),
          name: requireField(item, "name"),
          slug: requireField(item, "slug"),
          count: "count" in item ? item.count : 0,
        }
      }),
    )
  } catch (error) {
    const answer = upstreamFailure(error, "category")
    if (answer) return answer
    throw error
  }
}

export const GET = withServerError(getHandler)
