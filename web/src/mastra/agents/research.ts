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

/**
 * Mastra's model-router prefix for this stage's provider. The model id itself
 * is resolved per call from the owning user's `stage_models` setting (item
 * 6.2b), falling back to item 6.1's verified `sonar-pro`.
 *
 * `sonar-pro` is carried over unchanged from `PerplexityClient.chat()`'s
 * default, and ledger item 6.1 kept it. Of the four Sonar models Perplexity
 * documents, only `sonar` and `sonar-pro` pair live web grounding with the
 * citations this stage's link extraction depends on, `sonar` is the weaker of
 * the two, and `sonar-deep-research` is a report generator priced and paced
 * for a different job. A live call in item 6.1 returned 17 citations, so the
 * grounding the stage relies on is intact.
 *
 * The router resolves `perplexity/*` from `@mastra/core`'s bundled provider
 * registry, so no `@ai-sdk/perplexity` dependency is needed.
 */
export const RESEARCH_ROUTER_PREFIX = "perplexity/"

/** The provider id `research` draws its credential from. */
export const RESEARCH_PROVIDER = "perplexity" as const

/**
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
    // See `claudeStageModel` for why the id needs an annotated binding.
    const id: `${string}/${string}` = `${RESEARCH_ROUTER_PREFIX}${model}`
    return { id, apiKey: await requireApiKey(RESEARCH_PROVIDER) }
  },
})
