/**
 * The input and output contract shared by all six stage steps.
 *
 * A step is handed a post id, not the post's content: it reads its inputs from
 * the columns the previous steps committed and writes its own output back to a
 * column before returning. That keeps the workflow snapshot small and, more
 * importantly, means a resumed run rebuilds state from the table rather than
 * from anything a dead process was holding.
 *
 * The output is Python's `_stage_meta` plus the post id, so the next step in
 * the chain receives a valid input without a mapping step between them.
 *
 * `stages` is the run's selection, Python's `stages` argument to
 * `_run_pipeline()`. It is declared on both the input and the output because
 * the evented engine hands each step the previous step's output parsed against
 * the next step's input schema, so anything not declared on both is dropped
 * between stages. Carrying it in the data flow rather than in a runtime context
 * also means it lives in the persisted workflow snapshot, so a run resumed in
 * another process after a crash still knows which stages it was asked to run.
 */
import type { PubSub } from "@mastra/core/events"
import { z } from "zod"

import { STAGE_LABELS } from "../../lib/stages"
import { pythonRound } from "../analytics/python-round"
import { appendExecutionLog, nowIso, stageCostUsd } from "../execution-log"
import type { LogLevel } from "../execution-log"
import { publishPipelineEvent } from "../pipeline-events"
import {
  markCompleteIfAllStagesComplete,
  markStageForReview,
  markStageRunning,
} from "../post-state"
import { settingsUserIdForPost, stageRequestContext } from "../stage-models"
import { CURRENT_STAGE_PAUSED, MAX_ATTEMPTS, STAGES, STATUS_COMPLETE } from "../state"
import type { Stage } from "../state"

/**
 * The stages a run should execute.
 *
 * Absent means Python's full pipeline: every stage not already marked complete.
 * Present means Python's `stages=[...]` call, which runs exactly those stages
 * and, deliberately, does not consult `stage_status` first, so a completed
 * stage can be rerun on its own from the dashboard.
 */
const stageSelectionSchema = z.array(z.enum(STAGES)).min(1).optional()

export const stageStepInputSchema = z.object({
  postId: z.uuid(),
  stages: stageSelectionSchema,
})

export type StageStepInput = z.infer<typeof stageStepInputSchema>

export const stageStepOutputSchema = z.object({
  postId: z.uuid(),
  stages: stageSelectionSchema,
  stage: z.enum(STAGES),
  /** The model id the provider reported running, not the one requested. */
  model: z.string(),
  tokensIn: z.number().int().nonnegative(),
  tokensOut: z.number().int().nonnegative(),
  durationS: z.number().nonnegative(),
  /**
   * What the provider itself said the call cost, in USD, when it says so.
   *
   * Only Perplexity's Agent API does, and it is the only stage whose bill the
   * per-token table cannot reconstruct: `web_search` is billed per invocation
   * on top of the tokens. Absent for every other stage, which keeps the
   * estimate. Ledger item P2.71b-ii.
   */
  reportedCostUsd: z.number().nonnegative().optional(),
  /**
   * True when the step returned without calling its provider, which is the
   * `continue` in Python's stage loop. A skipped stage bills nothing, writes
   * nothing and reports no meta, so the zeroed fields below are not a
   * measurement, they are the absence of one.
   */
  skipped: z.boolean(),
})

export type StageStepOutput = z.infer<typeof stageStepOutputSchema>

/**
 * Python's two skip rules, in the one place both of them can be read together.
 *
 * A selected run (`stages` present) runs exactly what it was asked for. A full
 * run skips whatever `stage_status` already calls complete, which is what makes
 * "resume from where it stopped" the default and what stops a restarted worker
 * re-billing stages that already committed their column.
 */
export function shouldRunStage(
  stage: Stage,
  input: StageStepInput,
  stageStatus: Record<string, string>,
): boolean {
  if (input.stages) return input.stages.includes(stage)
  return stageStatus[stage] !== STATUS_COMPLETE
}

