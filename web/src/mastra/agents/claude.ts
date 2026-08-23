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
 * The reasoning depth every Claude stage runs at until item 6.2 makes it a
 * per-user, per-stage setting. `high` is the provider's own default and the
 * setting the objective calls for on the reasoning-heavy stages; `xhigh` and
 * `max` exist above it and cost proportionally more thinking tokens.
 */
export const CLAUDE_DEFAULT_EFFORT = "high" as const

/**
 * Agent `defaultOptions` reproducing one Python `ClaudeClient.chat(max_tokens=…)`
 * call, with adaptive thinking at the default effort.
 */
export function claudeStageOptions(maxTokens: number) {
  return {
    modelSettings: {
      maxOutputTokens: claudeEffectiveMaxTokens(maxTokens),
    },
    providerOptions: {
      anthropic: {
        thinking: { type: "adaptive" as const },
        effort: CLAUDE_DEFAULT_EFFORT,
      },
    },
  }
}

/** The provider id every Claude stage draws its credential from. */
export const CLAUDE_PROVIDER = "anthropic" as const
