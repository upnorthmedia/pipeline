/**
 * Port of `POST /api/queue/pause-all` in `api/src/api/queue.py`.
 *
 * The per-post pause from `POST /api/posts/{post_id}/pause` applied in bulk,
 * but with a stage guard the per-post endpoint does not have: only a post
 * whose `current_stage` is `"pending"` or one of the six stage names is
 * touched. A post already `"complete"`, `"failed"`, `"paused"` or carrying a
 * null stage is left alone and is not counted.
 *
 * Pausing stays a label rather than a control signal, exactly as it is on the
 * per-post endpoint: nothing reads `"paused"` except the queue counts and
 * `POST /api/queue/resume-all`, so a stage already executing runs to
 * completion. The stage the post was on is overwritten, not remembered, which
 * is why `resume-all` has to recover the next stage from `stage_status`.
 */
import { and, eq, inArray } from "drizzle-orm"

import { getDb, posts, websiteProfiles } from "@/db"
import { getRequestUser, unauthorized } from "@/lib/request-auth"
import { STAGES } from "@/mastra/state"

/** Python's `["pending", *STAGES]`. */
const PAUSABLE: string[] = ["pending", ...STAGES]

export async function POST(request: Request): Promise<Response> {
  const user = await getRequestUser(request)
  if (!user) return unauthorized()

  const db = getDb()

  // The `SELECT ... JOIN website_profiles WHERE user_id` Python ran, followed
  // by the per-row write it committed once. Drizzle's `update()` takes no
  // join, so the join stays on the read and the write matches by id.
  const rows = await db
    .select({ id: posts.id })
    .from(posts)
    .innerJoin(websiteProfiles, eq(posts.profileId, websiteProfiles.id))
    .where(and(eq(websiteProfiles.userId, user.id), inArray(posts.currentStage, PAUSABLE)))

  if (rows.length > 0) {
    await db
      .update(posts)
      .set({ currentStage: "paused", updatedAt: new Date() })
      .where(
        inArray(
          posts.id,
          rows.map((row) => row.id),
        ),
      )
  }

  return Response.json({ status: "paused", count: rows.length }, { status: 200 })
}
