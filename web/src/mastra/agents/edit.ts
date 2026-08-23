/**
 * The `edit` stage's agent, ported from `edit_node` in
 * `api/src/pipeline/stages/edit.py`.
 *
 * Provider-facing half only: which model runs the stage, with which system
 * message, which token budget and which credential. Prompt assembly (including
 * the analytics section), the post-edit validation warnings, link stripping and
 * persistence belong to the step in `steps/edit.ts`, ledger item 3.4e.
 */
import { Agent } from "@mastra/core/agent"

import { requireApiKey } from "../api-keys"
import { CLAUDE_PROVIDER, claudeStageOptions } from "./claude"

/**
 * Python's `format_instruction`, spelled out as its own constant because
 * `edit_node` is the only stage that names it: the comment above it records
 * that the edit stage always emits Markdown regardless of the post's
 * `output_format`, with the WordPress HTML conversion deferred to publish time.
 * It is therefore a constant suffix, not a branch, and the two golden fixtures
 * (one `markdown`, one `wordpress_html`) both recorded this same tail.
 */
export const EDIT_FORMAT_INSTRUCTION = "Output only the final Markdown with YAML frontmatter."

/**
 * The `system=` string Python sends on every edit call, byte-identical to what
 * the golden fixtures recorded. The line breaks are Python's `\n`s inside the
 * numbered requirements; the space-separated joins are where Python's adjacent
 * string literals meet.
 *
 * The em-dashes on the `CRITICAL REQUIREMENTS` line and in requirement 1 are
 * the product's prompt text, carried across verbatim. Changing them would
 * change the bytes the provider sees, which is exactly what this port must not
 * do, so they stay despite the repo's own no-em-dash writing rule.
 */
export const EDIT_SYSTEM_MESSAGE =
  "You are an expert blog editor and SEO specialist. " +
  "CRITICAL REQUIREMENTS — violations will cause rejection:\n" +
  "1. ZERO em-dashes (—) anywhere in output\n" +
  "2. ZERO line separators (---, ***, ___) between sections\n" +
  "3. ALL links must be real, working URLs inserted inline\n" +
  "4. Insert 3-5 internal links from the provided list\n" +
  "5. Insert 3 external links from authoritative sources\n" +
  "6. Primary keyword MUST appear in title, " +
  "first 100 words, and at least one H2\n" +
  "7. Flesch reading ease MUST be 60-70 " +
  "- simplify sentences and vocabulary\n" +
  "8. No filler phrases, no generic AI language\n" +
  "Fix ALL items marked [FAIL] in the analytics section. " +
  EDIT_FORMAT_INSTRUCTION

/**
 * Python's `max_tokens=16000` for this stage, the same budget `write` uses and
 * likewise already above the extended-thinking floor; see `claudeStageOptions`.
 */
export const EDIT_MAX_TOKENS = 16_000

/**
 * The strongest Anthropic model this account can reach at the incumbent's
 * per-token price, adopted in ledger item 6.1 over `claude-opus-4-6`. Its
 * request shape differs: see `claudeStageOptions` for the thinking parameter
 * that came with it.
 */
export const EDIT_MODEL_ID = "anthropic/claude-opus-5" as const

export const editAgent = new Agent({
  id: "edit",
  name: "edit",
  description: "Polishes the draft for SEO, inserts internal and external links.",
  instructions: EDIT_SYSTEM_MESSAGE,
  // Resolved per call, so rotating the key on the settings page takes effect
  // without restarting the worker and importing this module never touches the
  // database.
  model: async () => ({
    id: EDIT_MODEL_ID,
    apiKey: await requireApiKey(CLAUDE_PROVIDER),
  }),
  defaultOptions: claudeStageOptions(EDIT_MAX_TOKENS),
})
