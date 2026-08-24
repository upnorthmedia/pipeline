/**
 * The run trace: what the pipeline did to one post, per stage, with the money
 * and the time it took.
 *
 * **Where the numbers come from.** Each stage's step calls its agent through
 * Mastra and reads `result.usage` off the answer; `announceStageComplete()` in
 * `web/src/mastra/steps/stage-io.ts` writes those counts, the model id, the
 * measured duration and the priced estimate into the post's `execution_logs`
 * column, and `GET /api/posts/{id}` serves that column straight through. So the
 * trace is Mastra's own usage accounting, read back off the row the worker
 * wrote it to rather than off an in-process stream: the steps execute in the
 * `worker` service and the dashboard is served by `web`, and Mastra's per-run
 * watch events are published `localOnly` (see the note in
 * `web/src/mastra/pipeline-events.ts`), so `web` never sees them.
 *
 * **What makes it live.** `posts/[id]/page.tsx` refetches the post on every
 * `stage_complete`, `stage_error` and `pipeline_complete` SSE frame, so a
 * finished stage's numbers land within one round trip of the event. The stage
 * that is still running has no numbers yet by definition; what it has is a
 * start time, and the caller passes `liveStart` so the elapsed clock can run
 * from the `stage_start` frame rather than waiting for a refetch to reveal the
 * matching row entry.
 *
 * **Cost is an estimate and is not this module's arithmetic.** `cost_usd` is
 * stored per entry by the pipeline, priced at the reported model's published
 * per-million-token rate (see `stageCostUsd`, and note that a model with no
 * published rate prices at zero). The trace sums what is stored rather than
 * repricing, so the run total and the per-stage lines cannot disagree with the
 * analytics endpoints. Entries written before ledger item P2.38 carry an
 * Opus-rate number for every stage, which for `research` and `images` is an
 * overestimate the trace faithfully sums.
 */
import { STAGES, type PipelineStage, type StageStatus, type StageStatusMap } from "./api"
import { publishFailureReason, publishTargetOfMessage } from "./publish-report"
import type { PublishTarget } from "./publishing"

/**
 * The five states a stage can be in on the trace, which are the five
 * `stage_status` holds. An alias rather than a second copy of the union: this
 * file used to spell it out again, so widening one would have left the other.
 *
 * `review` is the suspension: `markStageForReview()` writes it to
 * `stage_status` when a step hands its gate payload to `suspend()`, and it is
 * the one status a browser cannot infer from the content columns, since a
 * stage parked in front of a reviewer has produced nothing yet.
 */
export type TraceStatus = StageStatus

/** One `retry` entry: an attempt that threw while the engine still had attempts left. */
export interface TraceRetry {
  attempt: number
  maxAttempts: number | null
  error: string | null
}

export interface StageTrace {
  stage: PipelineStage
  status: TraceStatus
  /** The provider model id the stage reported, or `null` before it has run. */
  model: string | null
  tokensIn: number
  tokensOut: number
  costUsd: number
  /** The stage's own measured duration in seconds, or `null` while it is unfinished. */
  durationS: number | null
  /** ISO timestamp the current attempt started, for the elapsed clock. */
  startedAt: string | null
  retries: TraceRetry[]
  /** The failure text recorded against this stage, if it failed. */
  error: string | null
}

/**
 * The publish leg: the last thing a run does and the one most likely to fail
 * on something outside this app.
 *
 * It is not a stage. It runs in its own workflow (`wordpress-publish` or
 * `nextjs-publish`), it is started by hand from the post page, it has no
 * agent behind it and so no model, no tokens and no cost, and its status
 * lives in `posts.wp_publish_status` / `posts.nextjs_publish_status` rather
 * than in `stage_status`. What it shares with a stage is the shape of its
 * account: a status the row owns, and an `execution_logs` trail behind it
 * saying when it started, how long it took and what went wrong.
 */
export interface PublishTrace {
  target: PublishTarget
  /**
   * The four the two status columns hold, mapped onto the stage vocabulary so
   * the table reads one set of words: `publishing` is `running`, `published`
   * is `complete`.
   */
  status: Extract<TraceStatus, "pending" | "running" | "complete" | "failed">
  /** ISO timestamp of the latest attempt's `publish_start` entry. */
  startedAt: string | null
  /** Wall clock across the latest finished attempt, since no step measures it. */
  durationS: number | null
  /**
   * The reason the latest attempt failed, with the destination prefix off the
   * front. Null unless the last publish entry on the row is that failure: a
   * retry that succeeded leaves the earlier failure's entry in place forever.
   */
  error: string | null
}

export interface RunTrace {
  stages: StageTrace[]
  totals: {
    tokensIn: number
    tokensOut: number
    costUsd: number
    /** Sum of the stages' own durations, not wall clock: gates and queue time are not stage time. */
    durationS: number
  }
  /**
   * The publish leg, or null for a post whose `output_format` names no
   * destination. The caller decides that, because the format is on the post
   * row and this module is given the log.
   */
  publish: PublishTrace | null
  /**
   * A failure that named no stage. `recordRunFailure()` sends `""` when the
   * engine's terminal event does not identify the step that threw, and that
   * text is the only account of the failure there is, so it is surfaced at the
   * run level rather than dropped.
   */
  runError: string | null
}

