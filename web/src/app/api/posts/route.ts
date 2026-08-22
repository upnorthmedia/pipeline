/**
 * Port of `GET /api/posts` in `api/src/api/posts.py`.
 *
 * The Python query joined `posts` to `website_profiles` and filtered on
 * `website_profiles.user_id`, so a post with a null `profile_id` never
 * appeared in the list. That exclusion is preserved: it follows from the
 * `user_id` predicate rather than from the join strategy, since an unowned row
 * cannot match any user, but the join is kept inner to mirror the original.
 */
import { and, asc, desc, eq, ilike, or, type SQL } from "drizzle-orm"

import { getDb, posts, websiteProfiles } from "@/db"
import { getRequestUser, unauthorized } from "@/lib/request-auth"

import { parseListPostsQuery } from "./query"
import { serializePost, type PostResponse } from "./serialize"

export async function GET(request: Request): Promise<Response> {
  const user = await getRequestUser(request)
  if (!user) return unauthorized()

  const query = parseListPostsQuery(new URL(request.url))
  if (query instanceof Response) return query

  const conditions: SQL[] = [eq(websiteProfiles.userId, user.id)]

  // `status or stage`: either name filters `current_stage`, `status` first.
  const stageFilter = query.status || query.stage
  if (stageFilter) conditions.push(eq(posts.currentStage, stageFilter))
  if (query.profileId) conditions.push(eq(posts.profileId, query.profileId))
  if (query.q) {
    const pattern = `%${query.q}%`
    conditions.push(or(ilike(posts.topic, pattern), ilike(posts.slug, pattern)) as SQL)
  }

  const rows = await getDb()
    .select({ post: posts })
    .from(posts)
    .innerJoin(websiteProfiles, eq(posts.profileId, websiteProfiles.id))
    .where(and(...conditions))
    .orderBy(query.order === "desc" ? desc(query.sort) : asc(query.sort))
    .offset((query.page - 1) * query.perPage)
    .limit(query.perPage)

  const body: PostResponse[] = rows.map((row) => serializePost(row.post))
  return Response.json(body)
}
