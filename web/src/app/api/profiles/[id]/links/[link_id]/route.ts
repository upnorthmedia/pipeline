/**
 * Port of `DELETE /api/profiles/{profile_id}/links/{link_id}` in
 * `api/src/api/links.py`.
 *
 * **Deviation: the delete is scoped to the caller.** `delete_link()` was the
 * one endpoint in that router that never called `_get_profile_or_404()`: it
 * matched on `link_id` and `profile_id` alone, so any authenticated user who
 * knew both ids could delete another tenant's link. That is a cross-tenant
 * write, so ownership is enforced here through the same
 * `website_profiles.user_id` predicate the other two endpoints use. A link
 * under someone else's profile answers the same 404 as one that does not
 * exist, so the boundary leaks nothing.
 */
import { and, eq, exists, sql } from "drizzle-orm"

import { getDb, internalLinks, websiteProfiles } from "@/db"
import { getRequestUser, unauthorized } from "@/lib/request-auth"

import { linkNotFound, parseLinkPath } from "../params"

export async function DELETE(
  request: Request,
  { params }: { params: Promise<{ id: string; link_id: string }> },
): Promise<Response> {
  const user = await getRequestUser(request)
  if (!user) return unauthorized()

  const { id, link_id: linkId } = await params
  const invalid = parseLinkPath(id, linkId)
  if (invalid) return invalid

  const db = getDb()
  const deleted = await db
    .delete(internalLinks)
    .where(
      and(
        eq(internalLinks.id, linkId),
        eq(internalLinks.profileId, id),
        exists(
          db
            .select({ one: sql`1` })
            .from(websiteProfiles)
            .where(
              and(eq(websiteProfiles.id, internalLinks.profileId), eq(websiteProfiles.userId, user.id)),
            ),
        ),
      ),
    )
    .returning({ id: internalLinks.id })

  if (deleted.length === 0) return linkNotFound()
  return new Response(null, { status: 204 })
}