/**
 * Python's single-stage rerun completion check, run by every stage right after
 * it commits its column.
 *
 * A full run ends at a completion hook that settles `current_stage` for it. A
 * run that names its stages never reaches that hook, so Python re-read
 * `stage_status` after each named stage and promoted `current_stage` the moment
 * the selection filled the last gap. Without it, rerunning `edit` on an
 * otherwise finished post would leave the row reading `current_stage = "edit"`
 * for good and the dashboard would keep calling the post unfinished.
 *
 * The gate is the selection, not the stage: a full run promotes nothing here,
 * because promoting `current_stage` without the hook's `completed_at` and
 * publish queueing would leave the post half-finished in a way no reader could
 * tell apart from finished.
 */
export async function markRerunComplete(input: StageStepInput): Promise<boolean> {
  if (!input.stages) return false
  return await markCompleteIfAllStagesComplete(input.postId)
}

/**
 * The two `stage_settings` values that park a run in front of a stage, from the
 * gate branch of Python's `_run_pipeline()`. Everything else, `"auto"`
 * included, runs unattended.
 */
export const REVIEW_MODES = ["review", "approve_only"] as const

export type ReviewMode = (typeof REVIEW_MODES)[number]

/**
 * The mode a stage with no entry in `stage_settings` is treated as having.
 *
 * Python read the column with `.get(stage, "review")`, so an unconfigured stage
 * fails safe towards the human rather than towards the provider's bill.
 */
export const DEFAULT_GATE_MODE: ReviewMode = "review"

/** What the reviewer is shown while the run waits. */
export const gateSuspendSchema = z.object({
  stage: z.enum(STAGES),
  /** The configured mode that paused the run, so the two are distinguishable. */
  mode: z.enum(REVIEW_MODES),
  /** Python's pause message, the same string its SSE event carried. */
  message: z.string(),
})

export type GateSuspendPayload = z.infer<typeof gateSuspendSchema>

/**
 * What resuming a gate says.
 *
 * A literal rather than a boolean: the only thing a gate can be told is that it
 * passed. Python had no reject branch at all (its pause was a bare `return`),
 * and a run whose reviewer says no is cancelled with `run.cancel()`, which
 * releases the run rather than leaving a declined one parked forever.
 */
export const gateResumeSchema = z.object({ approved: z.literal(true) })

export type GateResume = z.infer<typeof gateResumeSchema>

/** The mode configured for a stage, with Python's fail-safe default. */
export function gateModeFor(stage: Stage, stageSettings: Record<string, string>): string {
  return stageSettings[stage] ?? DEFAULT_GATE_MODE
}

/**
 * Whether a stage must wait for a human before it runs.
 *
 * A run that names its stages never waits: that is Python's `check_gates=False`
 * on the single-stage path, and it is what makes the dashboard's rerun button
 * an approval in itself rather than a request for one.
 */
export function stageNeedsReview(
  stage: Stage,
  input: StageStepInput,
  stageSettings: Record<string, string>,
): boolean {
  if (input.stages) return false
  return (REVIEW_MODES as readonly string[]).includes(gateModeFor(stage, stageSettings))
}

/**
 * Park the run at this stage's gate, or let it through.
 *
 * Returns the payload the step should hand to `suspend()`, or `null` when the
 * stage may run. The row is parked here rather than in the step because every
 * one of the six pauses identically, and because the write has to land before
 * the suspend: the dashboard reads the row, not the workflow snapshot.
 *
 * `resumeData` short-circuits it. The step re-runs from the top when a run is
 * resumed, so without that check an approved gate would immediately re-suspend
 * itself on the same settings that paused it in the first place.
 *
 * `retryCount` short-circuits it for the same reason one attempt later, and it
 * is the half `resumeData` cannot cover: the engine does not carry the resume
 * payload into its retry branch, so an approved stage that then *throws*
 * re-enters `execute` with `resumeData` undefined and parks the run at the gate
 * the reviewer just released. Observed in a browser on a real run under ledger
 * item P2.109b, with the row going `review` -> `running` -> `review` while the
 * provider call failed in between. A retry is not a fresh execution: reaching
 * it at all means this run already passed this gate, since the only way out of
 * the gate is through it.
 */
