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
import { rm } from "node:fs/promises"

import { and, eq } from "drizzle-orm"

import { getDb, posts, websiteProfiles } from "@/db"
import { getRequestUser, unauthorized } from "@/lib/request-auth"
import { withServerError } from "@/lib/route-error"
import { postMediaDir } from "@/mastra/images/media-dir"

import { isUuid, profileNotFound, unprocessableUuid } from "../params"
import { encryptCredentials } from "../secrets"
import { serializeProfile } from "../serialize"
import { invalidJsonBody, profileUpdateSchema, toColumns, unprocessableBody } from "../validation"

async function getHandler(
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

export const GET = withServerError(getHandler)

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
async function patchHandler(
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

export const PATCH = withServerError(patchHandler)

/**
 * A query flag is a string or nothing, and a link that spells it `?with_posts`
 * with no value means the same as `=true`. Anything else is not the flag.
 */
function truthyFlag(value: string | null): boolean {
  return value === "" || value === "true" || value === "1"
}

/**
 * The refusal. Singular and plural are spelled out rather than assembled with
 * an `s`, because the sentence names the action too ("it" against "them").
 */
function profileHasPosts(count: number): Response {
  const detail =
    count === 1
      ? "This profile still has 1 post. Delete it before deleting the profile."
      : `This profile still has ${count} posts. Delete them before deleting the profile.`
  return Response.json({ detail }, { status: 409 })
}

/**
 * Ported from `DELETE /api/profiles/{profile_id}`, and deliberately no longer
 * faithful to it. `session.delete(profile)` cascaded over the two
 * relationships on `WebsiteProfile`: `links` carries
 * `cascade="all, delete-orphan"` so those rows went, and `posts` carries no
 * delete cascade, so SQLAlchemy disassociated them by nulling
 * `posts.profile_id`. This handler copied that, which made it the last writer
 * of unreachable posts: `posts` has no `user_id`, ownership is only reachable
 * by joining `website_profiles`, and every read handler inner-joins it. A post
 * left with no profile therefore belongs to nobody, is invisible in the
 * dashboard and cannot be deleted through it. Only SQL could remove it.
 *
 * So a profile that still has posts is refused instead, with the count in the
 * sentence. Silently destroying somebody's drafts as a side effect of removing
 * a profile is not a decision this handler gets to make.
 *
 * `?with_posts=true` is how the caller makes it: the count is on the row and in
 * the confirmation, so asking for it is an answer to a question that named the
 * number. The posts go inside the same transaction as the profile, so the
 * failure that used to strand them (profile gone, posts left with a null
 * `profile_id`) cannot happen. Their media directories are removed afterwards,
 * the way `DELETE /api/posts/{id}` removes one: a directory that outlives its
 * transaction is wasted disk, a transaction rolled back after an unlink is a
 * post with no images.
 *
 * `internal_links_profile_id_fkey` does have `ON DELETE CASCADE`, so the
 * database removes those rows without help, and `post_media_post_id_fkey`
 * does the same for the manifest rows of a deleted post.
 */
async function deleteHandler(
  request: Request,
  { params }: { params: Promise<{ id: string }> },
): Promise<Response> {
  const user = await getRequestUser(request)
  if (!user) return unauthorized()

  const { id } = await params
  if (!isUuid(id)) return unprocessableUuid(id)

  const owned = and(eq(websiteProfiles.id, id), eq(websiteProfiles.userId, user.id))
  const withPosts = truthyFlag(new URL(request.url).searchParams.get("with_posts"))

  const deleted = await getDb().transaction(async (tx) => {
    // Ownership is settled before anything is written, so a request for
    // someone else's profile leaves that owner's posts untouched.
    const rows = await tx
      .select({ id: websiteProfiles.id })
      .from(websiteProfiles)
      .where(owned)
      .limit(1)
    if (rows.length === 0) return "missing"

    // Counted inside the same transaction as the delete, so a post created
    // while this request is in flight cannot be stranded by it.
    const attached = await tx
      .select({ id: posts.id })
      .from(posts)
      .where(eq(posts.profileId, id))
    if (attached.length > 0 && !withPosts) return attached.length

    if (attached.length > 0) await tx.delete(posts).where(eq(posts.profileId, id))
    await tx.delete(websiteProfiles).where(owned)
    return attached.map((post) => post.id)
  })

  if (deleted === "missing") return profileNotFound()
  if (typeof deleted === "number") return profileHasPosts(deleted)

  for (const postId of deleted) {
    await rm(postMediaDir(postId), { recursive: true, force: true })
  }
  return new Response(null, { status: 204 })
}

export const DELETE = withServerError(deleteHandler)
