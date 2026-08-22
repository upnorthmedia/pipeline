/**
 * The `images` stage's Claude agent, ported from `images_node` in
 * `api/src/pipeline/stages/images.py`.
 *
 * Provider-facing half of step 1 only: which model produces the image
 * manifest, with which system message, which token budget and which
 * credential. Recovering the manifest from Claude's answer is item 3.5a
 * (`images/manifest.ts`), Gemini generation is item 3.5d, and prompt assembly,
 * `.foreach()` fan-out and persistence belong to the step in `steps/images.ts`
 * (item 3.5e).
 *
 * `images` is the only stage that talks to two providers, so the agent name is
 * deliberately the stage name: the Gemini half is not an `Agent` at all, since
 * `generate_image` returns bytes rather than text and has no system message,
 * message list or tool surface for an `Agent` to wrap.
 */
import { Agent } from "@mastra/core/agent"

import { requireApiKey } from "../api-keys"
import { CLAUDE_PROVIDER, claudeStageOptions } from "./claude"

/**
 * The `system=` string Python sends on the manifest call, byte-identical to
 * what both golden fixtures recorded. The spaces at the literal boundaries are
 * Python's, so this reads as four adjacent string literals the same way the
 * source does.
 */
export const IMAGES_SYSTEM_MESSAGE =
  "You are an expert at crafting image generation " +
  "prompts. Create a JSON image manifest with " +
  "detailed prompts for each image placement. " +
  "Output ONLY valid JSON, no code fences."

/**
 * Python's `max_tokens=8000` for this stage. Like `outline`, it sits below the
 * extended-thinking floor, so the value that actually reaches Anthropic is
 * 11024; see `claudeStageOptions`.
 */
export const IMAGES_MAX_TOKENS = 8_000

/**
 * The incumbent model, carried over unchanged from `ClaudeClient.chat()`'s
 * default. Choosing a stronger model is ledger item 6.1, where the live
 * verification and the cost comparison for every stage happen together.
 */
export const IMAGES_MODEL_ID = "anthropic/claude-opus-4-6" as const

export const imagesAgent = new Agent({
  id: "images",
  name: "images",
  description: "Writes the JSON image manifest that drives per-image generation.",
  instructions: IMAGES_SYSTEM_MESSAGE,
  // Resolved per call, so rotating the key on the settings page takes effect
  // without restarting the worker and importing this module never touches the
  // database.
  model: async () => ({
    id: IMAGES_MODEL_ID,
    apiKey: await requireApiKey(CLAUDE_PROVIDER),
  }),
  defaultOptions: claudeStageOptions(IMAGES_MAX_TOKENS),
})
