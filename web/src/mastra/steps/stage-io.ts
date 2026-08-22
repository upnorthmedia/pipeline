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

import { publishPipelineEvent } from "../pipeline-events"
import {
  markCompleteIfAllStagesComplete,
  markStageForReview,
  markStageRunning,
} from "../post-state"
import { STAGES, STATUS_COMPLETE } from "../state"
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
 */
export async function reviewGate(
  stage: Stage,
  input: StageStepInput,
  stageSettings: Record<string, string>,
  resumeData?: GateResume,
): Promise<GateSuspendPayload | null> {
  if (resumeData?.approved) return null
  if (!stageNeedsReview(stage, input, stageSettings)) return null

  await markStageForReview(input.postId, stage)
  return {
    stage,
    mode: gateModeFor(stage, stageSettings) as ReviewMode,
    message: `Stage ${stage} paused for review`,
  }
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
  await markStageRunning(input.postId, stage)
  await publishPipelineEvent(mastra.pubsub, input.postId, "stage_start", {
    stage,
    message: `Starting ${stage}...`,
  })
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
