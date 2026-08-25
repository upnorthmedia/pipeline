/**
 * `GET /api/queue`: how many of the caller's runs are in each state.
 *
 * One bucket per `RunStateKind`, counted by handing every owned post to
 * `deriveRunState()`, the same function the posts list and the post page use
 * to label one row. That is a deliberate divergence from the port of
 * `api/src/api/queue.py`, which grouped on `current_stage` alone and called
 * every row sitting on one of the six stage names "running". The column says
 * where a run got to, not what it is doing, so that count included posts the
 * list beside it called "Not started" and "Failed at Research": one screen
 * read `Running: 11` for an account with nothing running. A count and a badge
 * that name the same rows have to come from the same rule, and the rule that
 * knows the difference is `deriveRunState()`, which reads `stage_status` too.
 *
 * Two consequences of moving the arithmetic off the group-by, both intended:
 *
 * - `total` is now the sum of the buckets. Every row lands in exactly one,
 *   including the rows whose `current_stage` is null or a value outside the
 *   enum: `posts.current_stage` is a nullable `varchar(20)` with no check
 *   constraint, and `deriveRunState()` already answers for any value by
 *   falling through to what `stage_status` says the run did.
 * - The handler reads two columns of every owned post rather than a grouped
 *   count. That is a row scan proportional to the account's history where the
 *   old query was proportional to the number of distinct stages. It is the
 *   price of one vocabulary across the two screens; if it ever matters, the
 *   answer is to cache this response, not to re-derive the states in SQL and
 *   have a second copy of the precedence rules to keep in step.
 */
import { and, eq, inArray, or } from "drizzle-orm"

import { getDb, posts, websiteProfiles } from "@/db"
import type { PostStage, StalledPublish, StageStatusMap } from "@/lib/api"
import { publishColumnOf, publishStall } from "@/lib/publish-report"
import { getRequestUser, unauthorized } from "@/lib/request-auth"
import { withServerError } from "@/lib/route-error"
import { deriveRunState, RUN_STATE_KINDS, type RunStateKind } from "@/lib/run-state"

/**
 * The two values either publish status column holds while its attempt is
 * supposed to be moving. They are the only rows `publishStall()` can answer
 * about, so they are what the second query asks for rather than every owned
 * post: the derivation needs `execution_logs`, and reading that column off an
 * account's whole history to answer about the handful of rows mid-publish is
 * the one part of this handler that would be worth avoiding.
 */
const IN_FLIGHT = ["pending", "publishing"]

/**
 * The caller's publishes that have stopped moving, in the words the posts list
 * and the post page already use for the same row.
 *
 * Derived here rather than in the browser because the monitor page holds no
 * post rows, and because the derivation reads `execution_logs`, which no
 * aggregate would otherwise carry. A row whose format names no destination is
 * dropped by `publishColumnOf()`, including one still carrying a `publishing`
 * from a format it has since been moved off.
 */
async function stalledPublishes(userId: string, now: number): Promise<StalledPublish[]> {
  const rows = await getDb()
    .select({
      id: posts.id,
      topic: posts.topic,
      outputFormat: posts.outputFormat,
      wpPublishStatus: posts.wpPublishStatus,
      nextjsPublishStatus: posts.nextjsPublishStatus,
      updatedAt: posts.updatedAt,
      executionLogs: posts.executionLogs,
    })
    .from(posts)
    .innerJoin(websiteProfiles, eq(posts.profileId, websiteProfiles.id))
    .where(
      and(
        eq(websiteProfiles.userId, userId),
        or(
          inArray(posts.wpPublishStatus, IN_FLIGHT),
          inArray(posts.nextjsPublishStatus, IN_FLIGHT),
        ),
      ),
    )

  const stalled: StalledPublish[] = []
  for (const row of rows) {
    const column = publishColumnOf({
      output_format: row.outputFormat ?? "",
      wp_publish_status: row.wpPublishStatus,
      nextjs_publish_status: row.nextjsPublishStatus,
      updated_at: null,
      execution_logs: null,
    })
    if (column === null) continue
    const stall = publishStall({
      status: column.status,
      updatedAt: row.updatedAt?.toISOString() ?? null,
      executionLogs: row.executionLogs,
      now,
    })
    if (stall === null) continue
    stalled.push({
      id: row.id,
      topic: row.topic,
      target: column.target,
      label: column.label,
      short: stall.short,
    })
  }
  return stalled
}

async function getHandler(request: Request): Promise<Response> {
  const user = await getRequestUser(request)
  if (!user) return unauthorized()

  const rows = await getDb()
    .select({ stage: posts.currentStage, stageStatus: posts.stageStatus })
    .from(posts)
    .innerJoin(websiteProfiles, eq(posts.profileId, websiteProfiles.id))
    .where(eq(websiteProfiles.userId, user.id))

  const counts = Object.fromEntries(RUN_STATE_KINDS.map((kind) => [kind, 0])) as Record<
    RunStateKind,
    number
  >
  for (const row of rows) {
    const state = deriveRunState({
      currentStage: row.stage as PostStage,
      stageStatus: (row.stageStatus ?? {}) as StageStatusMap,
    })
    counts[state.kind] += 1
  }

  return Response.json({
    ...counts,
    total: rows.length,
    publish_stalled: await stalledPublishes(user.id, Date.now()),
  })
}

export const GET = withServerError(getHandler)
