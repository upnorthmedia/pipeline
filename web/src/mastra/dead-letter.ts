/**
 * Where the dead-letter endpoints get their records.
 *
 * Python's DLQ was a Redis list `_move_to_dlq()` pushed a JSON blob onto
 * (`api/src/worker.py:389`). Item 5.4d-i decided that list is not ported: a
 * permanently failed run is already recorded, durably and with its error, on
 * its own row in Mastra's Postgres storage, and a second copy in Redis would be
 * a parallel store of the same fact with nothing keeping the two in step.
 *
 * So this module reads Mastra's run rows. `listWorkflowRuns` is the storage
 * adapter's own interface for that; the `status` filter is served by the index
 * `@mastra/pg` creates on `(workflow_name, snapshot ->> 'status', "createdAt"
 * DESC)`, and its `ORDER BY "createdAt" DESC` is the newest-first order
 * `LPUSH` + `LRANGE 0 -1` gave Python.
 *
 * The call is deliberately unpaginated, which means it materialises every
 * failed `pipeline` run in the installation before the caller's are picked out
 * of it. Pagination cannot be applied before the scoping anyway: nothing on the
 * run row carries the owning user, so the entries have to be joined to `posts`
 * in the handler before a page of them means anything. It is affordable because
 * the rows are small: a stage's step output is counters and a model id rather
 * than the article, so the dev database's 442 failed runs total 487 kB of
 * snapshot (`pg_column_size`) and this function returns in 40 ms. If a real
 * installation ever accumulates failures at a scale where that stops holding,
 * the fix is a `resourceId` on the run so the storage query can scope itself.
 */
import { and, eq, inArray, sql } from "drizzle-orm"

import { getDb, posts, websiteProfiles } from "../db"
import { mastra } from "./index"
import { pipelineWorkflow } from "./workflows/pipeline"
import { STAGES, type Stage } from "./state"

/** One permanently failed run, in the fields Python's DLQ entry carried. */
export type FailedRun = {
  runId: string
  postId: string
  /**
   * The stage whose step failed. Python recorded
   * `target_stages[0] if len(target_stages) == 1 else ""`, so a full pipeline
   * run recorded no stage at all; the snapshot names the step that actually
   * threw, so a full run reports one too.
   */
  stage: Stage | null
  /** Python's `str(e)`, the text the failing stage raised. */
  error: string
  attempts: number
  /** ISO 8601, the moment the run was last written. */
  failedAt: string
}

type Snapshot = {
  status?: unknown
  error?: unknown
  context?: Record<string, unknown>
}

/** A snapshot is stored as `jsonb` but the adapter's type allows the string form. */
function parseSnapshot(snapshot: unknown): Snapshot | null {
  if (typeof snapshot === "string") {
    try {
      return JSON.parse(snapshot) as Snapshot
    } catch {
      return null
    }
  }
  return typeof snapshot === "object" && snapshot !== null ? (snapshot as Snapshot) : null
}

/**
 * `stageStepInputSchema`'s `postId`, as the engine stored the run's input.
 *
 * Checked against the UUID shape rather than merely non-empty, because the
 * handler feeds these straight into a `posts.id IN (...)` predicate: one
 * snapshot carrying something that is not a UUID would make Postgres reject the
 * whole query and take the endpoint down with it.
 */
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

function postIdOf(snapshot: Snapshot): string | undefined {
  const input = snapshot.context?.input as { postId?: unknown } | undefined
  return typeof input?.postId === "string" && UUID.test(input.postId) ? input.postId : undefined
}

/**
 * The error text. The engine serialises a thrown `Error` to `{name, message}`
 * and passes a thrown non-`Error` through as it was, so both shapes reach here,
 * exactly as they do in `failure-recorder.ts`.
 */
function messageOf(error: unknown): string {
  if (typeof error === "string") return error
  const message = (error as { message?: unknown })?.message
  return typeof message === "string" ? message : String(error ?? "")
}

