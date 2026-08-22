/**
 * Step 1 of the `images` stage: the Claude call that produces the image
 * manifest, ported from the first half of `images_node` in
 * `api/src/pipeline/stages/images.py`.
 *
 * `images` is the only stage that cannot be one step. Python calls Claude
 * once, then fans out one Gemini call per manifest entry under a semaphore,
 * then folds the results back into the manifest. The fan-out is `.foreach()`
 * in this port, and `.foreach()` is a workflow-level operator that consumes
 * the *previous step's* array output, so the stage becomes three steps inside
 * one nested workflow: this one, the per-image step, and the step that
 * assembles the manifest and commits it.
 *
 * The split is only structural. Two properties of Python's single function are
 * preserved across it:
 *
 * 1. **One write per stage.** Python's worker saves `image_manifest` exactly
 *    once, from whichever dict `images_node` returned, so this step commits
 *    nothing even on the parse-failure path. The assembling step is the only
 *    writer.
 * 2. **One timer over the whole stage.** `StageTimer` wraps the manifest call
 *    *and* every image, so `duration_s` cannot be measured here. The stage's
 *    start is returned instead and the assembling step subtracts it.
 *
 * The parse-failure branch is a real branch, not an error path: a manifest
 * Claude wrote as prose is stored verbatim with `stage_status.images =
 * "failed"` and no Gemini call is made or billed. It is signalled here with
 * `parseFailed` rather than by throwing, because throwing would lose the
 * synthesised manifest that Python stores.
 */
import { createStep } from "@mastra/core/workflows/evented"
import { z } from "zod"

import { parseManifest } from "../images/manifest"
import { loadPipelineState } from "../post-state"
import { buildStagePrompt, loadRules } from "../prompts"
import { stageStepInputSchema } from "./stage-io"

/**
 * Anything `JSON.parse` can return.
 *
 * The `image_manifest` column is JSONB written from whatever Claude answered
 * with, and the port's contract is that its shape survives byte for byte, so
 * the schema has to admit an arbitrary JSON document. This is that, spelled
 * out recursively rather than as `z.any()`: it still rejects `undefined`,
 * functions and cycles, which is what would silently corrupt the column.
 */
export type JsonValue = string | number | boolean | null | JsonValue[] | { [key: string]: JsonValue }

export const jsonValueSchema: z.ZodType<JsonValue> = z.lazy(() =>
  z.union([
    z.string(),
    z.number(),
    z.boolean(),
    z.null(),
    z.array(jsonValueSchema),
    z.record(z.string(), jsonValueSchema),
  ]),
)

/** One manifest entry. Every key is the model's; none of them is required. */
export const imageSpecSchema = z.record(z.string(), jsonValueSchema)

/** The manifest document itself, as parsed out of Claude's answer. */
export const imageManifestSchema = z.record(z.string(), jsonValueSchema)

export const imagesManifestOutputSchema = z.object({
  postId: z.uuid(),
  /**
   * `Date.now()` at the top of the stage, standing in for `StageTimer`'s
   * `time.monotonic()`. Carried through the fan-out so the assembling step can
   * report Python's whole-stage `duration_s`.
   */
  stageStartedAtMs: z.number().nonnegative(),
  /** The provider's own reported model id, not the one requested. */
  model: z.string(),
  tokensIn: z.number().int().nonnegative(),
  tokensOut: z.number().int().nonnegative(),
  /**
   * True when the manifest carries a truthy `error`, which is how
   * `_parse_manifest` reports that it recovered nothing. Python tests the
   * value rather than the key, so a manifest in which the *model* wrote
   * `"error"` short-circuits the stage too; that is reproduced.
   */
  parseFailed: z.boolean(),
  manifest: imageManifestSchema,
  /** `manifest.get("images", [])`, empty whenever the parse failed. */
  images: z.array(imageSpecSchema),
})

export type ImagesManifestOutput = z.infer<typeof imagesManifestOutputSchema>

/** `response.content[:500]`, sliced by code point the way Python slices `str`. */
export function rawSnippet(content: string): string {
  return [...content].slice(0, 500).join("")
}

/**
 * Python's truth value for a JSON scalar or container.
 *
 * The two engines disagree on containers: `[]` and `{}` are falsy in Python and
 * truthy in JavaScript. This decides whether the stage short-circuits and
 * whether Gemini is billed at all, so it is worth the six lines.
 */
export function pythonTruthy(value: JsonValue | undefined): boolean {
  if (value === undefined || value === null) return false
  if (Array.isArray(value)) return value.length > 0
  if (typeof value === "object") return Object.keys(value).length > 0
  return Boolean(value)
}

export const imagesManifestStep = createStep({
  id: "images-manifest",
  inputSchema: stageStepInputSchema,
  outputSchema: imagesManifestOutputSchema,
  execute: async ({ inputData, mastra }) => {
    const { postId } = inputData
    const stageStartedAtMs = Date.now()

    const state = await loadPipelineState(postId)
    const prompt = buildStagePrompt("images", loadRules("images"), state)

    const result = await mastra.getAgent("images").generate(prompt)

    const meta = {
      postId,
      stageStartedAtMs,
      model: result.response?.modelId ?? "",
      tokensIn: result.usage?.inputTokens ?? 0,
      tokensOut: result.usage?.outputTokens ?? 0,
    }

    const parsed = parseManifest(result.text)
    // Python does `manifest.get("error")` straight away, so a manifest that is
    // not a mapping raises out of the stage rather than being stored. `json`
    // and `JSON.parse` both admit arrays and scalars, so this is reachable.
    if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
      throw new TypeError(
        `image manifest parsed to ${Array.isArray(parsed) ? "an array" : typeof parsed}, not an object`,
      )
    }
    const manifest = imageManifestSchema.parse(parsed)

    if (pythonTruthy(manifest.error)) {
      mastra.getLogger()?.warn(`Manifest parse failed: ${String(manifest.error)}`, {
        postId,
        stage: "images",
        rawSnippet: rawSnippet(result.text),
      })
      return { ...meta, parseFailed: true, manifest, images: [] }
    }

    return {
      ...meta,
      parseFailed: false,
      manifest,
      // `manifest.get("images", [])`: absent is `[]`, and an explicit `null`
      // is *not*, which is why this tests key presence rather than using `??`.
      // A present non-array value fails the schema here, where Python would
      // enumerate whatever it is (`len(None)` raises, a string yields its
      // characters). Neither golden fixture has one and no rule in
      // `rules/blog-images.md` asks for one, so the divergence stays a hard
      // error rather than an invented behaviour.
      images: imagesManifestOutputSchema.shape.images.parse(
        "images" in manifest ? manifest.images : [],
      ),
    }
  },
})
