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
import { eq } from "drizzle-orm"

import { getDb, posts, websiteProfiles } from "@/db"
import type { PostStage, StalledPublish, StageStatusMap } from "@/lib/api"
import { deadPublishes } from "@/lib/publish-queries"
import { getRequestUser, unauthorized } from "@/lib/request-auth"
import { withServerError } from "@/lib/route-error"
import { deriveRunState, RUN_STATE_KINDS, type RunStateKind } from "@/lib/run-state"

/**
 * The caller's publishes that have stopped moving, in the words the posts list
 * and the post page already use for the same row.
 *
 * Derived server side because the monitor page holds no post rows, and because
 * the derivation reads `execution_logs`, which no aggregate would otherwise
 * carry. `deadPublishes()` also answers about a publish the step recorded as
 * `failed`, which this card does not show: a failure has a reason and a retry
 * on the post itself, where a stall has neither and nothing at all says so.
 */
async function stalledPublishes(userId: string, now: number): Promise<StalledPublish[]> {
  const dead = await deadPublishes(userId, now)
  return dead.flatMap((entry) =>
    entry.stall === null
      ? []
      : [
          {
            id: entry.id,
            topic: entry.topic,
            target: entry.target,
            label: entry.label,
            short: entry.stall.short,
          },
        ],
  )
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
