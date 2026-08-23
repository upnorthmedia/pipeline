/**
 * Port of `GET /api/analytics/dashboard` in `api/src/api/analytics.py`.
 *
 * Five independent aggregates over the caller's posts, assembled into the
 * `DashboardStats` shape `web/src/lib/api.ts` declares. Every one of them
 * inner-joins `website_profiles` on `user_id`, so a post whose `profile_id` is
 * null is invisible here exactly as it is in `GET /api/queue`.
 *
 * Only `over_time` is filtered by `days`. `by_status`, the average duration,
 * `by_profile` and the completion rate all read the caller's whole history,
 * which is what the monitor page's overview tab has always shown.
 *
 * The four Python arithmetic details that are load-bearing:
 *
 * - `total` is the sum of *every* group, not of the named buckets, so a post
 *   with a null or unrecognised `current_stage` still counts toward it and
 *   toward the completion rate's denominator.
 * - `completion_rate` and the average duration use Python's round, which is
 *   half to even, not JavaScript's half away from zero.
 * - `avg_duration_s` is tested for truthiness *before* rounding, so an average
 *   of exactly zero reports as `null` rather than `0`.
 * - `by_profile` groups by profile *name*, not by id, so two profiles sharing
 *   a name are one row.
 */
import { and, count, desc, eq, gte, isNotNull, sql } from "drizzle-orm"

import { getDb, posts, websiteProfiles } from "@/db"
import { getRequestUser, unauthorized } from "@/lib/request-auth"
import { pythonRound } from "@/mastra/analytics/python-round"

import { parseInt422, unprocessableRequest, type ValidationErrorDetail } from "../../pydantic"

const DAY_MS = 24 * 60 * 60 * 1000

/**
 * `days: int = Query(30, ge=1, le=365)`. Starlette's `QueryParams.get()`
 * returns the *last* value of a repeated key where `URLSearchParams.get()`
 * returns the first, so the raw value is taken off `getAll()`; this is the
 * same divergence recorded under 5.3c-i for `?stage=`. Unlike `stage`, `days`
 * is a required `int` once present, so `?days=` is a 422 rather than a
 * fallback to the default.
 */
function parseDays(url: URL): number | Response {
  const raw = url.searchParams.getAll("days").at(-1)
  if (raw === undefined) return 30
  const issues: ValidationErrorDetail[] = []
  const days = parseInt422(raw, "days", 30, 1, 365, issues)
  if (issues.length > 0) return unprocessableRequest(issues)
  return days
}

export async function GET(request: Request): Promise<Response> {
  const user = await getRequestUser(request)
  if (!user) return unauthorized()

  const days = parseDays(new URL(request.url))
  if (days instanceof Response) return days

  const db = getDb()
  const owned = eq(websiteProfiles.userId, user.id)
  const since = new Date(Date.now() - days * DAY_MS)
  const todayStart = new Date()
  todayStart.setUTCHours(0, 0, 0, 0)

  const statusRows = await db
    .select({ stage: posts.currentStage, total: count(posts.id) })
    .from(posts)
    .innerJoin(websiteProfiles, eq(posts.profileId, websiteProfiles.id))
    .where(owned)
    .groupBy(posts.currentStage)

  // `json.dumps` renders a `None` dict key as the string "null", so a post
  // whose stage was never written lands under that key rather than being
  // dropped.
  const byStatus: Record<string, number> = {}
  let total = 0
  for (const row of statusRows) {
    byStatus[row.stage ?? "null"] = row.total
    total += row.total
  }
  const complete = byStatus.complete ?? 0
  const completionRate = total > 0 ? pythonRound((complete / total) * 100, 1) : 0

  // `numeric` reaches `pg` as a string, as it reached asyncpg as a `Decimal`.
  // FastAPI's `decimal_encoder` turns a zero-exponent Decimal into an `int`,
  // so the rounded average goes out as an integer, not `303.0`.
  const [durationRow] = await db
    .select({
      avg: sql<
        string | null
      >`avg(extract(epoch from ${posts.completedAt}) - extract(epoch from ${posts.createdAt}))`,
    })
    .from(posts)
    .innerJoin(websiteProfiles, eq(posts.profileId, websiteProfiles.id))
    .where(and(owned, isNotNull(posts.completedAt)))
  const avgSeconds = durationRow?.avg === null ? null : Number(durationRow?.avg)
  const avgDurationS = avgSeconds ? pythonRound(avgSeconds, 0) : null

  const profileRows = await db
    .select({ name: websiteProfiles.name, total: count(posts.id) })
    .from(posts)
    .innerJoin(websiteProfiles, eq(posts.profileId, websiteProfiles.id))
    .where(owned)
    .groupBy(websiteProfiles.name)
    .orderBy(desc(count(posts.id)))
    .limit(10)

  // `str(datetime.date)` is `YYYY-MM-DD`, and that is what comes back here:
  // bare `pg` parses a `date` (OID 1082) into a `Date` at the *local*
  // midnight, but drizzle's node-postgres driver replaces that parser with the
  // identity, so the column arrives as its raw string. The cast itself
  // resolves in the session time zone, which is UTC on this server for both
  // drivers. The `over_time` test pins the string, so a driver that stopped
  // overriding the parser would fail rather than ship ISO timestamps.
  const overTimeRows = await db
    .select({
      date: sql<string>`cast(${posts.createdAt} as date)`.as("date"),
      total: count(posts.id),
    })
    .from(posts)
    .innerJoin(websiteProfiles, eq(posts.profileId, websiteProfiles.id))
    .where(and(owned, gte(posts.createdAt, since)))
    .groupBy(sql`date`)
    .orderBy(sql`date`)

  const [todayRow] = await db
    .select({ total: count(posts.id) })
    .from(posts)
    .innerJoin(websiteProfiles, eq(posts.profileId, websiteProfiles.id))
    .where(and(owned, gte(posts.createdAt, todayStart)))

  return Response.json({
    by_status: byStatus,
    total,
    complete,
    completion_rate: completionRate,
    avg_duration_s: avgDurationS,
    by_profile: profileRows.map((row) => ({ name: row.name, count: row.total })),
    over_time: overTimeRows.map((row) => ({ date: row.date, count: row.total })),
    posts_today: todayRow?.total ?? 0,
  })
}
