/**
 * The call settings every Claude-backed stage shares, ported from
 * `ClaudeClient.chat()` in `api/src/services/llm.py`.
 *
 * Four of the six stages (`outline`, `write`, `edit`, `ready`) go through that
 * one Python method with nothing but `max_tokens` and the system message
 * differing, so the extended-thinking configuration lives here rather than
 * being copied into each agent.
 *
 * **Token-budget divergence, and why the arithmetic looks odd.** Anthropic's
 * `max_tokens` is the total budget and thinking tokens count against it, which
 * is what Python's `effective_max = max(max_tokens, thinking_budget + 1024)`
 * assumes. The AI SDK provider inside `@mastra/core` instead treats
 * `maxOutputTokens` as the text budget and puts `max_tokens = maxOutputTokens +
 * budget_tokens` on the wire. Subtracting the thinking budget here is what makes
 * the two stacks send the same `max_tokens`, which the golden fixtures pin.
 * Verified against `node_modules/@mastra/core/dist/dist-BcUqNSEb.js`
 * (`baseArgs.max_tokens = maxTokens + thinkingBudget`).
 */

/** `ClaudeClient.chat()`'s `thinking_budget` default. */
export const CLAUDE_THINKING_BUDGET_TOKENS = 10_000

/** The 1024-token floor Python leaves for text above the thinking budget. */
export const CLAUDE_MIN_TEXT_TOKENS = 1_024

/** Python's `effective_max`: the `max_tokens` value that reaches Anthropic. */
export function claudeEffectiveMaxTokens(maxTokens: number): number {
  return Math.max(maxTokens, CLAUDE_THINKING_BUDGET_TOKENS + CLAUDE_MIN_TEXT_TOKENS)
}

/**
 * Agent `defaultOptions` reproducing one Python `ClaudeClient.chat(max_tokens=…)`
 * call, with extended thinking enabled at the shared budget.
 */
export function claudeStageOptions(maxTokens: number) {
  return {
    modelSettings: {
      maxOutputTokens: claudeEffectiveMaxTokens(maxTokens) - CLAUDE_THINKING_BUDGET_TOKENS,
    },
    providerOptions: {
      anthropic: {
        thinking: { type: "enabled" as const, budgetTokens: CLAUDE_THINKING_BUDGET_TOKENS },
      },
    },
  }
}

/** The provider id every Claude stage draws its credential from. */
export const CLAUDE_PROVIDER = "anthropic" as const
