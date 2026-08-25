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
 * **Cost is mostly an estimate and is never this module's arithmetic.**
 * `cost_usd` is stored per entry by the pipeline. For four of the six stages it
 * is priced at the reported model's published per-million-token rate (see
 * `stageCostUsd`, and note that a model with no published rate prices at zero);
 * for `research` it is the price Perplexity's Agent API put on the call itself,
 * which is the only stage whose bill a per-token table cannot reconstruct
 * (P2.71b-ii). The trace sums what is stored rather than repricing, so the run
 * total and the per-stage lines cannot disagree with the analytics endpoints.
 * Entries written before ledger item P2.38 carry an Opus-rate number for every
 * stage, which for `research` and `images` is an overestimate the trace
 * faithfully sums.
 */
import { STAGES, type PipelineStage, type StageStatus, type StageStatusMap } from "./api"
import {
  publishFailureReason,
  publishTargetOfMessage,
  type PublishStall,
} from "./publish-report"
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

/**
 * What the `images` fan-out has produced so far, counted per manifest entry.
 *
 * The stage publishes one `image_generated` or `image_failed` line per entry
 * (`web/src/mastra/steps/images-generate.ts`), and it is the only stage whose
 * work is a fan-out: "running" hides how much of it is done, and "complete"
 * hides that some of it failed. Counted by index rather than by entry, because
 * a retried image publishes a failure and then a success for the same one.
 */
export interface ImageProgress {
  generated: number
  failed: number
}

/**
 * One per-image outcome as it arrives on the event bus, before any refetch
 * reveals the stored entry behind it. `index` is the manifest position the
 * event carried, or null for an event that carried none.
 */
export interface LiveImage {
  index: number | null
  outcome: "generated" | "failed"
}

/**
 * The wait a review gate imposed on one stage.
 *
 * A gate is the one thing that happens to a run that costs no tokens and
 * leaves no output, so before ledger item P4.5 it left no trace at all: the
 * suspend published a `stage_review` frame and wrote nothing to the row, and a
 * reader who opened the post after the reviewer released it saw a run that
 * looked like it had gone straight through. `reviewGate()` now stores the
 * entry, and the release is the `stage_start` behind it, since the only way
 * out of a gate is through it.
 */
export interface TraceReview {
  /** ISO timestamp the run parked at the gate. */
  at: string | null
  /** ISO timestamp the released stage started, or null while it is still parked. */
  releasedAt: string | null
  /** Seconds between the two, or null while the gate is still holding the run. */
  waitedS: number | null
}

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
  /**
   * Per-image counts for `images`, or null for every other stage and for an
   * `images` stage that has published no per-image line yet.
   */
  images: ImageProgress | null
  /** The review gate this attempt waited at, or null for a stage that never gated. */
  review: TraceReview | null
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
  /**
   * Set when the attempt this row describes has stopped moving. `status` still
   * reads `running` under it, because the column the worker owns still says
   * `publishing` and this module does not overwrite the row's own record; what
   * changes is that a reader with a stall in hand must not present the leg as
   * making progress.
   *
   * Decided by the caller rather than here: the clock it needs is `updated_at`
   * on the post row, which this module is not given, and the page holding it
   * also renders the banner, so the two accounts come from one derivation.
   */
  stall: PublishStall | null
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
    images: null,
    review: null,
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

/**
 * The key a per-image outcome is stored under: its manifest position, or a
 * fresh key for an event that carried none.
 */
function imageKey(index: unknown, nextKeyless: () => number): string {
  const position = numberOf(index)
  return position === null ? `unindexed:${nextKeyless()}` : `index:${position}`
}