export async function reviewGate(
  mastra: { pubsub: PubSub },
  stage: Stage,
  input: StageStepInput,
  stageSettings: Record<string, string>,
  resumeData?: GateResume,
  retryCount?: number,
): Promise<GateSuspendPayload | null> {
  if (resumeData?.approved) return null
  if ((retryCount ?? 0) > 0) return null
  if (!stageNeedsReview(stage, input, stageSettings)) return null

  const mode = gateModeFor(stage, stageSettings) as ReviewMode
  const message = `Stage ${stage} paused for review`
  await markStageForReview(input.postId, stage)
  // Row first, then the event, for the same reason `announceStageStart` does
  // it in that order: a browser reacts to the frame by refetching the post and
  // must not read a row that still calls the stage pending.
  //
  // Without this frame nothing on screen learns the run has parked. The
  // dashboard has no poll: it refetches on `stage_complete`, `stage_error` and
  // `pipeline_complete`, and a suspend is none of the three, so a gate stayed
  // invisible until the reader reloaded the page by hand. Measured in a
  // browser under ledger item P2.109b.
  await publishPipelineEvent(mastra.pubsub, input.postId, "stage_review", {
    stage,
    mode,
    message,
  })
  return { stage, mode, message }
}

/**
 * Stop the run here if an operator has paused the post.
 *
 * Returns the output the step should `bail()` with, or `null` when the run may
 * carry on. Ledger item P2.115: until this existed, pausing was a label. The
 * pause endpoints write `current_stage = "paused"` and nothing else, nothing in
 * the worker read it, and so the stage in flight finished, the next one started
 * and the six-stage run went all the way to `complete` while the dashboard's
 * badge said `Paused`. Every stage after the button press was billed to a
 * provider the operator had just asked to stop.
 *
 * The check sits with the review gate, before anything the stage spends, for
 * the same reason the gate does: a stopped stage must bill nothing. That makes
 * the pause a stage-boundary signal rather than an interrupt. The stage that
 * was executing when the button was pressed runs to completion and commits its
 * column, which is deliberate: killing a provider call mid-flight would pay for
 * the tokens and throw the answer away, and `deriveRunState()` says so on
 * screen ("Pausing", naming the stage that is finishing) rather than claiming
 * the run has already stopped.
 *
 * `bail()` rather than a thrown error or a `suspend()`. A pause is not a
 * failure, so the run must not be retried, must not be stamped
 * `current_stage = "failed"` and must not reach `pipeline-complete`, which
 * would stamp it complete over the operator's pause. It is not a suspend
 * either: a suspended run holds a snapshot open for a resume that may never
 * come, and `resume-all` restarts the pipeline rather than resuming a handle.
 * `bail()` ends the run cleanly at this step, leaving `current_stage` where the
 * operator put it and `stage_status` recording exactly what committed.
 *
 * Reading `state.currentStage` is what makes every start endpoint a release:
 * `/run`, `/rerun`, `/restart`, `/run-all`, `resume-all` and the dead-letter
 * retry all write `current_stage` before they start anything, so a started run
 * never sees the pause it was started to clear.
 */
export async function pauseGate(
  mastra: StageLogContext,
  stage: Stage,
  input: StageStepInput,
  state: { currentStage: string },
): Promise<StageStepOutput | null> {
  if (state.currentStage !== CURRENT_STAGE_PAUSED) return null

  await publishStageLog(
    mastra,
    input.postId,
    stage,
    `Run paused before ${STAGE_LABELS[stage]}. Nothing after this point ran.`,
    { level: "warning" },
  )
  return skippedStageOutput(input, stage)
}

