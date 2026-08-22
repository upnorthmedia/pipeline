/**
 * Step 3 of the `images` stage: fold the generated entries back into the
 * manifest and commit the stage.
 *
 * This is the only writer in the stage. Python's `images_node` returns one dict
 * and the worker saves `image_manifest` exactly once from it, including on the
 * parse-failure path, so splitting the stage across three steps must not turn
 * that into three writes: the manifest step commits nothing, the per-image step
 * commits nothing, and this step performs the single `saveStageOutput`.
 *
 * It is also where the stage's two meta records are produced. Python reports
 * Claude's usage under `_stage_meta` and Gemini's under `_stage_meta_gemini`,
 * both stamped with the *same* whole-stage duration because one `StageTimer`
 * wraps the manifest call and every image. The manifest step returns the wall
 * clock it started at instead of a duration for exactly that reason.
 */
import { createStep } from "@mastra/core/workflows/evented"
import { z } from "zod"

import { GEMINI_IMAGE_MODEL_ID } from "../images/gemini"
import { saveStageOutput } from "../post-state"
import { STATUS_COMPLETE, STATUS_FAILED } from "../state"
import { generatedImageSchema } from "./images-generate"
import { imageManifestSchema, imagesManifestStep } from "./images-manifest"
import {
  announceStageComplete,
  markRerunComplete,
  skippedStageOutput,
  stageStepOutputSchema,
} from "./stage-io"

/** `_stage_meta_gemini`: the image spend, reported separately from Claude's. */
export const geminiStageMetaSchema = z.object({
  stage: z.literal("images_gemini"),
  model: z.string(),
  tokensIn: z.number().int().nonnegative(),
  tokensOut: z.number().int().nonnegative(),
  durationS: z.number().nonnegative(),
})

export const imagesStageOutputSchema = stageStepOutputSchema.extend({
  /**
   * `manifest["total_generated"]` / `manifest["total_failed"]` as stored. Both
   * are 0 on the parse-failure branch, where Python stores the synthesised
   * manifest without adding either key.
   */
  totalGenerated: z.number().int().nonnegative(),
  totalFailed: z.number().int().nonnegative(),
  /** True when the stage short-circuited on an unparseable manifest. */
  parseFailed: z.boolean(),
  /**
   * Null on the parse-failure branch, where Python returns no
   * `_stage_meta_gemini` at all because no image was ever attempted.
   */
  gemini: geminiStageMetaSchema.nullable(),
})

export type ImagesStageOutput = z.infer<typeof imagesStageOutputSchema>

/**
 * The three lines Python spends folding the generated entries back in:
 *
 * ```python
 * manifest["images"] = generated_images
 * manifest["total_generated"] = sum(1 for img in generated_images if img.get("generated"))
 * manifest["total_failed"] = sum(1 for img in generated_images if not img.get("generated"))
 * ```
 *
 * Separated from the step so the document's key order is assertable. Assigning
 * an existing key leaves it in place in both languages, so `images` keeps its
 * position in whatever Claude wrote and the two totals are appended after it.
 * Postgres `jsonb` sorts keys on write, so that order survives only in memory,
 * which is exactly why it is worth pinning here rather than on the row.
 */
export function foldManifest(
  manifest: Record<string, unknown>,
  images: Record<string, unknown>[],
): Record<string, unknown> {
  // `img.get("generated")` is a truthiness test in Python, but the value is the
  // boolean `_generate_one` set, so this needs no `pythonTruthy`.
  const totalGenerated = images.filter((spec) => spec.generated === true).length
  return {
    ...manifest,
    images,
    total_generated: totalGenerated,
    total_failed: images.length - totalGenerated,
  }
}

export const imagesAssembleStep = createStep({
  id: "images-assemble",
  inputSchema: z.array(generatedImageSchema),
  outputSchema: imagesStageOutputSchema,
  execute: async ({ inputData, getStepResult, mastra }) => {
    const manifestResult = getStepResult(imagesManifestStep)
    const { postId, stages, stageStartedAtMs, parseFailed, skipped } = manifestResult

    if (skipped) {
      // Nothing ran, so there is nothing to fold, write or bill. Returned from
      // here rather than from the manifest step because the fan-out sits
      // between them and this is the step whose output leaves the workflow.
      return {
        ...skippedStageOutput({ postId, stages }, "images"),
        totalGenerated: 0,
        totalFailed: 0,
        parseFailed: false,
        gemini: null,
      }
    }
    // One timer over the whole stage, read once so both meta records carry the
    // same value the way Python's single `timer.duration` did.
    const durationS = (Date.now() - stageStartedAtMs) / 1000

    const claudeMeta = {
      postId,
      stages,
      stage: "images" as const,
      skipped: false,
      model: manifestResult.model,
      tokensIn: manifestResult.tokensIn,
      tokensOut: manifestResult.tokensOut,
    }

    if (parseFailed) {
      // `timer.duration` is still 0 here: Python returns from *inside* the
      // `with` block, and `StageTimer` only computes the elapsed time in
      // `__exit__`. So a failed manifest is reported as taking no time, and
      // there is no Gemini record because no image was attempted.
      await saveStageOutput(postId, "images", manifestResult.manifest, {
        images: STATUS_FAILED,
      })
      // No rerun completion check here: the stage just marked itself failed, so
      // the "every stage complete" it would ask about cannot be true.
      const failedOutput = {
        ...claudeMeta,
        durationS: 0,
        totalGenerated: 0,
        totalFailed: 0,
        parseFailed: true,
        gemini: null,
      }
      // Announced even though the stage marked itself failed: Python's node
      // returned normally on this branch, so the worker loop reached its
      // `stage_complete` publish with `duration_s` still 0. The failure shows
      // up as `stage_status.images = "failed"` on the row the browser refetches.
      await announceStageComplete(mastra, failedOutput)
      return failedOutput
    }

    const images = inputData.map((result) => result.spec)
    const manifest = imageManifestSchema.parse(foldManifest(manifestResult.manifest, images))
    const totalGenerated = Number(manifest.total_generated)

    await saveStageOutput(postId, "images", manifest, { images: STATUS_COMPLETE })
    await markRerunComplete({ postId, stages })

    // Python seeds `gemini_model` with the requested id and overwrites it with
    // whatever each successful call reported, so a stage that billed nothing
    // still records the id it would have used.
    const billed = inputData.map((result) => result.usage).filter((usage) => usage !== null)

    const output = {
      ...claudeMeta,
      durationS,
      totalGenerated,
      totalFailed: images.length - totalGenerated,
      parseFailed: false,
      gemini: {
        stage: "images_gemini" as const,
        model: billed.at(-1)?.model ?? GEMINI_IMAGE_MODEL_ID,
        tokensIn: billed.reduce((sum, usage) => sum + usage.tokensIn, 0),
        tokensOut: billed.reduce((sum, usage) => sum + usage.tokensOut, 0),
        durationS,
      },
    }
    await announceStageComplete(mastra, output)
    return output
  },
})
