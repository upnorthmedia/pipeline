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
 * research -> outline -> write -> edit -> images -> ready
 * ```
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
 * Deliberately not here yet, each with its own ledger item: the single-stage
 * rerun's `current_stage = "complete"` check (4.2b), review gates (4.3), and the
 * per-stage `running` status, execution logs and SSE events the Python runner
 * published around each call (Phase 5's `events` router owns the transport
 * those need).
 */
import { createWorkflow } from "@mastra/core/workflows/evented"

import { editStep } from "../steps/edit"
import { outlineStep } from "../steps/outline"
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
  .then(researchStep)
  .then(outlineStep)
  .then(writeStep)
  .then(editStep)
  .then(imagesWorkflow)
  .then(readyStep)
  .commit()
