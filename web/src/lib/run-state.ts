/**
 * What one post's run is doing, in one sentence, derived from the two columns
 * that between them hold the answer.
 *
 * `current_stage` is where the run got to and `stage_status` is what each of
 * the six stages did, and they can disagree. `markPipelineComplete()` in
 * `src/mastra/post-state.ts` is unconditional by design (Python's
 * `_post_completion_hook` was), so a run whose `images` stage wrote
 * `images: failed` and returned rather than raising still ends up stamped
 * `current_stage = "complete"` with a `completed_at`. Every surface that read
 * `current_stage` alone therefore called that post finished while the stage
 * badge beside it said the pictures failed.
 *
 * The fix is here rather than on the write, because the write is the record of
 * what the run did and it is accurate: the run did reach the end. What was
 * wrong is that one column was being reported as the whole state. This module
 * reads both and is the only thing the UI asks.
 *
 * **Precedence.** The two row states that are written *over* a run in flight
 * come first, because they leave `stage_status` stale: `markPipelineFailed()`
 * stamps `failed` while the stage that threw still reads `running`, and a pause
 * lands on `current_stage` while the stage it interrupted is still finishing.
 * After those it is
 * the order a reader needs rather than the order the columns are written: what
 * is happening now, then what is waiting on a person, then what went wrong,
 * then the resting states. So a run still executing reads as running even when
 * an earlier stage failed. `failedStages` is populated in every case regardless
 * of `kind`, so a caller that wants to show the failure anyway (the post page's
 * failure banner does) never has to re-derive it.
 */
import { STAGES, type PipelineStage, type PostStage, type StageStatusMap } from "./api"
import { STAGE_LABELS } from "./stages"

/**
 * Every state a run can be in, in the order a reader scans them: what is in
 * flight, then what is waiting on a person, then what went wrong, then the
 * resting states. `GET /api/queue` counts one bucket per entry and the monitor
 * strip reads them in this order, so the list is the vocabulary rather than a
 * bare union: adding a kind without giving it a count is then a type error.
 */
export const RUN_STATE_KINDS = [
  "running",
  "in_progress",
  "review",
  "failed",
  "finished_with_errors",
  "paused",
  "not_started",
  "complete",
] as const

export type RunStateKind = (typeof RUN_STATE_KINDS)[number]

export interface RunState {
  kind: RunStateKind
  /** Badge text, in the user's terms rather than the column's enum value. */
  label: string
  /** One sentence saying what happened and what it needs, or `null` when the label says it all. */
  detail: string | null
  /** Every stage `stage_status` calls failed, in pipeline order, whatever `kind` is. */
  failedStages: PipelineStage[]
  /** Every stage parked in front of a reviewer, in pipeline order. */
  reviewStages: PipelineStage[]
  runningStage: PipelineStage | null
}

/** `["images"]` -> `Images`, `["research", "images"]` -> `Research and Images`. */
function joinStageNames(stages: PipelineStage[]): string {
  const names = stages.map((stage) => STAGE_LABELS[stage])
  if (names.length <= 1) return names.join("")
  return `${names.slice(0, -1).join(", ")} and ${names[names.length - 1]}`
}

export function deriveRunState(post: {
  currentStage: PostStage
  stageStatus: StageStatusMap
}): RunState {
  const { currentStage, stageStatus } = post
  const failedStages = STAGES.filter((stage) => stageStatus[stage] === "failed")
  const reviewStages = STAGES.filter((stage) => stageStatus[stage] === "review")
  const runningStage = STAGES.find((stage) => stageStatus[stage] === "running") ?? null
  const base = { failedStages, reviewStages, runningStage }

  // Two row states outrank the stage map because they are written *over* a
  // run that was mid-flight and leave its `stage_status` untouched.
  // `markPipelineFailed()` stamps `failed` on a run the worker gave up on
  // while the stage that threw is still recorded as `running`, and a pause
  // writes `current_stage` while the stage it interrupted is still finishing.
  // Reading the map first left a dead run reading "Running Research" for good.
  if (currentStage === "failed") {
    return {
      ...base,
      kind: "failed",
      label: failedStages.length > 0 ? `Failed at ${joinStageNames(failedStages)}` : "Failed",
      detail: null,
    }
  }

  if (currentStage === "paused") {
    // A pause is a stage-boundary signal, not an interrupt: the stage that was
    // executing when the button was pressed runs to completion and commits its
    // column, and the run ends in front of the next one (`pauseGate()` in
    // `src/mastra/steps/stage-io.ts`). So while that stage is still marked
    // running there is a provider call in flight, and saying "Paused" over it
    // is the lie ledger item P2.115 was filed for.
    if (runningStage) {
      return {
        ...base,
        kind: "paused",
        label: "Pausing",
        detail: `${STAGE_LABELS[runningStage]} is finishing. Nothing after it will start.`,
      }
    }
    return {
      ...base,
      kind: "paused",
      label: "Paused",
      detail: "The run stopped here. Start it again to carry on from this stage.",
    }
  }

  if (runningStage) {
    return { ...base, kind: "running", label: `Running ${STAGE_LABELS[runningStage]}`, detail: null }
  }

  if (reviewStages.length > 0) {
    return {
      ...base,
      kind: "review",
      label: "Waiting for you",
      detail: `${joinStageNames(reviewStages)} ${
        reviewStages.length > 1 ? "are" : "is"
      } holding for your review before the run continues.`,
    }
  }

  // The disagreement this module exists for. A run that reached the end with a
  // stage marked failed is neither complete nor stopped: it produced a post
  // that is missing whatever that stage makes.
  if (failedStages.length > 0 && currentStage === "complete") {
    return {
      ...base,
      kind: "finished_with_errors",
      label: "Finished with errors",
      detail: `The run reached the end, but ${joinStageNames(failedStages)} failed.`,
    }
  }

  if (failedStages.length > 0) {
    return {
      ...base,
      kind: "failed",
      label: `Failed at ${joinStageNames(failedStages)}`,
      detail: null,
    }
  }

  if (currentStage === "complete") {
    return { ...base, kind: "complete", label: "Complete", detail: null }
  }

  if (STAGES.every((stage) => !stageStatus[stage] || stageStatus[stage] === "pending")) {
    return { ...base, kind: "not_started", label: "Not started", detail: null }
  }

  // Between two stages, or a snapshot taken between the row write and the
  // event. The row's own stage is the most specific thing left to say.
  return {
    ...base,
    kind: "in_progress",
    label: (STAGE_LABELS as Record<string, string>)[currentStage] ?? currentStage,
    detail: null,
  }
}

/**
 * The stage `POST /api/posts/{id}/rerun` will start the run from.
 *
 * Derived exactly the way the handler derives it, because the button that
 * calls it names this stage: the first of the six that `stage_status` does not
 * call complete, falling back to the last one when every stage is complete.
 * That fallback is Python's and it is load-bearing rather than defensive: a
 * finished post has no first incomplete stage, so "re-run" on one re-runs
 * `ready` alone. Keys outside the six are ignored here for the same reason the
 * handler ignores them, `STAGES` is the only list either side walks.
 */
export function resumeStage(stageStatus: StageStatusMap): PipelineStage {
  return STAGES.find((stage) => stageStatus[stage] !== "complete") ?? STAGES[STAGES.length - 1]
}
