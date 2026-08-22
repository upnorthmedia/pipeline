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
import { z } from "zod"

import { markCompleteIfAllStagesComplete } from "../post-state"
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
