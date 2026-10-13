/**
 * The `outline` stage's agent, ported from `outline_node` in
 * `api/src/pipeline/stages/outline.py`.
 *
 * Provider-facing half only: which model runs the stage, with which system
 * message, which token budget and which credential. Prompt assembly and
 * persistence belong to the step in `steps/outline.ts`.
 */
import { Agent } from "@mastra/core/agent"

import { claudeStageDefaultOptions, claudeStageModel } from "./claude"

/**
 * The `system=` string Python sends on every outline call, byte-identical so
 * both stacks tell the model the same thing while they coexist.
 */
export const OUTLINE_SYSTEM_MESSAGE =
  "You are an expert content strategist. " + "Create detailed, SEO-optimized blog outlines."

/**
 * Python's `max_tokens=8000` for this stage. It sits below the thinking
 * budget's floor, so the value that actually reaches Anthropic is 11024; see
 * `claudeStageOptions`.
 */
export const OUTLINE_MAX_TOKENS = 8_000

export const outlineAgent = new Agent({
  id: "outline",
  name: "outline",
  description: "Turns the research document into a structured, SEO-optimized blog outline.",
  instructions: OUTLINE_SYSTEM_MESSAGE,
  // Both are resolved per call: the model and effort from the owning user's
  // `stage_models` setting (item 6.2b), the credential so that rotating the key
  // on the settings page takes effect without restarting the worker. Neither
  // touches the database at import time.
  model: claudeStageModel("outline"),
  defaultOptions: claudeStageDefaultOptions("outline", OUTLINE_MAX_TOKENS),
})