/**
 * Announce that a stage is starting, ported from the two statements Python ran
 * between its skip check and its node call: commit `"running"` to the row, then
 * publish `stage_start`.
 *
 * The order is the port's, not an accident of writing. Python's own comment on
 * that block reads "SSE after DB is committed", because a browser that reacts
 * to the event by refetching the post must not read a row that still says the
 * previous stage. Publishing first would make that race routine rather than
 * rare, since the fetch is a round trip and the publish is not.
 *
 * Called after the gate rather than before it, in the same position Python's
 * block occupied relative to its `continue`: a stage that is skipped, and a
 * stage parked in front of a reviewer, are neither of them running, and neither
 * should announce that they are. `markStageForReview` already moves the row for
 * the gate case.
 *
 * Takes the transport off the `mastra` handed to `execute` rather than
 * importing the instance: `index.ts` imports the workflows, so a step that
 * imported it back would close the cycle and, worse, would publish onto a
 * different transport than the one the run is executing on whenever a test
 * builds its own instance.
 */
export async function announceStageStart(
  mastra: { pubsub: PubSub },
  stage: Stage,
  input: StageStepInput,
): Promise<void> {
  const message = `Starting ${stage}...`
  await markStageRunning(input.postId, stage)
  // Python wrote the row's audit entry inside the same session block as the
  // `"running"` write and before the publish, so the entry a browser goes
  // looking for after the event is already on the row. The message is the one
  // string, shared with the event rather than written out twice.
  await appendExecutionLog(input.postId, {
    stage,
    level: "info",
    event: "stage_start",
    message,
  })
  await publishPipelineEvent(mastra.pubsub, input.postId, "stage_start", {
    stage,
    message,
  })
}

/**
 * What `publishStageLog()` needs off the `mastra` handed to `execute`.
 *
 * The transport, and a logger for the one failure Python chose not to raise.
 * `getLogger` is optional because most of this module's helpers are driven in
 * tests by a hand-built `mastra` that only carries a `pubsub`.
 */
export interface StageLogContext {
  pubsub: PubSub
  getLogger?: () => { debug(message: string, ...args: unknown[]): void } | undefined
}

/** What a call site can vary; everything else is fixed by the stage and the message. */
export interface StageLogOptions {
  /** Python's `level="info"` default, which is what all 28 call sites take. */
  level?: LogLevel
  /** Python's `event="log"` default: the SSE event name `use-sse.ts` listens for. */
  event?: string
  /** Extra fields, carried onto both the event and the stored entry. */
  data?: Record<string, unknown>
}

/**
 * Python's `publish_stage_log()` from `api/src/pipeline/helpers.py:49`, the
 * progress line a stage writes about its own internals.
 *
 * The other three log-writing helpers in this module are about a stage as a
 * whole, and the runner wrote them. These are the 28 calls the six stage nodes
 * made from inside themselves: rules loaded, provider about to be called,
 * provider answered, this many links dropped. They are what fills
 * `debug-log-panel.tsx` between one `stage_start` and its `stage_complete`.
 *
 * **The module-level context is gone, and nothing replaces it.** Python's stage
 * nodes were handed a `PipelineState` dict and nothing else, so the runner
 * parked the Redis handle and the post id in module globals
 * (`set_event_context()` before the node call, `clear_event_context()` after)
 * for the node to read back. A Mastra step's `execute` already receives
 * `mastra`, so both are arguments here. That deletes Python's
 * "silently no-op when no context is set" branch along with the globals, which
 * is a real behaviour change: in Python a stage node called outside the runner
 * (which is to say, in a test) published nothing and stored nothing, where the
 * port always does both. It also deletes the failure mode the globals carried,
 * which is that two runs in one process shared one post id.
 *
 * **The publish comes first and the append may fail without stopping the
 * stage.** Both are Python's, and they are the opposite of the ordering
 * `announceStageStart` and `announceStageComplete` use. Those two write the row
 * first because a browser reacts to them by refetching the post; this one
 * carries its whole content in the payload, so there is nothing to refetch and
 * nothing to race. The `try` around the append is Python's own, and its reason
 * is that a progress line is not worth failing a paid-for provider call over:
 * `append_execution_log` raises on a database error, and every other caller
 * lets it.
 */
