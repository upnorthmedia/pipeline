/**
 * The `images` stage, as a nested workflow of three steps.
 *
 * Every other stage is one step: one prompt, one provider call, one column
 * write. `images` calls Claude for a manifest, then calls Gemini once per
 * manifest entry under a concurrency limit, then folds the results back. The
 * objective requires the fan-out to be `.foreach()` rather than a hand-rolled
 * loop, and `.foreach()` is declared on `Workflow`, not on `Step`: it consumes
 * the *previous step's* array output. So the stage cannot be a step with a loop
 * inside it; it has to be a workflow whose middle entry is the fan-out.
 *
 * ```
 * images-manifest -> map -> foreach(images-generate) -> images-assemble
 * ```
 *
 * `.map()` is what bridges the two: the manifest step keeps a rich object
 * output (it has to, since the assembling step needs the whole document back)
 * while `.foreach()` needs an array, and `getStepResult()` is what lets the
 * assembling step read the manifest step's output past the fan-out.
 *
 * The split is structural only. Python's single function guarantees three
 * things that survive it: one write per stage (only `images-assemble` writes),
 * one timer over the whole stage (the manifest step returns its start time
 * rather than a duration), and a parse failure that is a branch rather than an
 * exception (an unparseable manifest is stored verbatim and bills no image).
 */
import { createWorkflow } from "@mastra/core/workflows/evented"
import { z } from "zod"

import { requireApiKey } from "../api-keys"
import { ensureMediaDir, mediaRoot } from "../images/media-dir"
import { imagesAssembleStep, imagesStageOutputSchema } from "../steps/images-assemble"
import { imageJobSchema, imagesGenerateStep } from "../steps/images-generate"
import { imagesManifestStep } from "../steps/images-manifest"
import { stageStepInputSchema } from "../steps/stage-io"

/**
 * `asyncio.Semaphore(3)`.
 *
 * Python acquires the semaphore *inside* `_generate_one`, after the
 * no-prompt check, so an entry the model gave no prompt never takes a slot;
 * here the whole step occupies one. The difference is invisible in the stored
 * manifest and costs at most a few milliseconds of a slot, which is why it is
 * recorded rather than worked around.
 */
export const IMAGE_CONCURRENCY = 3

export const imagesWorkflow = createWorkflow({
  id: "images",
  inputSchema: stageStepInputSchema,
  outputSchema: imagesStageOutputSchema,
})
  .then(imagesManifestStep)
  /**
   * Manifest entries become per-image jobs.
   *
   * The Gemini key is checked here and then thrown away rather than being
   * carried on a job: Python constructs `GeminiClient` once before the fan-out,
   * so a missing key fails the stage before any image is attempted, and a job
   * is serialised into the workflow snapshot and the Redis event, where a
   * credential must never appear.
   *
   * A skipped stage takes the same empty path as a failed parse, so neither the
   * media directory nor the Gemini key is touched on a run that is only passing
   * through this stage.
   */
  .map(async ({ inputData }) => {
    if (inputData.skipped || inputData.parseFailed) return []
    await requireApiKey("gemini")
    const mediaDir = await ensureMediaDir(mediaRoot(), inputData.postId)
    return inputData.images.map((spec, index) =>
      imageJobSchema.parse({ postId: inputData.postId, mediaDir, index, spec }),
    )
  })
  .foreach(imagesGenerateStep, { concurrency: IMAGE_CONCURRENCY })
  .then(imagesAssembleStep)
  .commit()

/** The array of jobs `.map()` hands to `.foreach()`, for tests and callers. */
export const imageJobsSchema = z.array(imageJobSchema)
