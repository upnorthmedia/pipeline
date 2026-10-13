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
 * come first, because they can leave `stage_status` stale: a terminal failure
 * whose step the engine could not name leaves the stage that threw reading
 * `running` (`resolveStageStatus()` below reconciles that one), and a pause
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

/**
 * The stage map as a reader should show it, which on a run the worker gave up
 * on is not quite what the column says.
 *
 * `markPipelineFailed()` stamps the stage the run died in since polish ledger
 * item P5.1, so for rows written after it this is a no-op. Two cases are left
 * for it. The engine's terminal event does not always name the step that threw,
 * and then the recorder has nothing to stamp; and every row written before that
 * fix still records the stage it died in as `running`. Both render as a stage
 * still executing: a spinning dot, a tab reading `Running Write...`, and an
 * elapsed clock on the run trace counting up under a header that says `Failed`.
 *
 * A run that has been given up on is executing nothing, so a stage the map
 * still calls `running` is the stage it died in. Every other status is left
 * alone: `complete` is what those stages did, and `pending` is what the stages
 * after it never started.
 *
 * The same object is returned when nothing changes, so a caller can pass it
 * straight down without giving React a new reference on every render.
 */
export function resolveStageStatus(post: {
  /** Widened to `string` because `PipelineProgress` is handed the raw column. */
  currentStage: string
  stageStatus: StageStatusMap
}): StageStatusMap {
  if (post.currentStage !== "failed") return post.stageStatus
  const stuck = STAGES.filter((stage) => post.stageStatus[stage] === "running")
  if (stuck.length === 0) return post.stageStatus
  return { ...post.stageStatus, ...Object.fromEntries(stuck.map((stage) => [stage, "failed"])) }
}

export function deriveRunState(post: {
  currentStage: PostStage
  stageStatus: StageStatusMap
}): RunState {
  const { currentStage } = post
  const stageStatus = resolveStageStatus(post)
  const failedStages = STAGES.filter((stage) => stageStatus[stage] === "failed")
  const reviewStages = STAGES.filter((stage) => stageStatus[stage] === "review")
  const runningStage = STAGES.find((stage) => stageStatus[stage] === "running") ?? null
  const base = { failedStages, reviewStages, runningStage }

  // Two row states outrank the stage map because they are written *over* a
  // run that was mid-flight. A pause writes `current_stage` while the stage it
  // interrupted is still finishing, and a terminal failure is the row's own
  // account of a run nothing is executing any more. Reading the map first left
  // a dead run reading "Running Research" for good; reading it through
  // `resolveStageStatus()` is what now lets the failed branch name the stage.
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
    if (isPausedBeforeFinish(post)) {
      return {
        ...base,
        kind: "paused",
        label: "Paused before finishing",
        detail:
          "Every stage finished. The pause stopped the run before it marked this post complete and started its publish.",
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
 * A pause that landed after the last stage rather than in front of one.
 *
 * `ready` is the only stage with no stage after it to read the pause, so
 * `pipeline-complete` reads it instead and skips the three things it does for a
 * full run: the `completed_at` stamp, the auto-publish and the
 * `pipeline_complete` frame (deliberate, ledger item P2.115). The row that
 * leaves is all six stages complete with `current_stage = "paused"` and no
 * `completed_at`, and the generic paused sentence is wrong about it twice:
 * there is no stage left to carry on from, and what the post is missing is the
 * finish itself.
 *
 * Exported because the post page needs the same answer for a different
 * question: which control to offer. "Resume from Ready" there is `POST /rerun`,
 * which clears `ready_content` and pays for the stage again to reach a step
 * that needs no stage to run at all; `POST /run-all` releases the pause to
 * `complete` and starts a run that skips all six and reaches only the finish.
 */
export function isPausedBeforeFinish(post: {
  currentStage: PostStage
  stageStatus: StageStatusMap
}): boolean {
  return (
    post.currentStage === "paused" && STAGES.every((stage) => post.stageStatus[stage] === "complete")
  )
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

/**
 * The run states a bulk pause acts on: a stage in flight, a run between
 * stages, and a run that has not reached its first stage yet.
 *
 * The three it leaves out are the point of the list. `review` and `failed` are
 * both reachable with `current_stage` set to one of the six stage names, so a
 * pause scoped by that column alone swallowed them: it overwrote the only
 * column saying a person was being waited on, or that the run was dead, and
 * `deriveRunState()` then reported both as "Paused". The review case is worse
 * than a mislabel, because `POST /api/queue/resume-all` enqueues the
 * single-stage form and a named stage skips its review gate by design, so
 * pause-then-resume ran the stage the reviewer never approved. `complete`,
 * `finished_with_errors` and `paused` were already out of reach.
 *
 * `not_started` stays in, even though the strip calls those rows Not started
 * and nothing is spending anything on them: a run enqueued by `restart` or
 * `rerun` reads `current_stage = "pending"` with an empty `stage_status` until
 * its first stage marks itself running, which is this exact state, and
 * `pauseGate()` stops it in front of `research`. The two columns cannot tell
 * that run from one nobody ever started, and failing to pause a run that is
 * about to spend money is the worse of the two mistakes.
 */
export const PAUSABLE_RUN_STATES: readonly RunStateKind[] = [
  "running",
  "in_progress",
  "not_started",
]
