/**
 * The `outline` stage as a Mastra step, ported from `outline_node` in
 * `api/src/pipeline/stages/outline.py`.
 *
 * Unlike `research`, this stage has no validator and no retry loop: Python
 * calls Claude once and keeps whatever comes back. So the step's whole job is
 * the state contract, reading the run's state from the posts table, rendering
 * `rules/blog-outline.md` against it, and committing the result to
 * `posts.outline_content` before it returns.
 */
import { createStep } from "@mastra/core/workflows/evented"

import { loadPipelineState, saveStageOutput } from "../post-state"
import { buildStagePrompt, loadRules } from "../prompts"
import { STATUS_COMPLETE } from "../state"
import {
  announceStageStart,
  gateResumeSchema,
  gateSuspendSchema,
  markRerunComplete,
  reviewGate,
  shouldRunStage,
  skippedStageOutput,
  stageStepInputSchema,
  stageStepOutputSchema,
} from "./stage-io"

export const outlineStep = createStep({
  id: "outline",
  inputSchema: stageStepInputSchema,
  outputSchema: stageStepOutputSchema,
  resumeSchema: gateResumeSchema,
  suspendSchema: gateSuspendSchema,
  execute: async ({ inputData, mastra, resumeData, suspend }) => {
    const { postId } = inputData
    const state = await loadPipelineState(postId)
    if (!shouldRunStage("outline", inputData, state.stageStatus)) {
      return skippedStageOutput(inputData, "outline")
    }

    // The gate sits immediately after the skip check and before anything the
    // stage spends, which is where Python put it: a paused stage bills nothing.
    const gate = await reviewGate("outline", inputData, state.stageSettings, resumeData)
    if (gate) return suspend(gate)
    await announceStageStart(mastra, "outline", inputData)
    const prompt = buildStagePrompt("outline", loadRules("outline"), state)

    const startedAt = Date.now()
    const result = await mastra.getAgent("outline").generate(prompt)
    const durationMs = Date.now() - startedAt

    await saveStageOutput(postId, "outline", result.text, { outline: STATUS_COMPLETE })
    await markRerunComplete(inputData)

    return {
      postId,
      stages: inputData.stages,
      stage: "outline" as const,
      skipped: false,
      // The provider's own reported model id, not the one requested, so a
      // silent server-side alias shows up in the run trace.
      model: result.response?.modelId ?? "",
      tokensIn: result.usage?.inputTokens ?? 0,
      tokensOut: result.usage?.outputTokens ?? 0,
      durationS: durationMs / 1000,
    }
  },
})
