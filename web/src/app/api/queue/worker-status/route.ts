/**
 * Port of `GET /api/queue/worker-status` in `api/src/api/queue.py`.
 *
 * The Python handler answered four questions off three ARQ artefacts and one
 * database count. None of the three artefacts survives the port, so each
 * answer is re-derived rather than transcribed:
 *
 * - `worker_alive`: was a `SCAN arq:worker:*`, now the orchestration consumer
 *   group's live consumers (`readWorkerHealth`, ledger 5.4c-i). Note that the
 *   Python answer was always `false`: it scanned `arq:worker:*` while ARQ
 *   wrote its heartbeat to `arq:queue:health-check`. Reproducing a constant
 *   `false` would be transcribing a bug, so this reports the truth.
 * - `queued_jobs`: was `ZCARD arq:queue`, now the group's undelivered `lag`.
 *   Different unit: ARQ counted whole jobs waiting, this counts orchestration
 *   events, of which one run contributes several over its life. `null` when
 *   Redis cannot determine the lag, because "no backlog" and "backlog unknown"
 *   are different answers.
 * - `last_completed`: was `GET arq:worker:last_completed`, now
 *   `mastra:worker:last_completed`, written by `pipelineCompleteStep` at the
 *   end of every run that reaches it.
 * - `active_jobs`: unchanged in meaning, a `current_stage IN (STAGES)` count.
 *
 * One deliberate deviation. Python's `active_jobs` query has no user
 * predicate, so every caller was told how many posts were running across the
 * whole installation, unlike every other query in this router (logged in
 * `todo.md`). This port scopes it through `website_profiles.user_id` like the
 * rest of Phase 5: a handler that reports on another tenant's rows is a defect
 * to close, not a behaviour to preserve. The two Redis numbers stay
 * installation-wide, because a worker process and its backlog are not owned by
 * a user.
 */
import { and, count, eq, inArray } from "drizzle-orm"

import { getDb, posts, websiteProfiles } from "@/db"
import { getRequestUser, unauthorized } from "@/lib/request-auth"
import { STAGES } from "@/mastra/state"
import { getHealthRedis, readLastCompleted, readWorkerHealth } from "@/mastra/worker-health"

export async function GET(request: Request): Promise<Response> {
  const user = await getRequestUser(request)
  if (!user) return unauthorized()

  // One connection for both Redis reads: the health client is cached per
  // process, so a request does not open a socket to answer a widget. It is
  // connected here rather than inside the two helpers, because both would
  // otherwise call `connect()` on the same unopened client concurrently.
  const client = getHealthRedis()
  if (!client.isOpen) await client.connect()

  const [health, lastCompleted, activeRows] = await Promise.all([
    readWorkerHealth({ client }),
    readLastCompleted({ client }),
    getDb()
      .select({ active: count(posts.id) })
      .from(posts)
      .innerJoin(websiteProfiles, eq(posts.profileId, websiteProfiles.id))
      .where(
        and(
          eq(websiteProfiles.userId, user.id),
          inArray(posts.currentStage, [...STAGES]),
        ),
      ),
  ])

  return Response.json({
    worker_alive: health.workerAlive,
    active_jobs: activeRows[0]?.active ?? 0,
    queued_jobs: health.queuedEvents,
    last_completed: lastCompleted,
  })
}
