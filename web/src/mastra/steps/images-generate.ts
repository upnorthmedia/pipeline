/**
 * Step 2 of the `images` stage: one manifest entry becomes one image.
 *
 * This is the body of Python's `_generate_one` closure lifted into a step so
 * that `.foreach()` can drive it. All of the decisions it makes live in
 * `../images/generate-one`, ported and pinned against Python in item 3.5e; the
 * step is the Mastra shell around them.
 *
 * The Gemini credential is resolved here, per image, rather than being carried
 * on the job. A job is serialised into the workflow snapshot Postgres persists
 * and into the Redis event that hands the step to the worker, so a key on the
 * job would end up in the run history of every pipeline that has ever run. The
 * price is one indexed single-row read per image, which is the same trade the
 * stage agents already make.
 */
import { createStep } from "@mastra/core/workflows/evented"
import { z } from "zod"

import { requireApiKey } from "../api-keys"
import { generateOneImage } from "../images/generate-one"
import type { ImageSpec } from "../images/generate-one"
import { imageSpecSchema } from "./images-manifest"

export const imageJobSchema = z.object({
  postId: z.uuid(),
  /** `<media_dir>/<post_id>`, already created by the mapping step. */
  mediaDir: z.string().min(1),
  /** The entry's position in `manifest.images`, which Python stores as `index`. */
  index: z.number().int().nonnegative(),
  spec: imageSpecSchema,
})

export type ImageJob = z.infer<typeof imageJobSchema>

/**
 * What one image cost, whether or not it ended up in the manifest as generated.
 *
 * Python accumulates the Gemini counters the moment `generate_image` returns,
 * before the optimizer runs, so an image whose bytes the optimizer rejects is
 * stored as failed and still billed. Reporting usage beside the entry rather
 * than deriving it from `generated` is what lets the assembling step reproduce
 * that sum.
 */
export const imageUsageSchema = z.object({
  tokensIn: z.number().int().nonnegative(),
  tokensOut: z.number().int().nonnegative(),
  model: z.string(),
})

export const generatedImageSchema = z.object({
  /** The manifest entry to store, with the stage's bookkeeping keys applied. */
  spec: imageSpecSchema,
  /** Non-null exactly when the provider returned, success or not. */
  usage: imageUsageSchema.nullable(),
})

export type GeneratedImageOutput = z.infer<typeof generatedImageSchema>

export const imagesGenerateStep = createStep({
  id: "images-generate",
  inputSchema: imageJobSchema,
  outputSchema: generatedImageSchema,
  execute: async ({ inputData }) => {
    const apiKey = await requireApiKey("gemini")
    const { spec, usage } = await generateOneImage({
      spec: inputData.spec as ImageSpec,
      index: inputData.index,
      postId: inputData.postId,
      mediaDir: inputData.mediaDir,
      apiKey,
    })
    return { spec: imageSpecSchema.parse(spec), usage }
  },
})
