/**
 * The `ready` stage's agent, ported from `ready_node` in
 * `api/src/pipeline/stages/ready.py`.
 *
 * Provider-facing half only: which model runs the stage, with which system
 * message, which token budget and which credential. Prompt assembly and
 * persistence belong to the step in `steps/ready.ts`.
 *
 * This is the fourth and last Claude stage, and the plainest one: `ready_node`
 * makes a single call with no validator, no retry and no post-processing, so
 * everything specific to it is in this file and the prompt builder.
 */
import { Agent } from "@mastra/core/agent"

import { requireApiKey } from "../api-keys"
import { CLAUDE_PROVIDER, claudeStageOptions } from "./claude"

/**
 * The `system=` string Python sends on every ready call, byte-identical to what
 * both golden fixtures recorded. The line breaks in the source are Python's
 * adjacent string literals, which concatenate without a separator, so the
 * message reaches the provider as one unbroken line.
 */
export const READY_SYSTEM_MESSAGE =
  "You are a publishing specialist. Compose the final " +
  "publication-ready article by inserting images at strategic " +
  "placements, reformatting the frontmatter, and stripping " +
  "publishing notes. Output ONLY the final article content, " +
  "no explanations or commentary."

/**
 * Python's `max_tokens=16000` for this stage, the same budget `write` and
 * `edit` use and likewise already above the extended-thinking floor; see
 * `claudeStageOptions`.
 */
export const READY_MAX_TOKENS = 16_000

/**
 * The incumbent model, carried over unchanged from `ClaudeClient.chat()`'s
 * default. Choosing a stronger model is ledger item 6.1, where the live
 * verification and the cost comparison for every stage happen together.
 */
export const READY_MODEL_ID = "anthropic/claude-opus-4-6" as const

export const readyAgent = new Agent({
  id: "ready",
  name: "ready",
  description: "Assembles the final publishable article with generated images inline.",
  instructions: READY_SYSTEM_MESSAGE,
  // Resolved per call, so rotating the key on the settings page takes effect
  // without restarting the worker and importing this module never touches the
  // database.
  model: async () => ({
    id: READY_MODEL_ID,
    apiKey: await requireApiKey(CLAUDE_PROVIDER),
  }),
  defaultOptions: claudeStageOptions(READY_MAX_TOKENS),
})