export async function publishStageLog(
  mastra: StageLogContext,
  postId: string,
  stage: Stage,
  message: string,
  options: StageLogOptions = {},
): Promise<void> {
  const { level = "info", event = "log", data } = options
  // Python's `**({"data": data} if data else {})`, false for an empty dict as
  // well as for None, so a call site that assembled nothing sends no `data` key
  // rather than an empty object.
  const hasData = data !== undefined && Object.keys(data).length > 0
  await publishPipelineEvent(mastra.pubsub, postId, event, {
    stage,
    message,
    level,
    timestamp: nowIso(),
    ...(hasData ? { data } : {}),
  })
  try {
    await appendExecutionLog(postId, { stage, level, event, message, data })
  } catch (error) {
    // Python's `logger.debug("Failed to persist execution log entry")`. Kept at
    // debug for the same reason: the event a browser needed has already gone
    // out, and the entry that did not land is a line in an audit trail rather
    // than any part of the stage's result.
    mastra.getLogger?.()?.debug("failed to persist execution log entry", {
      postId,
      stage,
      event,
      error,
    })
  }
}

/**
 * Python's `f"{seconds:.1f}"`, used by the progress line every stage writes
 * after its provider answers.
 *
 * `pythonRound` first, for the reason `roundSeconds` below records: a duration
 * is milliseconds divided by 1000, so every 250ms and 750ms boundary is an
 * exact tie at one decimal place, and Python resolves those to even while
 * `toFixed` resolves them away from zero. `2.25` renders `2.2` in Python and
 * `2.3` through `toFixed` alone.
 */
export function formatSeconds(seconds: number): string {
  return pythonRound(seconds, 1).toFixed(1)
}

/**
 * Python's `round(value, 2)` on a duration in seconds.
 *
 * The event carries a rounded number rather than the raw float because
 * `debug-log-panel.tsx` renders `duration_s` straight into the log line, and a
 * measured elapsed time is fifteen significant figures wide.
 *
 * `pythonRound` rather than `Math.round(value * 100) / 100`, because the same
 * measurement is now written twice: once into the event and once into the
 * `stage_complete` execution log entry. The two disagree on ties, and a
 * duration is milliseconds divided by 1000, so `0.125` and `0.375` are exact
 * ties that Python renders as `0.12` and `0.38` while `Math.round` renders as
 * `0.13` and `0.38`. Sharing one function keeps the number a browser is shown
 * and the number the row records from drifting apart.
 */
function roundSeconds(value: number): number {
  return pythonRound(value, 2)
}

/**
 * Announce that a stage finished, ported from the `publish_event` Python ran
 * immediately after the database block that saved the stage's output
 * (`api/src/worker.py:266`).
 *
 * Position matters the same way it does for the start announcement, and for
 * the same reason: `posts/[id]/page.tsx` refetches the post on `stage_complete`,
 * so the column and `stage_status` have to be committed before the event goes
 * out. Every call site therefore sits after `saveStageOutput` and after
 * `markRerunComplete`, which is where Python's publish sat relative to its own
 * two writes.
 *
 * Takes the output the step is about to return rather than the fields
 * separately, so what a browser is told and what the next step receives cannot
 * drift apart. `model` and `durationS` are the only two Python sent over SSE;
 * the token counts and the priced estimate go to the row's execution log, which
 * is the entry Python wrote from inside the same database block.
 *
 * A skipped stage announces nothing, because Python's `continue` jumped over
 * the publish along with the rest of the loop body. That is a property of where
 * this is called from: every step returns before it reaches this line.
 */
export async function announceStageComplete(
  mastra: { pubsub: PubSub },
  output: StageStepOutput,
): Promise<void> {
  const durationS = roundSeconds(output.durationS)
  await appendExecutionLog(output.postId, {
    stage: output.stage,
    level: "info",
    event: "stage_complete",
    message: `Stage ${output.stage} complete`,
    // Python's five keys, from `_stage_meta`. This is the only place the token
    // counts are recorded against the post: the SSE payload never carried them,
    // so a browser that was not open while the run executed reads them here.
    data: {
      model: output.model,
      tokens_in: output.tokensIn,
      tokens_out: output.tokensOut,
      duration_s: durationS,
      cost_usd: stageCostUsd(
        output.tokensIn,
        output.tokensOut,
        output.model,
        output.reportedCostUsd,
      ),
    },
  })
  await publishPipelineEvent(mastra.pubsub, output.postId, "stage_complete", {
    stage: output.stage,
    model: output.model,
    duration_s: durationS,
  })
}

