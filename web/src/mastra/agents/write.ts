/**
 * The `write` stage's agent, ported from `write_node` in
 * `api/src/pipeline/stages/write.py`.
 *
 * Provider-facing half only: which model runs the stage, with which system
 * message, which token budget and which credential. Prompt assembly and
 * persistence belong to the step in `steps/write.ts`.
 */
import { Agent } from "@mastra/core/agent"

import { requireApiKey } from "../api-keys"
import { CLAUDE_PROVIDER, claudeStageOptions } from "./claude"

/**
 * The `system=` string Python sends on every write call. Python builds it by
 * concatenating five adjacent string literals, so the spacing here is the
 * concatenated result, byte-identical to what the golden fixtures recorded.
 */
export const WRITE_SYSTEM_MESSAGE =
  "You are an expert blog writer. Write " +
  "engaging, SEO-optimized content following " +
  "the outline exactly. Use a conversational " +
  "tone, short paragraphs, and varied sentence " +
  "structure. Never use em-dashes."

/**
 * Python's `max_tokens=16000` for this stage. Unlike `outline`'s 8000 it is
 * already above the thinking budget's floor, so it reaches Anthropic unchanged;
 * see `claudeStageOptions` for why the arithmetic still runs.
 */
export const WRITE_MAX_TOKENS = 16_000

/**
 * The strongest Anthropic model this account can reach at the incumbent's
 * per-token price, adopted in ledger item 6.1 over `claude-opus-4-6`. Its
 * request shape differs: see `claudeStageOptions` for the thinking parameter
 * that came with it.
 */
export const WRITE_MODEL_ID = "anthropic/claude-opus-5" as const

export const writeAgent = new Agent({
  id: "write",
  name: "write",
  description: "Turns the approved outline into the full blog draft.",
  instructions: WRITE_SYSTEM_MESSAGE,
  // Resolved per call, so rotating the key on the settings page takes effect
  // without restarting the worker and importing this module never touches the
  // database.
  model: async () => ({
    id: WRITE_MODEL_ID,
    apiKey: await requireApiKey(CLAUDE_PROVIDER),
  }),
  defaultOptions: claudeStageOptions(WRITE_MAX_TOKENS),
})
