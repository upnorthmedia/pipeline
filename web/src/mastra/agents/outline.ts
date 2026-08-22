/**
 * The `outline` stage's agent, ported from `outline_node` in
 * `api/src/pipeline/stages/outline.py`.
 *
 * Provider-facing half only: which model runs the stage, with which system
 * message, which token budget and which credential. Prompt assembly and
 * persistence belong to the step in `steps/outline.ts`.
 */
import { Agent } from "@mastra/core/agent"

import { requireApiKey } from "../api-keys"
import { CLAUDE_PROVIDER, claudeStageOptions } from "./claude"

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

/**
 * The incumbent model, carried over unchanged from `ClaudeClient.chat()`'s
 * default. Choosing a stronger model is ledger item 6.1, where the live
 * verification and the cost comparison for every stage happen together.
 */
export const OUTLINE_MODEL_ID = "anthropic/claude-opus-4-6" as const

export const outlineAgent = new Agent({
  id: "outline",
  name: "outline",
  description: "Turns the research document into a structured, SEO-optimized blog outline.",
  instructions: OUTLINE_SYSTEM_MESSAGE,
  // Resolved per call, so rotating the key on the settings page takes effect
  // without restarting the worker and importing this module never touches the
  // database.
  model: async () => ({
    id: OUTLINE_MODEL_ID,
    apiKey: await requireApiKey(CLAUDE_PROVIDER),
  }),
  defaultOptions: claudeStageOptions(OUTLINE_MAX_TOKENS),
})
