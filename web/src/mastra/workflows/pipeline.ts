/**
 * The content pipeline: all six stages as one registered Mastra workflow.
 *
 * This is the composition Python spelled out as a `for stage in target_stages`
 * loop in `_run_pipeline()`. The loop body is gone rather than translated: each
 * step already loads its own state from the posts table and commits its own
 * column, so the only thing the runner had left to do was decide the order,
 * which `.then()` now declares.
 *
 * ```
 * pipeline-start -> research -> outline -> write -> edit -> images -> ready
 *   -> pipeline-complete
 * ```
 *
 * `pipeline-start` is not a stage either. It is the head of Python's
 * `if is_full_pipeline:` block, writing the run-level `pipeline_start` entry to
 * `execution_logs` before any stage runs (see `steps/pipeline-start.ts`).
 *
 * `pipeline-complete` is not a stage. It is the tail of Python's
 * `if is_full_pipeline:` block, stamping `current_stage = "complete"` and
 * `completed_at` on a full run that reached the end (see
 * `steps/pipeline-complete.ts`).
 *
 * `images` is a nested workflow, not a step, because its per-image fan-out is
 * `.foreach()` and that only exists at workflow level (see `workflows/images.ts`).
 * Nesting is transparent to the chain: its output extends the shared stage
 * output, so `ready` reads the same `{ postId }` from it as from any step.
 *
 * The chain carries only a post id between stages. Each step re-reads the row
 * the previous one wrote, so a run resumed in a different process after a crash
 * rebuilds its inputs from committed rows rather than from a snapshot of what a
 * dead process was holding.
 *
 * Which of the six actually run is decided per step from the run's input, not
 * by rebuilding the chain: `stages` on the input names the stages to run, and
 * its absence means Python's full pipeline, every stage `stage_status` does not
 * already call complete. A stage that is not selected returns immediately with
 * `skipped: true` and bills nothing, which is the `continue` in Python's stage
 * loop. See `steps/stage-io.ts`.
 *
 * The runner's bookkeeping around each call now lives in the steps themselves:
 * the `"running"` write, the `stage_start` / `stage_complete` / `pipeline_complete`
 * events on the shared topic, and the matching `execution_logs` entries.
 *
 * Deliberately not here yet: the failure entries the exception branch wrote,
 * the per-stage `log` events the stage nodes published, and the auto-publish
 * half of the completion hook. The first two are the rest of Phase 5's `events`
 * item; the last needs the `wordpress` and `nextjs` routers.
 */
import { createWorkflow } from "@mastra/core/workflows/evented"

import { editStep } from "../steps/edit"
import { outlineStep } from "../steps/outline"
import { pipelineCompleteStep } from "../steps/pipeline-complete"
import { pipelineStartStep } from "../steps/pipeline-start"
import { readyStep } from "../steps/ready"
import { researchStep } from "../steps/research"
import { stageStepInputSchema, stageStepOutputSchema } from "../steps/stage-io"
import { writeStep } from "../steps/write"
import { imagesWorkflow } from "./images"

/**
 * The run's output is `ready`'s stage meta: the last stage's model, tokens and
 * duration. The other five stages' metas are not folded in here because they
 * are already addressable per step, both on the finished run's `steps` map and
 * on the `workflow-step-result` events `run.stream()` emits, which is where the
 * Phase 8 trace view reads them from.
 */
export const pipelineWorkflow = createWorkflow({
  id: "pipeline",
  inputSchema: stageStepInputSchema,
  outputSchema: stageStepOutputSchema,
})
  .then(pipelineStartStep)
  .then(researchStep)
  .then(outlineStep)
  .then(writeStep)
  .then(editStep)
  .then(imagesWorkflow)
  .then(readyStep)
  .then(pipelineCompleteStep)
  .commit()
