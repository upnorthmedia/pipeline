/**
 * The `write` stage as a Mastra step, ported from `write_node` in
 * `api/src/pipeline/stages/write.py`.
 *
 * Structurally identical to `outline`: no validator, no retry loop, one Claude
 * call wrapped in the state contract. What differs is the chain input (the
 * outline rather than the research document), the token budget and the column
 * the result is committed to.
 */
import { createStep } from "@mastra/core/workflows/evented"

import { loadPipelineState, saveStageOutput } from "../post-state"
import { buildStagePrompt, loadRules } from "../prompts"
import { STATUS_COMPLETE } from "../state"
import {
  gateResumeSchema,
  gateSuspendSchema,
  markRerunComplete,
  reviewGate,
  shouldRunStage,
  skippedStageOutput,
  stageStepInputSchema,
  stageStepOutputSchema,
} from "./stage-io"

export const writeStep = createStep({
  id: "write",
  inputSchema: stageStepInputSchema,
  outputSchema: stageStepOutputSchema,
  resumeSchema: gateResumeSchema,
  suspendSchema: gateSuspendSchema,
  execute: async ({ inputData, mastra, resumeData, suspend }) => {
    const { postId } = inputData
    const state = await loadPipelineState(postId)
    if (!shouldRunStage("write", inputData, state.stageStatus)) {
      return skippedStageOutput(inputData, "write")
    }

    // The gate sits immediately after the skip check and before anything the
    // stage spends, which is where Python put it: a paused stage bills nothing.
    const gate = await reviewGate("write", inputData, state.stageSettings, resumeData)
    if (gate) return suspend(gate)
    const prompt = buildStagePrompt("write", loadRules("write"), state)

    const startedAt = Date.now()
    const result = await mastra.getAgent("write").generate(prompt)
    const durationMs = Date.now() - startedAt

    await saveStageOutput(postId, "write", result.text, { write: STATUS_COMPLETE })
    await markRerunComplete(inputData)

    return {
      postId,
      stages: inputData.stages,
      stage: "write" as const,
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
