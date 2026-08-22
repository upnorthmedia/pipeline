/**
 * Port of `GET`, `PATCH` and `DELETE` on `/api/posts/{post_id}` in
 * `api/src/api/posts.py`.
 *
 * The lookup is `_get_user_post()`: id and owner matched together through the
 * inner join to `website_profiles`, so a post belonging to another user and a
 * post that does not exist are the same 404. The reasoning lives with
 * `postNotFound()` in `../params`.
 */
import { rm } from "node:fs/promises"

import { and, eq } from "drizzle-orm"

import { getDb, posts, websiteProfiles } from "@/db"
import { getRequestUser, unauthorized } from "@/lib/request-auth"
import { postMediaDir } from "@/mastra/images/media-dir"

import { isUuid, ownedByCaller, postNotFound, unprocessableUuid } from "../params"
import { serializePost } from "../serialize"
import {
  invalidJsonBody,
  postUpdateSchema,
  unprocessableBody,
  updateToColumns,
} from "../validation"

export async function GET(
  request: Request,
  { params }: { params: Promise<{ id: string }> },
): Promise<Response> {
  const user = await getRequestUser(request)
  if (!user) return unauthorized()

  const { id } = await params
  if (!isUuid(id)) return unprocessableUuid(id)

  const rows = await getDb()
    .select({ post: posts })
    .from(posts)
    .innerJoin(websiteProfiles, eq(posts.profileId, websiteProfiles.id))
    .where(and(eq(posts.id, id), eq(websiteProfiles.userId, user.id)))
    .limit(1)

  if (rows.length === 0) return postNotFound()
  return Response.json(serializePost(rows[0].post))
}

/**
 * Port of `PATCH /api/posts/{post_id}`.
 *
 * `PostUpdate.model_dump(exclude_unset=True)` wrote only the keys the client
 * actually sent, so a key sent as `null` clears the column while a key left out
 * is untouched. Zod's `.partial()` reproduces that.
 *
 * `updated_at` is stamped by hand because `TimestampMixin.onupdate` did it on
 * the Python side. One difference, measured rather than assumed: SQLAlchemy
 * marks the instance dirty on any `setattr` but compares the value against the
 * loaded one at flush time, so a patch that submits only values the row already
 * holds emits no UPDATE and leaves `updated_at` alone, whereas this issues the
 * UPDATE and bumps it. Reproducing that needs a deep equality over the jsonb
 * and array columns whose failure mode is skipping a write that should happen,
 * which is a worse bug than a timestamp no caller branches on. The same
 * deviation is already recorded for `PATCH /api/profiles/{profile_id}`.
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

  const parsed = postUpdateSchema.safeParse(body)
  if (!parsed.success) return unprocessableBody(parsed.error.issues, body)

  const owned = ownedByCaller(id, user.id)

  const columns = updateToColumns(parsed.data)

  // An empty dump left Python with nothing to flush, so it committed no-op and
  // returned the row as it stood. Drizzle rejects an empty `set`, so read it.
  if (Object.keys(columns).length === 0) {
    const rows = await getDb().select({ post: posts }).from(posts).where(owned).limit(1)
    if (rows.length === 0) return postNotFound()
    return Response.json(serializePost(rows[0].post))
  }

  const rows = await getDb()
    .update(posts)
    .set({ ...columns, updatedAt: new Date() })
    .where(owned)
    .returning()

  if (rows.length === 0) return postNotFound()
  return Response.json(serializePost(rows[0]))
}

/**
 * Port of `DELETE /api/posts/{post_id}`.
 *
 * Unlike the profile delete, `session.delete(post)` cascades over nothing:
 * `Post` declares only the many-to-one `profile` relationship. The one foreign
 * key pointing at `posts` is `internal_links.post_id`, and Alembic 006 gave it
 * `ON DELETE SET NULL`, so the database detaches those rows itself. Probed
 * against the real ORM and the real database: deleting a post that owned one
 * link left that link in place with `post_id = None`.
 *
 * The media directory is removed after the row is gone, in that order, because
 * that is the order Python used. `rm(..., { force: true })` stands in for
 * `if media_dir.exists(): shutil.rmtree(media_dir)`; both are silent when the
 * directory was never created, and neither swallows a failure to remove one
 * that was. `post_id` has already been checked against the uuid pattern, so it
 * cannot escape the media root.
 */
export async function DELETE(
  request: Request,
  { params }: { params: Promise<{ id: string }> },
): Promise<Response> {
  const user = await getRequestUser(request)
  if (!user) return unauthorized()

  const { id } = await params
  if (!isUuid(id)) return unprocessableUuid(id)

  const deleted = await getDb()
    .delete(posts)
    .where(ownedByCaller(id, user.id))
    .returning({ id: posts.id })

  if (deleted.length === 0) return postNotFound()

  await rm(postMediaDir(id), { recursive: true, force: true })

  return new Response(null, { status: 204 })
}