/** One row of the `execution_logs` array, as the API serves it. */
interface LogEntry {
  ts?: unknown
  stage?: unknown
  level?: unknown
  event?: unknown
  message?: unknown
  data?: unknown
}

function isStage(value: unknown): value is PipelineStage {
  return typeof value === "string" && (STAGES as string[]).includes(value)
}

function entryOf(value: unknown): LogEntry | null {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return null
  return value as LogEntry
}

function dataOf(entry: LogEntry): Record<string, unknown> {
  const data = entry.data
  if (typeof data !== "object" || data === null || Array.isArray(data)) return {}
  return data as Record<string, unknown>
}

function numberOf(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null
}

function textOf(value: unknown): string | null {
  return typeof value === "string" && value.length > 0 ? value : null
}

function emptyStage(stage: PipelineStage): StageTrace {
  return {
    stage,
    status: "pending",
    model: null,
    tokensIn: 0,
    tokensOut: 0,
    costUsd: 0,
    durationS: null,
    startedAt: null,
    retries: [],
    error: null,
  }
}

/**
 * Reset a stage's per-attempt measurements without losing its retry history.
 *
 * A stage can start more than once on one row: the engine re-runs the whole
 * step on a retry, and the dashboard's rerun button starts it again days
 * later. Either way the numbers from the previous attempt are stale the moment
 * a new `stage_start` lands, so they are cleared. Whether the retries go with
 * them is decided by the caller, because that is exactly what separates the two
 * cases: an engine retry writes a `retry` entry immediately before the
 * `stage_start` it causes, and nothing else does.
 */
function restartStage(row: StageTrace, ts: string | null, keepRetries: boolean): void {
  row.model = null
  row.tokensIn = 0
  row.tokensOut = 0
  row.costUsd = 0
  row.durationS = null
  row.error = null
  row.startedAt = ts
  if (!keepRetries) row.retries = []
}

/** The four values `wp_publish_status` and `nextjs_publish_status` hold. */
const PUBLISH_COLUMN_STATUS: Record<string, PublishTrace["status"]> = {
  pending: "pending",
  publishing: "running",
  published: "complete",
  failed: "failed",
}

/** One attempt at a destination, as its `execution_logs` entries describe it. */
interface PublishAttempt {
  target: PublishTarget | null
  startedAt: string | null
  finishedAt: string | null
  error: string | null
}

function publishTargetOf(entry: LogEntry, data: Record<string, unknown>): PublishTarget | null {
  if (data.target === "wordpress" || data.target === "nextjs") return data.target
  return publishTargetOfMessage(entry.message)
}

/** Whole seconds where the gap is whole, so a nine second publish reads `9.0s`. */
function secondsBetween(from: string | null, to: string | null): number | null {
  if (!from || !to) return null
  const started = Date.parse(from)
  const ended = Date.parse(to)
  if (Number.isNaN(started) || Number.isNaN(ended) || ended < started) return null
  return Number(((ended - started) / 1000).toFixed(2))
}

/**
 * Fold a post's `execution_logs` into one row per stage.
 *
 * Entries are applied in stored order and later ones win, so a stage rerun
 * shows the rerun's numbers rather than the sum of every run the row has ever
 * seen. `stage_status` decides the status rather than the log, because the row
 * is the pipeline's own record of where it is and the log is an audit trail
 * behind it; the log supplies what the status cannot say, which is how long,
 * how many tokens, how much, and what went wrong.
 */
