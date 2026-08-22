/**
 * Port of `GET /api/profiles/{profile_id}` in `api/src/api/profiles.py`.
 *
 * Every handler here matches on the id and the owner together, which is what
 * makes another user's profile the same 404 as a missing one; the reasoning
 * lives with `profileNotFound()` in `../params`.
 *
 * Also ports `PATCH /api/profiles/{profile_id}` and
 * `DELETE /api/profiles/{profile_id}`.
 */
import { and, eq } from "drizzle-orm"

import { getDb, posts, websiteProfiles } from "@/db"
import { getRequestUser, unauthorized } from "@/lib/request-auth"

import { isUuid, profileNotFound, unprocessableUuid } from "../params"
import { encryptCredentials } from "../secrets"
import { serializeProfile } from "../serialize"
import { invalidJsonBody, profileUpdateSchema, toColumns, unprocessableBody } from "../validation"

export async function GET(
  request: Request,
  { params }: { params: Promise<{ id: string }> },
): Promise<Response> {
  const user = await getRequestUser(request)
  if (!user) return unauthorized()

  const { id } = await params
  if (!isUuid(id)) return unprocessableUuid(id)

  const rows = await getDb()
    .select()
    .from(websiteProfiles)
    .where(and(eq(websiteProfiles.id, id), eq(websiteProfiles.userId, user.id)))
    .limit(1)

  if (rows.length === 0) return profileNotFound()
  return Response.json(serializeProfile(rows[0]))
}

/**
 * Port of `PATCH /api/profiles/{profile_id}`.
 *
 * `ProfileUpdate.model_dump(exclude_unset=True)` wrote only the keys the client
 * actually sent, so a key sent as `null` clears the column while a key left out
 * is untouched. Zod's `.partial()` reproduces that: an absent key is absent
 * from the parse output, so it never reaches the `set`.
 *
 * `updated_at` is stamped by hand because `TimestampMixin.onupdate` did it on
 * the Python side. One difference: SQLAlchemy skipped the UPDATE entirely when
 * every submitted value already equalled the stored one, leaving `updated_at`
 * alone, whereas this issues the UPDATE and bumps it. Reproducing attribute
 * level dirty tracking is not worth it for a timestamp no caller branches on.
 */
export async function PATCH(
  request: Request,
  { params }: { params: Promise<{ id: string }> },
): Promise<Response> {
  const user = await getRequestUser(request)
  if (!user) return unauthorized()

  const { id } = await params
  if (!isUuid(id)) return unprocessableUuid(id)

  let body: unknown
  try {
    body = await request.json()
  } catch {
    return invalidJsonBody()
  }

  const parsed = profileUpdateSchema.safeParse(body)
  if (!parsed.success) return unprocessableBody(parsed.error.issues, body)

  const owned = and(eq(websiteProfiles.id, id), eq(websiteProfiles.userId, user.id))
  const columns = encryptCredentials(toColumns(parsed.data))

  // An empty dump left Python with nothing to flush, so it committed no-op and
  // returned the row as it stood. Drizzle rejects an empty `set`, so read it.
  if (Object.keys(columns).length === 0) {
    const rows = await getDb().select().from(websiteProfiles).where(owned).limit(1)
    if (rows.length === 0) return profileNotFound()
    return Response.json(serializeProfile(rows[0]))
  }

  const rows = await getDb()
    .update(websiteProfiles)
    .set({ ...columns, updatedAt: new Date() })
    .where(owned)
    .returning()

  if (rows.length === 0) return profileNotFound()
  return Response.json(serializeProfile(rows[0]))
}

/**
 * Port of `DELETE /api/profiles/{profile_id}`.
 *
 * `session.delete(profile)` is not a bare `DELETE`: SQLAlchemy first cascades
 * over the two relationships on `WebsiteProfile`. `links` carries
 * `cascade="all, delete-orphan"` so the rows go, and `posts` carries no delete
 * cascade so SQLAlchemy disassociates them by nulling `posts.profile_id`.
 * Confirmed by probing the real ORM against the test database: deleting a
 * profile with one post and one link left `posts=1 post.profile_id=[None]
 * links=0`. That matters because `posts_profile_id_fkey` has no `ON DELETE`
 * action, so a plain `DELETE` here would raise a foreign key violation instead
 * of orphaning the posts the way the Python endpoint did.
 *
 * `internal_links_profile_id_fkey` does have `ON DELETE CASCADE`, so the
 * database removes those rows without help.
 */
export async function DELETE(
  request: Request,
  { params }: { params: Promise<{ id: string }> },
): Promise<Response> {
  const user = await getRequestUser(request)
  if (!user) return unauthorized()

  const { id } = await params
  if (!isUuid(id)) return unprocessableUuid(id)

  const owned = and(eq(websiteProfiles.id, id), eq(websiteProfiles.userId, user.id))

  const deleted = await getDb().transaction(async (tx) => {
    // Ownership is settled before anything is written, so a request for
    // someone else's profile leaves that owner's posts untouched.
    const rows = await tx
      .select({ id: websiteProfiles.id })
      .from(websiteProfiles)
      .where(owned)
      .limit(1)
    if (rows.length === 0) return false

    await tx.update(posts).set({ profileId: null }).where(eq(posts.profileId, id))
    await tx.delete(websiteProfiles).where(owned)
    return true
  })

  if (!deleted) return profileNotFound()
  return new Response(null, { status: 204 })
}