/**
 * The stage that failed: the step whose own result is `failed`.
 *
 * Only the six stage ids are considered, so `input`, `__state` and the
 * bookkeeping steps in the chain cannot be mistaken for one. The nested
 * `images` workflow surfaces on the parent's context under its own id, so an
 * image generation that dies reports `images` rather than the inner step.
 */
function failedStageOf(snapshot: Snapshot): Stage | null {
  for (const stage of STAGES) {
    const step = snapshot.context?.[stage] as { status?: unknown } | undefined
    if (step?.status === "failed") return stage
  }
  return null
}

/**
 * How many times a failing run executed its failing step, which is what Python
 * passed as `attempts` (ARQ's `job_try`). Derived the same way
 * `failure-recorder.ts` derives it, from the engine's retry policy, because the
 * snapshot does not count executions.
 */
function executionsBeforeFailure(): number {
  return (pipelineWorkflow.retryConfig?.attempts ?? 0) + 1
}

/**
 * Every permanently failed `pipeline` run, newest first, unscoped.
 *
 * Scoping is the caller's job: nothing on a run row identifies the owning user,
 * so the only way to it is through the post the run names.
 */
export async function listFailedRuns(): Promise<FailedRun[]> {
  const storage = mastra.getStorage()
  const workflows = await storage?.getStore("workflows")
  if (!workflows) throw new Error("Mastra has no workflow storage configured")

  const { runs } = await workflows.listWorkflowRuns({
    workflowName: pipelineWorkflow.id,
    status: "failed",
  })

  const attempts = executionsBeforeFailure()
  const entries: FailedRun[] = []
  for (const run of runs) {
    const snapshot = parseSnapshot(run.snapshot)
    if (!snapshot) continue
    const postId = postIdOf(snapshot)
    if (!postId) continue
    entries.push({
      runId: run.runId,
      postId,
      stage: failedStageOf(snapshot),
      error: messageOf(snapshot.error),
      attempts,
      failedAt: new Date(run.updatedAt).toISOString(),
    })
  }
  return entries
}

/**
 * Which of a caller's failed runs are still dead-letter entries.
 *
 * Python's DLQ was an operator inbox: an entry sat in the Redis list until
 * someone retried it or cleared the list. `listFailedRuns` has no such
 * dimension, because a run row is a permanent record of a run and not an
 * inbox; every failure that ever happened is on it forever.
 *
 * The acknowledgement is read off the post instead, from the `_error` entry
 * `markPipelineFailed()` merges into `stage_logs`. That is not an invented
 * marker: `retry_dead_letter()` in `api/src/api/queue.py:193` pops exactly this
 * key as part of a retry, so `_error` was already Python's own per-post record
 * of an unhandled failure. It kept a second copy in Redis; this port keeps one.
 *
 * So an entry is a failed `pipeline` run whose post the caller owns *and*
 * whose post still carries `_error`. Popping `_error` retires the entry, which
 * is what `POST /dead-letter/{post_id}/retry` does, and the run row survives
 * for Studio and for the run history.
 *
 * One divergence follows and is deliberate. A post that fails, is retried, and
 * fails again carries `_error` once but has two failed run rows, so it reports
 * two entries where Python reported one (the retry had deleted the first). The
 * entries are the runs that really failed, which is the more honest answer, and
 * the alternative (deleting the engine's run row on retry) trades the run
 * history away to get it.
 */
export async function listDeadLetterEntries(userId: string): Promise<FailedRun[]> {
  const runs = await listFailedRuns()
  if (runs.length === 0) return []

  const open = await getDb()
    .select({ id: posts.id })
    .from(posts)
    .innerJoin(websiteProfiles, eq(posts.profileId, websiteProfiles.id))
    .where(
      and(
        eq(websiteProfiles.userId, userId),
        inArray(posts.id, [...new Set(runs.map((run) => run.postId))]),
        // `jsonb_exists(...)` rather than the `?` operator, which Drizzle would
        // hand to node-postgres inside a statement that also carries `$n`
        // placeholders.
        sql`jsonb_exists(coalesce(${posts.stageLogs}, '{}'::jsonb), '_error')`,
      ),
    )
  const mine = new Set(open.map((row) => row.id))
  return runs.filter((run) => mine.has(run.postId))
}
