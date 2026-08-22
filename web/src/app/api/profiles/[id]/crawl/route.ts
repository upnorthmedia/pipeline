/**
 * Port of `POST /api/profiles/{profile_id}/crawl` in `api/src/api/profiles.py`.
 *
 * The Python handler did four things in order: resolve the profile against the
 * caller, flip `crawl_status` to `"crawling"` and commit, enqueue the ARQ
 * `crawl_profile_sitemap` job, and answer 202 with
 * `{"status": "crawling", "profile_id": ...}`. If the enqueue raised it rolled
 * the status forward to `"failed"`, committed again, and raised a 500 carrying
 * the exception text. All four are reproduced, including the ordering: the row
 * says `crawling` before the job is enqueued, so the profiles page's poll never
 * sees a started crawl still sitting at its old status.
 *
 * The enqueue is `startSitemapCrawl()`, which publishes `workflow.start` onto
 * Redis Streams for the `worker` service to pick up.
 */
import { and, eq } from "drizzle-orm"

import { getDb, websiteProfiles } from "@/db"
import { getRequestUser, unauthorized } from "@/lib/request-auth"
import { startSitemapCrawl } from "@/mastra/start-crawl"

import { isUuid, profileNotFound, unprocessableUuid } from "../../params"

export async function POST(
  request: Request,
  { params }: { params: Promise<{ id: string }> },
): Promise<Response> {
  const user = await getRequestUser(request)
  if (!user) return unauthorized()

  const { id } = await params
  if (!isUuid(id)) return unprocessableUuid(id)

  const db = getDb()
  const owned = and(eq(websiteProfiles.id, id), eq(websiteProfiles.userId, user.id))

  // One statement for the ownership check and the status flip, because the
  // Python handler's read and write were a single ORM unit of work too.
  const rows = await db
    .update(websiteProfiles)
    .set({ crawlStatus: "crawling", updatedAt: new Date() })
    .where(owned)
    .returning({ id: websiteProfiles.id })

  if (rows.length === 0) return profileNotFound()

  try {
    await startSitemapCrawl(id)
  } catch (error) {
    await db
      .update(websiteProfiles)
      .set({ crawlStatus: "failed", updatedAt: new Date() })
      .where(owned)
    const detail = `Failed to enqueue crawl: ${error instanceof Error ? error.message : String(error)}`
    return Response.json({ detail }, { status: 500 })
  }

  // `str(profile_id)` in Python was the *parsed* UUID, so it came back
  // lowercase however the client cased it. The stored id is that same
  // canonical form, so echo the row rather than the raw path segment.
  return Response.json({ status: "crawling", profile_id: rows[0].id }, { status: 202 })
}
