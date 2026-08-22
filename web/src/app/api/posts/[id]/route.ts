/**
 * Port of `GET /api/posts/{post_id}` in `api/src/api/posts.py`.
 *
 * The lookup is `_get_user_post()`: id and owner matched together through the
 * inner join to `website_profiles`, so a post belonging to another user and a
 * post that does not exist are the same 404. The reasoning lives with
 * `postNotFound()` in `../params`.
 */
import { and, eq } from "drizzle-orm"

import { getDb, posts, websiteProfiles } from "@/db"
import { getRequestUser, unauthorized } from "@/lib/request-auth"

import { isUuid, postNotFound, unprocessableUuid } from "../params"
import { serializePost } from "../serialize"

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
