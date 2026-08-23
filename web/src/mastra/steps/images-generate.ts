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
import type { PubSub } from "@mastra/core/events"
import { createStep } from "@mastra/core/workflows/evented"
import { z } from "zod"

import { requireApiKey } from "../api-keys"
import { generateOneImage } from "../images/generate-one"
import type { ImageOutcome, ImageSpec } from "../images/generate-one"
import { imageSpecSchema } from "./images-manifest"
import { publishStageLog, recordStageRetry } from "./stage-io"

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

/**
 * Which of `_generate_one`'s three exits produced the entry.
 *
 * On the step's output rather than derived from `spec`, because the two lines
 * Python published from inside the fan-out are chosen by the branch and the
 * branch is not recoverable from the entry: see `ImageOutcome` in
 * `../images/generate-one`.
 */
export const imageOutcomeSchema = z.discriminatedUnion("kind", [
  z.object({
    kind: z.literal("generated"),
    bytes: z.number().int().nonnegative(),
    url: z.string(),
  }),
  z.object({ kind: z.literal("failed"), error: z.string() }),
  z.object({ kind: z.literal("no-prompt") }),
])

export const generatedImageSchema = z.object({
  /** The manifest entry to store, with the stage's bookkeeping keys applied. */
  spec: imageSpecSchema,
  /** Non-null exactly when the provider returned, success or not. */
  usage: imageUsageSchema.nullable(),
  outcome: imageOutcomeSchema,
})

export type GeneratedImageOutput = z.infer<typeof generatedImageSchema>

/**
 * What publishing one per-image line needs off the `mastra` handed to
 * `execute`: the transport, plus the logger for the one line Python wrote to
 * both.
 *
 * Declared here rather than reusing `StageLogContext` because that one only
 * promises `debug`, which is all `publishStageLog` itself needs. This is
 * structurally assignable to it, so the same object serves both.
 */
interface ImageLogContext {
  pubsub: PubSub
  getLogger?: () => {
    debug(message: string, ...args: unknown[]): void
    error(message: string, ...args: unknown[]): void
  } | undefined
}

/**
 * The two `publish_stage_log` calls inside `_generate_one`
 * (`api/src/pipeline/stages/images.py:180` and `:195`).
 *
 * They are the only two lines in the pipeline published under an event name
 * other than `log`, and two of the only three that carry a `data` payload.
 * Neither name is in `use-sse.ts`'s `NAMED_EVENTS`, so a browser drops both
 * today exactly as it dropped Python's; they are ported as Python wrote them
 * and the gap is item 5.5d's to close, not this one's to invent a fix for.
 *
 * The no-prompt branch publishes nothing. Python returns from it before the
 * semaphore and before either call, so an entry the model gave no prompt leaves
 * no trace on the bus or on the row.
 *
 * `logger.error` on the failure branch is Python's own, and it is kept
 * alongside the publish rather than replaced by it: Python ran both from the
 * same `except`, and the two have different readers. That is the opposite call
 * from items 5.5c-iv-c and 5.5c-iv-d-1, which moved lines *off* the logger,
 * and the difference is that those were lines Python only ever published.
 */
async function publishImageOutcome(
  mastra: ImageLogContext,
  postId: string,
  index: number,
  outcome: ImageOutcome,
): Promise<void> {
  if (outcome.kind === "no-prompt") return
  if (outcome.kind === "generated") {
    await publishStageLog(
      mastra,
      postId,
      "images",
      `Image ${index} generated (${outcome.bytes} bytes)`,
      {
        event: "image_generated",
        data: { index, bytes: outcome.bytes, path: outcome.url },
      },
    )
    return
  }
  mastra.getLogger?.()?.error(`Failed to generate image ${index}: ${outcome.error}`)
  await publishStageLog(mastra, postId, "images", `Image ${index} failed: ${outcome.error}`, {
    level: "error",
    event: "image_failed",
    data: { index, error: outcome.error },
  })
}

export const imagesGenerateStep = createStep({
  id: "images-generate",
  inputSchema: imageJobSchema,
  outputSchema: generatedImageSchema,
  execute: async ({ inputData, mastra, retryCount }) => {
    try {
      const apiKey = await requireApiKey("gemini")
      const { spec, usage, outcome } = await generateOneImage({
        spec: inputData.spec as ImageSpec,
        index: inputData.index,
        postId: inputData.postId,
        mediaDir: inputData.mediaDir,
        apiKey,
      })
      // Python publishes from inside `_generate_one`, one statement before the
      // entry is returned. Here it is one statement after, because the publish
      // needs the `mastra` only the step is handed. Nothing runs between the
      // two positions, so the only difference is what happens when the publish
      // itself fails: Python's success publish sat inside the same `try` that
      // catches provider errors, so a dead Redis turned a generated image into
      // a failed entry, where here it fails the step and the engine retries it.
      await publishImageOutcome(mastra, inputData.postId, inputData.index, outcome)
      return { spec: imageSpecSchema.parse(spec), usage, outcome }
    } catch (error) {
      // Python's `warning` / `retry` entry, from the `except` block that
      // wrapped the whole stage. Written under the stage's name rather than
      // this sub-step's, because the log reader groups on `stage` and Python
      // only ever wrote `images` here. `imagesWorkflow` carries the retry
      // policy of its own (item 5.5c-iii-b-2-b-i), so `retryCount` is the
      // attempt number the same way it is for the five single-step stages.
      await recordStageRetry("images", inputData.postId, retryCount, error)
      throw error
    }
  },
})
