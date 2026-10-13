/**
 * The `research` stage's agent, ported from `research_node` in
 * `api/src/pipeline/stages/research.py`.
 *
 * Only the provider-facing half of the stage lives here: which model runs it,
 * with which system message and which credential. Prompt assembly, the
 * meta-response retry loop and persistence belong to the step that calls this
 * agent, so both halves stay individually testable.
 */
import { Agent } from "@mastra/core/agent"

import { requireApiKey } from "../api-keys"
import { perplexityAgentModel } from "../perplexity/agent-api"
import { resolveStageModel, stageRequestContextUserId } from "../stage-models"

/**
 * The system message Python sends as `system=` on every research call. It is
 * load bearing: Perplexity is a search assistant by default and will answer
 * with a description of itself unless told to produce the document directly.
 * Kept byte-identical to the Python string so the two stacks send the same
 * system prompt while they coexist.
 */
export const RESEARCH_SYSTEM_MESSAGE =
  "You are an expert SEO content researcher. " +
  "Respond ONLY with the research document in markdown format. " +
  "Do not discuss your capabilities or ask clarifying questions. " +
  "Produce the complete research directly."

/** The provider id `research` draws its credential from. */
export const RESEARCH_PROVIDER = "perplexity" as const

/**
 * This stage does not go through Mastra's model router.
 *
 * Perplexity is retiring the Sonar Chat Completions endpoint on 2026-09-27 and
 * points every caller at the Agent API, which nothing installed can reach:
 * `@ai-sdk/perplexity` still builds `${baseURL}/chat/completions`, and the
 * router's own `perplexity/*` entry resolves to that same surface. The reasons
 * each candidate provider fails are in `../perplexity/agent-api.ts`, which is
 * the hand-written `LanguageModelV2` this agent uses instead.
 *
 * The Agent API accepts exactly one Perplexity search model,
 * `perplexity/sonar`; `GET https://api.perplexity.ai/v1/models` lists no other,
 * and `perplexity/sonar-pro` is refused with `model ... is not supported`. So
 * leaving the deprecated endpoint also means leaving `sonar-pro`, which is why
 * the swap waited on an output comparison of the two on this stage's real
 * prompt. Measured 2026-08-24: the Agent API answer was 22,750 characters
 * against 9,708, filled the same rule template, carried 13 distinct source URLs
 * inline against 3, passed `isValidResearch`, and cost $0.0242 against $0.0413.
 *
 * The model id is still resolved per call from the owning user's
 * `stage_models` setting rather than pinned here, so a second verified id can
 * be added to the allowlist without touching this file.
 *
 * The model and the credential are both resolved per call rather than captured
 * at module load, so a settings change (the stored model, or a rotated key)
 * takes effect without restarting the worker, and so importing this module
 * never touches the database (Studio and `next build` both import it).
 */
export const researchAgent = new Agent({
  id: "research",
  name: "research",
  description: "Produces the SEO research document for a post using live web search.",
  instructions: RESEARCH_SYSTEM_MESSAGE,
  model: async ({ requestContext }) => {
    const { model } = await resolveStageModel(
      "research",
      stageRequestContextUserId(requestContext),
    )
    return perplexityAgentModel({
      modelId: model,
      apiKey: await requireApiKey(RESEARCH_PROVIDER),
    })
  },
})
