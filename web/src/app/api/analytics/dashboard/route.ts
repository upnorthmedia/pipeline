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
 * - `total` counts *every* owned post, not just the named buckets, so a post
 *   with a null or unrecognised `current_stage` still counts toward it and
 *   toward the completion rate's denominator.
 * - `completion_rate` and the average duration use Python's round, which is
 *   half to even, not JavaScript's half away from zero.
 * - `avg_duration_s` is tested for truthiness *before* rounding, so an average
 *   of exactly zero reports as `null` rather than `0`.
 * - `by_profile` groups by profile *name*, not by id, so two profiles sharing
 *   a name are one row.
 *
 * **`by_status` and `complete` answer different questions, on purpose.**
 * `by_status` is still a group-by on `current_stage`: it is where each row got
 * to, which is what the "Posts by Stage" chart draws and says it draws.
 * `complete` and `completion_rate` are about what the *run* did, so they are
 * counted the way `GET /api/queue` counts its buckets, by handing both columns
 * to `deriveRunState()`. Python read the column for both, which made a run that
 * reached the end with a failed stage a completion: `markPipelineComplete()` is
 * unconditional, so an account with four rows on `complete`, one of whose
 * `images` stage failed, printed `Completion Rate 26.7%` directly above a strip
 * calling three of them Complete and the fourth Finished with errors. Two
 * numbers on one screen counting the same rows have to use one rule.
 *
 * **A publish that never landed is not a clean finish either** (polish ledger
 * item P5.2). The run and the publish after it are two things and
 * `deriveRunState()` only knows about the first, so a post whose WordPress
 * attempt died still reached `complete`. That put this completion rate directly
 * under the `/monitor` card naming those exact posts as stopped, with each of
 * the two calling the same row something else. Those rows come out of
 * `complete` and into `publish_incomplete`, which is a number the card and the
 * percentage can both be read against rather than a silent subtraction. A run
 * already finished with errors is in neither: it has its own explanation, and
 * one row under two of them is the confusion this is fixing.
 */
import { and, count, desc, eq, gte, isNotNull, sql } from "drizzle-orm"

import { getDb, posts, websiteProfiles } from "@/db"
import type { PostStage, StageStatusMap } from "@/lib/api"
import { deadPublishes } from "@/lib/publish-queries"
import { getRequestUser, unauthorized } from "@/lib/request-auth"
import { withServerError } from "@/lib/route-error"
import { deriveRunState } from "@/lib/run-state"
import { pythonRound } from "@/mastra/analytics/python-round"

import { DAY_MS, parseDays } from "../days"

async function getHandler(request: Request): Promise<Response> {
  const user = await getRequestUser(request)
  if (!user) return unauthorized()

  const days = parseDays(new URL(request.url))
  if (days instanceof Response) return days

  const db = getDb()
  const owned = eq(websiteProfiles.userId, user.id)
  const since = new Date(Date.now() - days * DAY_MS)
  const todayStart = new Date()
  todayStart.setUTCHours(0, 0, 0, 0)

  // Both columns of every owned post, rather than a grouped count: the bucket
  // a row lands in needs `current_stage`, and whether its run finished needs
  // `stage_status` as well. Same row scan `GET /api/queue` does, and the same
  // answer if it ever costs anything, which is to cache the response rather
  // than to re-derive the precedence rules in SQL.
  const statusRows = await db
    .select({ id: posts.id, stage: posts.currentStage, stageStatus: posts.stageStatus })
    .from(posts)
    .innerJoin(websiteProfiles, eq(posts.profileId, websiteProfiles.id))
    .where(owned)

  // `json.dumps` renders a `None` dict key as the string "null", so a post
  // whose stage was never written lands under that key rather than being
  // dropped.
  // The posts whose own publish attempt failed or stopped moving, which is the
  // same set the `/monitor` card is built from. A second query rather than five
  // more columns on the scan above: it reads `execution_logs`, and the rows
  // that can be in it are the handful carrying a publish status.
  const deadPublishIds = new Set((await deadPublishes(user.id, Date.now())).map((row) => row.id))

  const byStatus: Record<string, number> = {}
  let complete = 0
  let publishIncomplete = 0
  for (const row of statusRows) {
    const key = row.stage ?? "null"
    byStatus[key] = (byStatus[key] ?? 0) + 1
    const state = deriveRunState({
      currentStage: row.stage as PostStage,
      stageStatus: (row.stageStatus ?? {}) as StageStatusMap,
    })
    if (state.kind !== "complete") continue
    if (deadPublishIds.has(row.id)) publishIncomplete += 1
    else complete += 1
  }
  const total = statusRows.length
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
    publish_incomplete: publishIncomplete,
    completion_rate: completionRate,
    avg_duration_s: avgDurationS,
    by_profile: profileRows.map((row) => ({ name: row.name, count: row.total })),
    over_time: overTimeRows.map((row) => ({ date: row.date, count: row.total })),
    posts_today: todayRow?.total ?? 0,
  })
}

export const GET = withServerError(getHandler)
