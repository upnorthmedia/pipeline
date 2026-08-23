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
import {
  announceStageStart,
  gateResumeSchema,
  gateSuspendSchema,
  publishStageLog,
  recordStageRetry,
  reviewGate,
  shouldRunStage,
  stageStepInputSchema,
} from "./stage-io"

/**
 * Anything `JSON.parse` can return.
 *
 * The `image_manifest` column is JSONB written from whatever Claude answered
 * with, and the port's contract is that its shape survives byte for byte, so
 * the schema has to admit an arbitrary JSON document. This is that, validated
 * rather than left as `z.any()`: it still rejects `undefined`, functions and
 * cycles, which is what would silently corrupt the column.
 */
export type JsonValue = string | number | boolean | null | JsonValue[] | { [key: string]: JsonValue }

/**
 * The recursion lives in this predicate rather than in the schema, and that is
 * load bearing.
 *
 * The obvious spelling is `z.lazy(() => z.union([..., z.array(jsonValueSchema),
 * ...]))`, and it works right up until the schema is used twice. The first
 * parse populates the lazy's `_cachedInner`, which closes a reference cycle
 * through the union's array member. Mastra's evented engine publishes a nested
 * workflow's `parentWorkflow.stepGraph` onto the pub/sub topic as JSON, and
 * that graph carries the step schemas, so from the second `images` run onward
 * in a single process `JSON.stringify` threw `Converting circular structure to
 * JSON` and the stage failed after three redeliveries. One run per process hid
 * it; a worker serving a queue would have hit it immediately.
 *
 * A predicate keeps the schema object a flat leaf while validating the same
 * documents. `NaN` is rejected as `z.number()` rejected it; `Infinity` is
 * admitted as `z.number()` admitted it, even though `JSON.stringify` writes it
 * as `null`, because tightening that is a separate decision from this fix.
 */
function isJsonValue(value: unknown, seen: Set<object>): boolean {
  if (value === null) return true
  switch (typeof value) {
    case "string":
    case "boolean":
      return true
    case "number":
      return !Number.isNaN(value)
    case "object":
      break
    default:
      return false
  }
  const container = value as object
  // A cycle would serialise to nothing useful and cannot have come from JSON.
  if (seen.has(container)) return false
  seen.add(container)
  const children = Array.isArray(container) ? container : Object.values(container)
  const valid = children.every((child) => isJsonValue(child, seen))
  seen.delete(container)
  return valid
}

export const jsonValueSchema: z.ZodType<JsonValue> = z.custom<JsonValue>(
  (value) => isJsonValue(value, new Set()),
  { message: "not a JSON value" },
)

/** One manifest entry. Every key is the model's; none of them is required. */
export const imageSpecSchema = z.record(z.string(), jsonValueSchema)

/** The manifest document itself, as parsed out of Claude's answer. */
export const imageManifestSchema = z.record(z.string(), jsonValueSchema)

export const imagesManifestOutputSchema = z.object({
  postId: z.uuid(),
  /**
   * The run's stage selection, carried across the fan-out so the assembling
   * step can report the skip without re-deriving it. See `stage-io.ts`.
   */
  stages: stageStepInputSchema.shape.stages,
  /**
   * True when the `images` stage was skipped, which short-circuits the whole
   * nested workflow: no manifest call, no fan-out, no write.
   */
  skipped: z.boolean(),
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
  resumeSchema: gateResumeSchema,
  suspendSchema: gateSuspendSchema,
  execute: async ({ inputData, mastra, resumeData, suspend, retryCount }) => {
    try {
      const { postId } = inputData
      const stageStartedAtMs = Date.now()

      const state = await loadPipelineState(postId)
      if (!shouldRunStage("images", inputData, state.stageStatus)) {
        // The `continue` in Python's stage loop, expressed one step earlier than
        // the other stages express it: the skip has to be decided before the
        // manifest call, and the two steps behind the fan-out read it from here.
        return {
          postId,
          stages: inputData.stages,
          skipped: true,
          stageStartedAtMs,
          model: "",
          tokensIn: 0,
          tokensOut: 0,
          parseFailed: false,
          manifest: {},
          images: [],
        }
      }

      // The gate sits immediately after the skip check and before anything the
      // stage spends, which is where Python put it: a paused stage bills nothing.
      const gate = await reviewGate("images", inputData, state.stageSettings, resumeData)
      if (gate) return suspend(gate)
      await announceStageStart(mastra, "images", inputData)
      const rules = loadRules("images")
      // Python's first two progress lines, in the positions `images_node`
      // wrote them: once the rules are read, and again immediately before
      // Claude is called.
      await publishStageLog(mastra, postId, "images", "Rules loaded, building prompt...")
      const prompt = buildStagePrompt("images", rules, state)

      await publishStageLog(mastra, postId, "images", "Calling Claude for image manifest...")
      const result = await mastra.getAgent("images").generate(prompt)

      const tokensOut = result.usage?.outputTokens ?? 0
      // Ahead of the parse, which is where Python wrote it: a manifest that
      // turns out to be prose has still been paid for, and the line that says
      // what it cost goes out before the line that says it was unusable.
      await publishStageLog(mastra, postId, "images", `Manifest received (${tokensOut} tokens)`)

      const meta = {
        postId,
        stages: inputData.stages,
        skipped: false,
        stageStartedAtMs,
        model: result.response?.modelId ?? "",
        tokensIn: result.usage?.inputTokens ?? 0,
        tokensOut,
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
        // Python published this rather than logging it, so it goes on the event
        // bus and onto the row's trail. The two `data` keys are its own, and
        // this is one of only three call sites in the whole pipeline that pass
        // any.
        await publishStageLog(
          mastra,
          postId,
          "images",
          `Manifest parse failed: ${String(manifest.error)}`,
          {
            level: "warning",
            data: { error: manifest.error, raw_snippet: rawSnippet(result.text) },
          },
        )
        return { ...meta, parseFailed: true, manifest, images: [] }
      }

      // `manifest.get("images", [])`: absent is `[]`, and an explicit `null`
      // is *not*, which is why this tests key presence rather than using `??`.
      // A present non-array value fails the schema here, where Python would
      // enumerate whatever it is (`len(None)` raises, a string yields its
      // characters). Neither golden fixture has one and no rule in
      // `rules/blog-images.md` asks for one, so the divergence stays a hard
      // error rather than an invented behaviour.
      const images = imagesManifestOutputSchema.shape.images.parse(
        "images" in manifest ? manifest.images : [],
      )
      // Python's `num_images` line, written from the parsed manifest one
      // statement before it created the media directory and the Gemini client.
      // Both of those are the workflow's `.map()` in this port, so the line
      // stays here: it is about the manifest, not about the fan-out, and
      // computing the count is what raises on a null `images` in both stacks.
      await publishStageLog(
        mastra,
        postId,
        "images",
        `Generating ${images.length} images via Gemini...`,
      )

      return { ...meta, parseFailed: false, manifest, images }
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
