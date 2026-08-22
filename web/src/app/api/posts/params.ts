/**
 * The path-parameter and not-found behaviour shared by every
 * `/api/posts/{post_id}` handler.
 *
 * FastAPI parsed `post_id` as a `uuid.UUID` path parameter and answered a
 * malformed one with a 422 before the handler ran; without the same check
 * Postgres raises on the uuid comparison and the client sees a 500 instead.
 *
 * `_get_user_post()` joined `posts` to `website_profiles` and matched on
 * `website_profiles.user_id`, raising `HTTPException(404, "Post not found")`
 * when the join missed. Two consequences are load-bearing and preserved: a
 * post owned by another user is indistinguishable from one that does not
 * exist, and a post whose `profile_id` is null is invisible to every handler,
 * because the join is inner.
 */
import { and, eq, exists, sql } from "drizzle-orm"

import { getDb, posts, websiteProfiles } from "@/db"

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

export function isUuid(value: string): boolean {
  return UUID_PATTERN.test(value)
}

/**
 * Pydantic's `uuid_parsing` body, minus the `ctx.error` string, which comes
 * from the Rust uuid crate's parser and cannot be reproduced faithfully.
 * Nothing in `web/src/lib/api.ts` reads it.
 */
export function unprocessableUuid(input: string): Response {
  return Response.json(
    {
      detail: [
        {
          type: "uuid_parsing",
          loc: ["path", "post_id"],
          msg: "Input should be a valid UUID",
          input,
        },
      ],
    },
    { status: 422 },
  )
}

export function postNotFound(): Response {
  return Response.json({ detail: "Post not found" }, { status: 404 })
}

/**
 * The same restriction as a `WHERE` clause, for the statements that cannot
 * join. `_get_user_post()` matched the id and the owner together through the
 * join, and an `UPDATE` or `DELETE` has to carry that restriction too, but
 * Drizzle's `update()` and `delete()` take no join, so ownership rides along
 * as a correlated `EXISTS` over `website_profiles`.
 */
export function ownedByCaller(postId: string, userId: string) {
  return and(
    eq(posts.id, postId),
    exists(
      getDb()
        .select({ one: sql`1` })
        .from(websiteProfiles)
        .where(and(eq(websiteProfiles.id, posts.profileId), eq(websiteProfiles.userId, userId))),
    ),
  )
}