/**
 * Python's `str(e)` on the exception that reached the runner's `except` block.
 *
 * A thrown `Error` reports its message and anything else is stringified, which
 * is the same pair of shapes `failure-recorder.ts` reads back off the engine's
 * serialised `prevResult.error`. Both records of one failure therefore carry
 * the same text.
 */
function errorText(error: unknown): string {
  if (error instanceof Error) return error.message
  return String(error)
}

/**
 * The gap between one attempt and the next, ported from
 * `WorkerSettings.retry_delay = 10` (`api/src/worker.py:610`).
 *
 * ARQ spent this in the queue, so the wait cost the worker nothing. Mastra's
 * evented processor has no counterpart: its only `retryConfig` reference is the
 * retry branch at `workflow-event-processor-Dp87-e6z.js:3434`, which reads
 * `attempts` and republishes `workflow.step.run` immediately, and the
 * `abortableSleep` helper beside it serves sleep steps only. A `delay` on the
 * workflow would read as honoured and would not be, so the spacing lives inside
 * the step instead, held before the error is rethrown.
 *
 * That is a real deviation and worth naming: the pause occupies the worker slot
 * where Python's occupied a queue score. `MAX_ATTEMPTS` is 3 and the delay only
 * precedes an attempt that actually follows, so the worst case is 20 seconds of
 * held slot per failing run, well inside the 15 minute `RECLAIM_IDLE_MS` after
 * which another consumer would claim the message.
 *
 * The point of it is the case Python was built for: a provider that answers 429
 * gets three requests in as many seconds otherwise, which is likely to spend
 * every attempt inside the same rate-limit window.
 */
export const RETRY_DELAY_MS = 10_000

/**
 * `RETRY_DELAY_MS`, or the `STAGE_RETRY_DELAY_MS` override.
 *
 * The override exists for the test suite, which sets it to `0` in
 * `vitest.config.ts`: five suites drive real failing runs through the engine's
 * retry branch, and every one of them would otherwise gain
 * `(MAX_ATTEMPTS - 1) * RETRY_DELAY_MS` on top of its own budget. Anything that
 * is not a non-negative number falls back to Python's value, so a typo in a
 * deployed environment loses the pause rather than the stage.
 */
export function retryDelayMs(env: Record<string, string | undefined> = process.env): number {
  const raw = env.STAGE_RETRY_DELAY_MS
  if (raw === undefined || raw.trim() === "") return RETRY_DELAY_MS
  const parsed = Number(raw)
  if (!Number.isFinite(parsed) || parsed < 0) return RETRY_DELAY_MS
  return parsed
}

/**
 * Wait out the gap between attempts, or return at once if the run is already
 * being torn down.
 *
 * `signal` is the step's own `abortSignal`. Without it a cancelled run, or a
 * worker being shut down, would sit here for ten seconds before rethrowing an
 * error whose retry nobody wants any more.
 */
function pauseBeforeRetry(signal?: AbortSignal): Promise<void> {
  const delay = retryDelayMs()
  if (delay <= 0 || signal?.aborted) return Promise.resolve()
  return new Promise((resolve) => {
    const finish = () => {
      clearTimeout(timer)
      signal?.removeEventListener("abort", finish)
      resolve()
    }
    const timer = setTimeout(finish, delay)
    signal?.addEventListener("abort", finish, { once: true })
  })
}

