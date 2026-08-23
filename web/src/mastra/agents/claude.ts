/**
 * The call settings every Claude-backed stage shares, ported from
 * `ClaudeClient.chat()` in `api/src/services/llm.py` and re-tuned for the
 * model chosen in ledger item 6.1.
 *
 * Four of the six stages (`outline`, `write`, `edit`, `ready`) go through that
 * one Python method with nothing but `max_tokens` and the system message
 * differing, plus the image-prompt half of `images`, so the thinking
 * configuration lives here rather than being copied into each agent.
 *
 * **Why the thinking parameter changed shape.** Python sent
 * `thinking={"type": "enabled", "budget_tokens": 10000}`, a fixed reasoning
 * budget. `claude-opus-5` rejects that form with a 400: the fixed-budget
 * concept is gone and adaptive thinking plus `output_config.effort` replaces
 * it, with the model deciding per request how much to reason. Verified live in
 * item 6.1 (`scripts/verify-models.mjs`), where the same request shape used
 * here returned HTTP 200 from `claude-opus-5`.
 *
 * **The wire `max_tokens` is unchanged, and the arithmetic is why.** Anthropic
 * counts thinking tokens against `max_tokens`, which is what Python's
 * `effective_max = max(max_tokens, thinking_budget + 1024)` assumes. The AI SDK
 * provider inside `@mastra/core` computes `max_tokens = maxOutputTokens +
 * thinkingBudget`, and reads `thinkingBudget` only from the `enabled` variant,
 * so under adaptive thinking that second term is zero and `maxOutputTokens` is
 * the wire value verbatim. Passing Python's `effective_max` straight through
 * therefore keeps every stage's total budget exactly what the golden fixtures
 * recorded. Verified against
 * `node_modules/@mastra/core/dist/dist-BcUqNSEb.js` (`baseArgs.max_tokens =
 * maxTokens + (thinkingBudget != null ? thinkingBudget : 0)`).
 */
import type { RequestContext } from "@mastra/core/request-context"

import { requireApiKey } from "../api-keys"
import { type ClaudeEffort, resolveStageModel, stageRequestContextUserId } from "../stage-models"

/**
 * `ClaudeClient.chat()`'s `thinking_budget` default. It no longer reaches the
 * provider: it survives only as the floor term in Python's `max_tokens`
 * arithmetic below, which is kept so the stages' token budgets do not move
 * when the model does.
 */
export const CLAUDE_THINKING_BUDGET_TOKENS = 10_000

/** The 1024-token floor Python leaves for text above the thinking budget. */
export const CLAUDE_MIN_TEXT_TOKENS = 1_024

/** Python's `effective_max`: the `max_tokens` value that reaches Anthropic. */
export function claudeEffectiveMaxTokens(maxTokens: number): number {
  return Math.max(maxTokens, CLAUDE_THINKING_BUDGET_TOKENS + CLAUDE_MIN_TEXT_TOKENS)
}

/**
 * The reasoning depth a Claude stage runs at when nothing is stored for it.
 * `high` is the provider's own default and the setting the objective calls for
 * on the reasoning-heavy stages; `xhigh` and `max` exist above it and cost
 * proportionally more thinking tokens.
 *
 * It is no longer read at the call site: item 6.2b moved every stage onto
 * `resolveStageModel()`, which reaches this value through
 * `STAGE_MODEL_DEFAULTS`. It stays exported because `stage-models.test.ts`
 * asserts the two agree, so the settings page cannot offer a default the
 * pipeline does not run.
 */
export const CLAUDE_DEFAULT_EFFORT = "high" as const

/**
 * Agent `defaultOptions` reproducing one Python `ClaudeClient.chat(max_tokens=…)`
 * call, with adaptive thinking at the given effort.
 */
export function claudeStageOptions(
  maxTokens: number,
  effort: ClaudeEffort = CLAUDE_DEFAULT_EFFORT,
) {
  return {
    modelSettings: {
      maxOutputTokens: claudeEffectiveMaxTokens(maxTokens),
    },
    providerOptions: {
      anthropic: {
        thinking: { type: "adaptive" as const },
        effort,
      },
    },
  }
}

/** The provider id every Claude stage draws its credential from. */
export const CLAUDE_PROVIDER = "anthropic" as const

/** Mastra's model-router prefix for the provider this file configures. */
export const CLAUDE_ROUTER_PREFIX = "anthropic/"

/**
 * The stages whose `stage_models` entry names a Claude model.
 *
 * Narrower than `Stage` on purpose: `images` is on this file's provider for
 * its manifest call but its setting names the Gemini generation model, so
 * resolving it here would put a Gemini id behind an `anthropic/` prefix. That
 * mistake was made once during item 6.2b and this type is what makes it a
 * compile error rather than a 404 from the router.
 */
export type ClaudeStage = "outline" | "write" | "edit" | "ready"

/**
 * The `model` a Claude-backed stage agent runs, resolved per call from the
 * `stage_models` setting of the user carried on the request context (item
 * 6.2b), with item 6.1's verified id as the fallback.
 *
 * Resolved per call rather than captured at module load for the same reason
 * the credential is: a settings change takes effect without restarting the
 * worker, and importing the module never touches the database.
 */
export function claudeStageModel(stage: ClaudeStage) {
  return async ({ requestContext }: { requestContext: RequestContext }) => {
    const { model } = await resolveStageModel(stage, stageRequestContextUserId(requestContext))
    // The router's id type is `${string}/${string}`, which a template built
    // from a `string` does not satisfy on its own, so the prefix is applied
    // through an annotated binding rather than a cast.
    const id: `${string}/${string}` = `${CLAUDE_ROUTER_PREFIX}${model}`
    return { id, apiKey: await requireApiKey(CLAUDE_PROVIDER) }
  }
}

/**
 * The stage's `defaultOptions`, with the effort resolved from the same setting
 * as the model. Mastra resolves this with the request context the call passed,
 * so a user who overrides only `effort` keeps the operator's model.
 */
export function claudeStageDefaultOptions(stage: ClaudeStage, maxTokens: number) {
  return async ({ requestContext }: { requestContext: RequestContext }) => {
    const { effort } = await resolveStageModel(stage, stageRequestContextUserId(requestContext))
    return claudeStageOptions(maxTokens, effort ?? CLAUDE_DEFAULT_EFFORT)
  }
}
