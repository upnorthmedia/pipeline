/**
 * The `ready` stage as a Mastra step, ported from `ready_node` in
 * `api/src/pipeline/stages/ready.py`.
 *
 * The last stage, and the only one whose prompt is not built by the shared
 * `build_stage_prompt`. `ready_node` has a private `_build_ready_prompt` that
 * drops the thirteen-field configuration block and the previous-stage section
 * in favour of three lines of post configuration, the edited markdown, and the
 * image manifest filtered down to the images that actually got generated. That
 * divergence is the substance of this port, so the builder is exported and
 * tested on its own.
 *
 * Everything else is the plain stage contract: one Claude call, no validator,
 * no retry, and the answer committed to `posts.ready_content` before returning.
 */
import { createStep } from "@mastra/core/workflows/evented"

import { loadPipelineState, saveStageOutput } from "../post-state"
import type { PipelineState } from "../post-state"
import { loadRules, pythonJsonDumps } from "../prompts"
import { STATUS_COMPLETE } from "../state"
import { pythonTruthy } from "./images-manifest"
import type { JsonValue } from "./images-manifest"
import {
  announceStageComplete,
  announceStageStart,
  formatSeconds,
  gateResumeSchema,
  gateSuspendSchema,
  markRerunComplete,
  publishStageLog,
  recordStageRetry,
  reviewGate,
  shouldRunStage,
  skippedStageOutput,
  stageStepInputSchema,
  stageStepOutputSchema,
} from "./stage-io"

/** The separator `_build_ready_prompt` joins its sections with. */
const SECTION_SEPARATOR = "\n\n---\n\n"

/**
 * `[img for img in images if img.get("generated", False)]`.
 *
 * The manifest is a JSONB document written from whatever Claude answered with,
 * so `generated` is only a boolean by convention. Python tests its truthiness,
 * which is why this does too rather than comparing to `true`: a manifest
 * carrying `"generated": "yes"` reaches the model in Python and must here.
 *
 * A non-object entry raises `AttributeError` out of the Python stage, so it
 * throws here as well instead of being silently dropped.
 */
export function generatedImages(images: unknown[]): unknown[] {
  return images.filter((image, index) => {
    if (typeof image !== "object" || image === null || Array.isArray(image)) {
      throw new TypeError(`image manifest entry ${index} is not an object`)
    }
    return pythonTruthy((image as Record<string, JsonValue>).generated)
  })
}

/**
 * `_build_ready_prompt`: rules, three lines of post configuration, the edited
 * markdown, and the generated-images-only manifest, joined by a markdown rule.
 *
 * `today` is injectable for the same reason `buildStagePrompt`'s is: the
 * configuration block stamps TODAY_DATE from the clock, and the parity tests
 * pin it to the date the golden fixture was captured.
 */
export function buildReadyPrompt(
  rules: string,
  state: PipelineState,
  today: string = new Date().toISOString().slice(0, 10),
): string {
  const sections: string[] = []

  if (rules) sections.push(rules)

  sections.push(
    `## Post Configuration\n\n- **SLUG**: ${state.slug}\n` +
      `- **OUTPUT_FORMAT**: ${state.outputFormat}\n` +
      `- **TODAY_DATE**: ${today}`,
  )

  // The edit stage's committed output. Suppressed entirely when empty, so a
  // `ready` run on a post that never made it through `edit` sends the rules and
  // the configuration rather than an empty section.
  if (state.finalMd) {
    sections.push(`## Final Markdown Content (from edit stage)\n\n${state.finalMd}`)
  }

  const manifest = state.imageManifest
  // `if manifest:` in Python, where an empty dict is falsy. `{}` is truthy in
  // JavaScript, so the emptiness has to be tested explicitly or a post with no
  // images would get a section Python omits.
  if (Object.keys(manifest).length > 0) {
    // `manifest.get("images", [])`: absent is `[]`, and an explicit `null` is
    // not, which is why this tests key presence rather than using `??`. A
    // present non-array raises out of the Python comprehension, so it throws
    // here too.
    const images = "images" in manifest ? manifest.images : []
    if (!Array.isArray(images)) {
      throw new TypeError(
        `image manifest 'images' is ${images === null ? "null" : typeof images}, not an array`,
      )
    }
    // `{**manifest, "images": generated_images}` replaces the value in place, so
    // `images` keeps its original position in the document rather than moving to
    // the end. `json.dumps` preserves insertion order and the prompt is compared
    // byte for byte, so the spread order matters.
    const filtered = { ...manifest, images: generatedImages(images) }
    sections.push(
      "## Image Manifest (generated images only)\n\n" +
        `\`\`\`json\n${pythonJsonDumps(filtered)}\n\`\`\``,
    )
  }

  return sections.join(SECTION_SEPARATOR)
}

export const readyStep = createStep({
  id: "ready",
  inputSchema: stageStepInputSchema,
  outputSchema: stageStepOutputSchema,
  resumeSchema: gateResumeSchema,
  suspendSchema: gateSuspendSchema,
  execute: async ({ inputData, mastra, resumeData, suspend, retryCount }) => {
    try {
      const { postId } = inputData
      const state = await loadPipelineState(postId)
      if (!shouldRunStage("ready", inputData, state.stageStatus)) {
        return skippedStageOutput(inputData, "ready")
      }

      // The gate sits immediately after the skip check and before anything the
      // stage spends, which is where Python put it: a paused stage bills nothing.
      const gate = await reviewGate("ready", inputData, state.stageSettings, resumeData)
      if (gate) return suspend(gate)
      await announceStageStart(mastra, "ready", inputData)
      const rules = loadRules("ready")
      // Python's three progress lines, in the three positions
      // `ready_node` wrote them: after the rules are read, before the
      // provider is called, and once it has answered.
      await publishStageLog(mastra, postId, "ready", "Rules loaded, building prompt...")
      const prompt = buildReadyPrompt(rules, state)

      await publishStageLog(mastra, postId, "ready", "Calling Claude for final assembly...")
      const startedAt = Date.now()
      const result = await mastra.getAgent("ready").generate(prompt)
      const durationMs = Date.now() - startedAt

      const tokensOut = result.usage?.outputTokens ?? 0
      const durationS = durationMs / 1000
      await publishStageLog(
        mastra,
        postId,
        "ready",
        `Assembly done (${tokensOut} tokens, ${formatSeconds(durationS)}s)`,
      )

      await saveStageOutput(postId, "ready", result.text, { ready: STATUS_COMPLETE })
      await markRerunComplete(inputData)

      const output = {
        postId,
        stages: inputData.stages,
        stage: "ready" as const,
        skipped: false,
        // The provider's own reported model id, not the one requested, so a
        // silent server-side alias shows up in the run trace.
        model: result.response?.modelId ?? "",
        tokensIn: result.usage?.inputTokens ?? 0,
        tokensOut,
        durationS,
      }
      await announceStageComplete(mastra, output)
      return output
    } catch (error) {
      // Python's `warning` / `retry` entry, from the `except` block that
      // wrapped the whole stage loop. Only this side of the throw can see the
      // attempt number, so the record is written here and the error is rethrown
      // unchanged for the engine to retry or fail on.
      await recordStageRetry("ready", inputData.postId, retryCount, error)
      throw error
    }
  },
})
