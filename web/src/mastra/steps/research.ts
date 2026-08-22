/**
 * The `research` stage as a Mastra step, ported from `research_node` in
 * `api/src/pipeline/stages/research.py`.
 *
 * The step owns everything around the provider call: reading the run's state
 * from the posts table, assembling the prompt from `rules/blog-research.md`,
 * the meta-response retry loop, and committing the output to
 * `posts.research_content` before it returns. The agent (`agents/research.ts`)
 * owns only the model, the system message and the credential.
 *
 * The retry loop is the reason this stage is not a bare `createStep(agent)`.
 * Perplexity is a search assistant by default and answers a research brief with
 * a description of itself often enough that Python grew a validator and two
 * reinforced retries around it; dropping that would quietly regress research
 * quality on exactly the runs that already fail.
 */
import { createStep } from "@mastra/core/workflows/evented"

import { loadPipelineState, saveStageOutput } from "../post-state"
import { buildStagePrompt, loadRules } from "../prompts"
import { STATUS_COMPLETE } from "../state"
import {
  skippedStageOutput,
  shouldRunStage,
  stageStepInputSchema,
  stageStepOutputSchema,
} from "./stage-io"

/** Python's `MAX_RESEARCH_ATTEMPTS`. */
export const MAX_RESEARCH_ATTEMPTS = 3

/**
 * Phrases that mark a meta-response rather than research, from Python's
 * `_REFUSAL_PATTERNS`. Kept as the same alternation under the same
 * case-insensitive flag so both stacks reject the same responses; the patterns
 * use no Python-only regex syntax, so they port across verbatim.
 */
export const REFUSAL_PATTERNS = [
  String.raw`I'm\s+\*?\*?Perplexity\*?\*?`,
  String.raw`I(?:'m| am) a search assistant`,
  String.raw`I need to clarify my role`,
  String.raw`I(?:'m| am) not a blog research agent`,
  String.raw`I can(?:not|'t) (?:create|execute|generate|access)`,
  String.raw`What I \*?can\*? do instead`,
  String.raw`To move forward`,
  String.raw`Please provide (?:either|new search results)`,
  String.raw`Which would be most helpful\?`,
]

const REFUSAL_RE = new RegExp(REFUSAL_PATTERNS.join("|"), "i")

/** Sections a valid research document is expected to cover. */
export const EXPECTED_SECTIONS = ["keyword", "pain point", "competitor", "search intent"]

/**
 * True when the response looks like research rather than a meta-response:
 * no refusal phrasing, and at least two of the expected sections mentioned.
 */
export function isValidResearch(content: string): boolean {
  if (REFUSAL_RE.test(content)) return false
  const lower = content.toLowerCase()
  const matches = EXPECTED_SECTIONS.filter((section) => lower.includes(section)).length
  return matches >= 2
}

/** Python's `_reinforced_prompt`: the retry preamble, byte-identical. */
export function reinforcedPrompt(prompt: string): string {
  return (
    "IMPORTANT: You must respond with ONLY the research document content. " +
    "Do NOT describe yourself, your limitations, or ask questions. " +
    "Do NOT say you are Perplexity or a search assistant. " +
    "Simply produce the research document as specified.\n\n" + prompt
  )
}

export const researchStep = createStep({
  id: "research",
  inputSchema: stageStepInputSchema,
  outputSchema: stageStepOutputSchema,
  execute: async ({ inputData, mastra }) => {
    const { postId } = inputData
    const state = await loadPipelineState(postId)
    if (!shouldRunStage("research", inputData, state.stageStatus)) {
      return skippedStageOutput(inputData, "research")
    }
    const prompt = buildStagePrompt("research", loadRules("research"), state)
    const agent = mastra.getAgent("research")

    let text = ""
    let model = ""
    let tokensIn = 0
    let tokensOut = 0
    let durationMs = 0

    for (let attempt = 1; attempt <= MAX_RESEARCH_ATTEMPTS; attempt += 1) {
      const startedAt = Date.now()
      const result = await agent.generate(attempt === 1 ? prompt : reinforcedPrompt(prompt))
      durationMs += Date.now() - startedAt

      text = result.text
      model = result.response?.modelId ?? model
      // Python sums usage across every attempt, so a run that retried is billed
      // and reported for all of its calls rather than only the surviving one.
      tokensIn += result.usage?.inputTokens ?? 0
      tokensOut += result.usage?.outputTokens ?? 0

      if (isValidResearch(text)) break

      mastra.getLogger()?.warn("research attempt returned a meta-response, retrying", {
        postId,
        attempt,
        maxAttempts: MAX_RESEARCH_ATTEMPTS,
      })
    }

    if (!isValidResearch(text)) {
      // Python keeps the last response rather than failing the run: degraded
      // research still lets a human read the post detail page and rerun the
      // stage, where a hard failure would leave the column empty.
      mastra.getLogger()?.error("all research attempts returned meta-responses, using the last", {
        postId,
      })
    }

    await saveStageOutput(postId, "research", text, {
      ...state.stageStatus,
      research: STATUS_COMPLETE,
    })

    return {
      postId,
      stages: inputData.stages,
      stage: "research" as const,
      skipped: false,
      model,
      tokensIn,
      tokensOut,
      durationS: durationMs / 1000,
    }
  },
})
