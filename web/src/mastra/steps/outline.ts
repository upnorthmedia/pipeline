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
  stageAgentOptions,
  stageStepInputSchema,
  stageStepOutputSchema,
} from "./stage-io"

export const outlineStep = createStep({
  id: "outline",
  inputSchema: stageStepInputSchema,
  outputSchema: stageStepOutputSchema,
  resumeSchema: gateResumeSchema,
  suspendSchema: gateSuspendSchema,
  execute: async ({ inputData, mastra, resumeData, suspend, retryCount }) => {
    try {
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
      const rules = loadRules("outline")
      // Python's three progress lines, in the three positions
      // `outline_node` wrote them: after the rules are read, before the
      // provider is called, and once it has answered.
      await publishStageLog(mastra, postId, "outline", "Rules loaded, building prompt...")
      const prompt = buildStagePrompt("outline", rules, state)

      await publishStageLog(mastra, postId, "outline", "Calling Claude for outline...")
      const startedAt = Date.now()
      const agentOptions = await stageAgentOptions(postId)
      const result = await mastra.getAgent("outline").generate(prompt, agentOptions)
      const durationMs = Date.now() - startedAt

      const tokensOut = result.usage?.outputTokens ?? 0
      const durationS = durationMs / 1000
      await publishStageLog(
        mastra,
        postId,
        "outline",
        `Received ${tokensOut} tokens in ${formatSeconds(durationS)}s`,
      )

      await saveStageOutput(postId, "outline", result.text, { outline: STATUS_COMPLETE })
      await markRerunComplete(inputData)

      const output = {
        postId,
        stages: inputData.stages,
        stage: "outline" as const,
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
      await recordStageRetry("outline", inputData.postId, retryCount, error)
      throw error
    }
  },
})
