/**
 * Port of `GET /api/queue` in `api/src/api/queue.py`.
 *
 * One grouped count over the caller's posts, bucketed into the shape
 * `QueueStatus` in `web/src/lib/api.ts` declares. The join to
 * `website_profiles` is kept inner to mirror the original, though as in
 * `GET /api/posts` it is the `user_id` predicate that excludes a post whose
 * `profile_id` is null: an unowned row matches no user either way.
 *
 * Two details of the Python arithmetic are load-bearing and preserved:
 *
 * - `running` is the sum of the groups whose key is one of the six pipeline
 *   stages, so a post parked at a review gate still counts as running: the
 *   worker leaves `current_stage` on the stage it suspended in.
 * - `total` is the sum of *every* group, not of the five reported buckets.
 *   `posts.current_stage` is a nullable `varchar(20)` with no check
 *   constraint, so a row carrying null or an unrecognised value lands in
 *   `total` and in none of the buckets. Nothing in the application writes such
 *   a row, but the counts have to add up the way Python's did.
 */
import { count, eq } from "drizzle-orm"

import { getDb, posts, websiteProfiles } from "@/db"
import { getRequestUser, unauthorized } from "@/lib/request-auth"
import { STAGES } from "@/mastra/state"

const STAGE_NAMES: ReadonlySet<string> = new Set(STAGES)

export async function GET(request: Request): Promise<Response> {
  const user = await getRequestUser(request)
  if (!user) return unauthorized()

  const rows = await getDb()
    .select({ stage: posts.currentStage, total: count(posts.id) })
    .from(posts)
    .innerJoin(websiteProfiles, eq(posts.profileId, websiteProfiles.id))
    .where(eq(websiteProfiles.userId, user.id))
    .groupBy(posts.currentStage)

  const counts = new Map<string | null, number>()
  for (const row of rows) counts.set(row.stage, row.total)

  let running = 0
  let total = 0
  for (const [stage, value] of counts) {
    if (stage !== null && STAGE_NAMES.has(stage)) running += value
    total += value
  }

  return Response.json({
    running,
    pending: counts.get("pending") ?? 0,
    complete: counts.get("complete") ?? 0,
    failed: counts.get("failed") ?? 0,
    paused: counts.get("paused") ?? 0,
    total,
  })
}