export function buildRunTrace(input: {
  entries: readonly unknown[]
  stageStatus: StageStatusMap
  /** The stage of the most recent `stage_start` SSE frame, before any refetch reveals its entry. */
  liveStart?: { stage: PipelineStage; at: string } | null
  /**
   * The destination this post's `output_format` names and what its status
   * column says about the last attempt, or null for a format that publishes
   * nowhere. Read off the row for the same reason `stageStatus` is: the column
   * is the pipeline's own record and the log is the audit trail behind it.
   */
  publish?: { target: PublishTarget; status: string } | null
}): RunTrace {
  const rows = new Map<PipelineStage, StageTrace>(
    STAGES.map((stage) => [stage, emptyStage(stage)]),
  )
  let runError: string | null = null
  let publishAttempt: PublishAttempt | null = null
  const lastEventFor = new Map<PipelineStage, string>()

  for (const raw of input.entries) {
    const entry = entryOf(raw)
    if (!entry) continue
    const event = typeof entry.event === "string" ? entry.event : ""
    const ts = textOf(entry.ts)
    const data = dataOf(entry)

    if (!isStage(entry.stage)) {
      // A failure the engine could not pin on a step. Its text is still the
      // only account of why the run stopped.
      if (event === "stage_error") runError = textOf(data.error) ?? textOf(entry.message)
      // Both publish steps write `stage: ""`, so this is where their trail
      // arrives. A `publish_start` opens a fresh attempt and discards the
      // previous one's measurements, exactly as `stage_start` does.
      if (event === "publish_start") {
        publishAttempt = {
          target: publishTargetOf(entry, data),
          startedAt: ts,
          finishedAt: null,
          error: null,
        }
      } else if (event === "publish_complete" || event === "publish_error") {
        const target = publishTargetOf(entry, data)
        // A terminal entry with no start before it: every row stored before
        // the steps began writing `publish_start` looks like this.
        if (!publishAttempt || (target !== null && publishAttempt.target !== target)) {
          publishAttempt = { target, startedAt: null, finishedAt: null, error: null }
        }
        publishAttempt.finishedAt = ts
        publishAttempt.error =
          event === "publish_error"
            ? (publishFailureReason(entry.message) ?? textOf(data.error))
            : null
      }
      continue
    }
    const row = rows.get(entry.stage) as StageTrace

    switch (event) {
      case "stage_start":
        restartStage(row, ts, lastEventFor.get(entry.stage) === "retry")
        break
      case "stage_complete":
        row.model = textOf(data.model)
        row.tokensIn = numberOf(data.tokens_in) ?? 0
        row.tokensOut = numberOf(data.tokens_out) ?? 0
        row.costUsd = numberOf(data.cost_usd) ?? 0
        row.durationS = numberOf(data.duration_s)
        row.error = null
        break
      case "retry":
        row.retries.push({
          attempt: numberOf(data.attempt) ?? row.retries.length + 1,
          maxAttempts: numberOf(data.max_attempts),
          error: textOf(data.error),
        })
        break
      case "stage_error":
        row.error = textOf(data.error) ?? textOf(entry.message)
        break
      default:
        break
    }
    lastEventFor.set(entry.stage, event)
  }

  const live = input.liveStart
  for (const stage of STAGES) {
    const row = rows.get(stage) as StageTrace
    row.status = (input.stageStatus[stage] as TraceStatus | undefined) ?? "pending"
    // A measurement the row has since disowned. `POST /rerun` resets a stage
    // and everything downstream of it to `pending` and clears their content
    // columns, but `execution_logs` is append-only, so the previous attempt's
    // `stage_complete` entry is still the last thing the log says about the
    // stage. Showing its model, tokens, duration and cost against a stage that
    // is queued or back on the provider is not stale by a round trip: it is a
    // number for work whose output has already been deleted, and it would be
    // counted into the run total twice over the rerun.
    if (
      lastEventFor.get(stage) === "stage_complete" &&
      row.status !== "complete" &&
      row.status !== "failed"
    ) {
      restartStage(row, null, true)
    }
    // The `stage_start` frame arrives before the refetch that would reveal its
    // stored entry, so a stage that has just started has a status and no start
    // time. Taking the frame's own arrival time keeps the elapsed clock honest
    // to within one round trip instead of leaving it blank until the stage ends.
    if (row.startedAt === null && live?.stage === stage) row.startedAt = live.at
  }

  const stages = STAGES.map((stage) => rows.get(stage) as StageTrace)
  return {
    stages,
    publish: buildPublishTrace(input.publish, publishAttempt),
    totals: {
      tokensIn: stages.reduce((sum, row) => sum + row.tokensIn, 0),
      tokensOut: stages.reduce((sum, row) => sum + row.tokensOut, 0),
      // Stored per entry at six decimal places, so the sum is summed at six
      // too rather than left carrying float noise into the rendered total.
      costUsd: Number(stages.reduce((sum, row) => sum + row.costUsd, 0).toFixed(6)),
      durationS: Number(stages.reduce((sum, row) => sum + (row.durationS ?? 0), 0).toFixed(2)),
    },
    runError,
  }
}

/**
 * The publish row, from the column the page read and the trail this run left.
 *
 * An attempt is only attributed to the destination on screen: nothing clears
 * the other destination's status column, so a post that changed format still
 * carries the old one's entries and timing them against the new one would be
 * a fabrication. An entry that names no destination (stored before the steps
 * wrote `data.target`, with a message carrying no prefix either) is taken as
 * this one's, since it is the only account there is.
 */
function buildPublishTrace(
  column: { target: PublishTarget; status: string } | null | undefined,
  attempt: PublishAttempt | null,
): PublishTrace | null {
  if (!column) return null
  const status = PUBLISH_COLUMN_STATUS[column.status] ?? "pending"
  const mine = attempt && (attempt.target === null || attempt.target === column.target)
  if (!mine || !attempt) {
    return { target: column.target, status, startedAt: null, durationS: null, error: null }
  }
  return {
    target: column.target,
    status,
    startedAt: attempt.startedAt,
    durationS: secondsBetween(attempt.startedAt, attempt.finishedAt),
    error: attempt.error,
  }
}
