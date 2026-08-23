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

export const writeStep = createStep({
  id: "write",
  inputSchema: stageStepInputSchema,
  outputSchema: stageStepOutputSchema,
  resumeSchema: gateResumeSchema,
  suspendSchema: gateSuspendSchema,
  execute: async ({ inputData, mastra, resumeData, suspend, retryCount }) => {
    try {
      const { postId } = inputData
      const state = await loadPipelineState(postId)
      if (!shouldRunStage("write", inputData, state.stageStatus)) {
        return skippedStageOutput(inputData, "write")
      }

      // The gate sits immediately after the skip check and before anything the
      // stage spends, which is where Python put it: a paused stage bills nothing.
      const gate = await reviewGate("write", inputData, state.stageSettings, resumeData)
      if (gate) return suspend(gate)
      await announceStageStart(mastra, "write", inputData)
      const rules = loadRules("write")
      // Python's three progress lines, in the three positions
      // `write_node` wrote them: after the rules are read, before the
      // provider is called, and once it has answered.
      await publishStageLog(mastra, postId, "write", "Rules loaded, building prompt...")
      const prompt = buildStagePrompt("write", rules, state)

      await publishStageLog(
        mastra,
        postId,
        "write",
        "Calling Claude for draft (up to 16k tokens)...",
      )
      const startedAt = Date.now()
      const result = await mastra.getAgent("write").generate(prompt)
      const durationMs = Date.now() - startedAt

      const tokensOut = result.usage?.outputTokens ?? 0
      const durationS = durationMs / 1000
      await publishStageLog(
        mastra,
        postId,
        "write",
        `Received ${tokensOut} tokens in ${formatSeconds(durationS)}s`,
      )

      await saveStageOutput(postId, "write", result.text, { write: STATUS_COMPLETE })
      await markRerunComplete(inputData)

      const output = {
        postId,
        stages: inputData.stages,
        stage: "write" as const,
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
      await recordStageRetry("write", inputData.postId, retryCount, error)
      throw error
    }
  },
})