/** True when `at` is a later instant than `than`, and when there is no `than` at all. */
function isAfter(at: string, than: string | null): boolean {
  if (than === null) return true
  const left = Date.parse(at)
  const right = Date.parse(than)
  if (Number.isNaN(left) || Number.isNaN(right)) return false
  return left > right
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
  publish?: { target: PublishTarget; status: string; stall?: PublishStall | null } | null
  /**
   * The per-image frames this page has seen since the `images` stage started,
   * for the same reason `liveStart` exists: the fan-out's lines reach the
   * browser one at a time and nothing refetches the row until the stage ends.
   */
  liveImages?: readonly LiveImage[]
}): RunTrace {
  const rows = new Map<PipelineStage, StageTrace>(
    STAGES.map((stage) => [stage, emptyStage(stage)]),
  )
  let runError: string | null = null
  let publishAttempt: PublishAttempt | null = null
  const lastEventFor = new Map<PipelineStage, string>()
  // Manifest position -> its latest outcome, so a retried image counts once.
  // An entry that carried no index gets a key of its own rather than
  // overwriting the previous one: two failures with nothing to tell them apart
  // are still two failures.
  const imageOutcomes = new Map<string, LiveImage["outcome"]>()
  let keylessImages = 0
  let imagesStartedAt: string | null = null

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
      case "stage_review":
        row.review = { at: ts, releasedAt: null, waitedS: null }
        break
      case "stage_start": {
        // An engine retry is the same attempt one failure later, so it keeps
        // both the retry history and the gate this attempt waited at. Any
        // other restart is the rerun button, which names its stages and so
        // never gates: carrying the old wait onto it would put a four minute
        // review against an attempt nobody reviewed, which is the argument
        // `restartStage` already makes about the previous attempt's numbers.
        const retrying = lastEventFor.get(entry.stage) === "retry"
        restartStage(row, ts, retrying)
        // The release is this entry. Nothing writes one of its own, and
        // nothing needs to: the only way out of a gate is through it, so the
        // stage starting is the reviewer having said yes.
        if (row.review && row.review.releasedAt === null) {
          row.review.releasedAt = ts
          row.review.waitedS = secondsBetween(row.review.at, ts)
        } else if (!retrying) {
          row.review = null
        }
        if (entry.stage === "images") {
          imageOutcomes.clear()
          keylessImages = 0
          imagesStartedAt = ts
        }
        break
      }
      case "image_generated":
      case "image_failed":
        imageOutcomes.set(
          imageKey(data.index, () => keylessImages++),
          event === "image_generated" ? "generated" : "failed",
        )
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
      // The same argument for the fan-out's counts: they describe images whose
      // files the rerun has already deleted.
      if (stage === "images") imageOutcomes.clear()
    }
    // The `stage_start` frame arrives before the refetch that would reveal its
    // stored entry, so a stage that has just started has a status and no start
    // time. Taking the frame's own arrival time keeps the elapsed clock honest
    // to within one round trip instead of leaving it blank until the stage ends.
    if (row.startedAt === null && live?.stage === stage) row.startedAt = live.at
  }

  // The live frames land on top of the stored ones, keyed the same way, so an
  // image that is in both counts once. They are dropped along with the stored
  // trail only when the trail belongs to an attempt this page has already seen
  // superseded: a `stage_start` frame for `images` that is newer than the last
  // stored one is the retry button, whose earlier images are gone.
  const imagesRow = rows.get("images") as StageTrace
  if (live?.stage === "images" && isAfter(live.at, imagesStartedAt)) imageOutcomes.clear()
  for (const item of input.liveImages ?? []) {
    imageOutcomes.set(imageKey(item.index, () => keylessImages++), item.outcome)
  }
  if (imageOutcomes.size > 0) {
    const outcomes = [...imageOutcomes.values()]
    imagesRow.images = {
      generated: outcomes.filter((outcome) => outcome === "generated").length,
      failed: outcomes.filter((outcome) => outcome === "failed").length,
    }
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
  column: { target: PublishTarget; status: string; stall?: PublishStall | null } | null | undefined,
  attempt: PublishAttempt | null,
): PublishTrace | null {
  if (!column) return null
  const status = PUBLISH_COLUMN_STATUS[column.status] ?? "pending"
  const stall = column.stall ?? null
  const mine = attempt && (attempt.target === null || attempt.target === column.target)
  if (!mine || !attempt) {
    return { target: column.target, status, startedAt: null, durationS: null, error: null, stall }
  }
  return {
    target: column.target,
    status,
    startedAt: attempt.startedAt,
    durationS: secondsBetween(attempt.startedAt, attempt.finishedAt),
    error: attempt.error,
    stall,
  }
}