/**
 * The gap between attempts for a hook workflow (ledger item P2.95).
 *
 * `recordStageRetry()` below is the pipeline's version and cannot serve the
 * hooks: it writes a `retry` entry into a post's execution log, and only a
 * pipeline stage has both a `Stage` and a `postId` to write one under. The
 * nightly re-crawl check has neither. So the hooks get the pause on its own,
 * held before the error is rethrown for exactly the same reason, and under the
 * same gate: `MAX_ATTEMPTS` is the total, `retryCount` counts retries after the
 * first execution, so the pause is skipped on the attempt no retry follows.
 *
 * ARQ spent this wait in the queue for every registered job function, the four
 * hooks included, because `retry_delay` was a `WorkerSettings` field rather
 * than a per-job one.
 */
export async function pauseBeforeHookRetry(
  retryCount: number | undefined,
  signal?: AbortSignal,
): Promise<void> {
  if ((retryCount ?? 0) + 1 >= MAX_ATTEMPTS) return
  await pauseBeforeRetry(signal)
}

/**
 * The `warning` / `retry` entry from Python's exception branch
 * (`api/src/worker.py:334`), written when a stage throws and the engine still
 * has attempts left for it.
 *
 * It lives here rather than beside its sibling `error` / `stage_error` entry in
 * `failure-recorder.ts` because the two are written from different places by
 * construction. The evented processor only routes a failed step to
 * `workflow.step.end`, and so to `workflow.fail`, once
 * `retryCount >= retryConfig.attempts`
 * (`workflow-event-processor-Dp87-e6z.js:3434`); while attempts remain it
 * republishes `workflow.step.run` and nothing terminal is ever published. A
 * listener on `workflows-finish` therefore cannot see a retry, and the only
 * vantage point that can is inside the step, where `retryCount` and the thrown
 * error are both in hand.
 *
 * `retryCount + 1` is Python's `job_try`: the engine counts retries after the
 * first execution, so the first failure arrives with `retryCount === 0` and is
 * attempt 1. The gate is Python's own `job_try < MAX_ATTEMPTS`, which holds
 * exactly when the workflow's `attempts` (`MAX_ATTEMPTS - 1`) leaves a retry to
 * come, so the entry is written when and only when one actually follows.
 *
 * The stage names the step that threw. Python sent `""` for a full run, since
 * its runner only knew the whole job had failed; the same deviation, and the
 * same reason for it, is recorded on the `stage_error` entry in
 * `failure-recorder.ts`.
 *
 * No SSE event goes with it: Python published `stage_error` once per attempt
 * from the same block, and that publish is already ported in the failure
 * recorder. Publishing a second one here would raise a toast per attempt for a
 * run that has not failed yet.
 *
 * The entry is written before the pause below it, deliberately: the run's log
 * says "retrying..." and then goes quiet for ten seconds, rather than looking
 * hung for ten seconds and then explaining itself.
 */
export async function recordStageRetry(
  stage: Stage,
  postId: string,
  retryCount: number,
  error: unknown,
  signal?: AbortSignal,
): Promise<void> {
  const attempt = retryCount + 1
  if (attempt >= MAX_ATTEMPTS) return
  await appendExecutionLog(postId, {
    stage,
    level: "warning",
    event: "retry",
    message: `Pipeline attempt ${attempt} failed, retrying...`,
    data: { attempt, max_attempts: MAX_ATTEMPTS, error: errorText(error) },
  })
  await pauseBeforeRetry(signal)
}

/** The output of a stage that was skipped: the chain's fields and nothing else. */
export function skippedStageOutput(input: StageStepInput, stage: Stage): StageStepOutput {
  return {
    postId: input.postId,
    stages: input.stages,
    stage,
    model: "",
    tokensIn: 0,
    tokensOut: 0,
    durationS: 0,
    skipped: true,
  }
}

/**
 * The options a stage passes `agent.generate()`, carrying the settings user so
 * the agent's dynamic `model` and `defaultOptions` resolve that user's
 * `stage_models` overrides (item 6.2b).
 *
 * The lookup is a query per provider call rather than a value threaded through
 * the step input, because the run's snapshot would otherwise pin the setting
 * as it stood when the run started: a stage resumed after a crash, or rerun by
 * name days later, should use the setting that is stored now.
 */
export async function stageAgentOptions(postId: string) {
  return { requestContext: stageRequestContext(await settingsUserIdForPost(postId)) }
}
