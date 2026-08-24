// @vitest-environment node
/**
 * Ledger item P2.71a: the Agent API client the `research` stage will move to
 * before Sonar Chat Completions stops answering on 2026-09-27.
 *
 * Three kinds of case, none of them assertions about a stub:
 *
 * 1. **Request shape.** The Agent API answers `400 unknown field` for anything
 *    it does not recognise, so the body this client builds is asserted key by
 *    key. The live case at the bottom proves the same body is accepted.
 * 2. **Response mapping**, replayed from `data/agent-grounded-response.json`,
 *    which is a real grounded answer recorded off `POST /v1/agent` on the key
 *    in `settings.api_keys`. It carries the `search_results` output item that
 *    `@ai-sdk/openai`'s Responses schema has no member for, which is the whole
 *    reason this client exists.
 * 3. **Mastra compatibility.** A real `Agent` is constructed with the model
 *    and generates from the recorded body, so a `LanguageModelV2` this stack
 *    will not accept fails here rather than in the worker.
 *
 * The live smoke test skips unless `PERPLEXITY_API_KEY` is set, the same gate
 * the four agent suites use.
 */
import { readFileSync } from "node:fs"
import path from "node:path"

import { Agent } from "@mastra/core/agent"
import { describe, expect, it } from "vitest"

import { stageCostUsd } from "../execution-log"

import {
  PERPLEXITY_AGENT_PROVIDER,
  PERPLEXITY_AGENT_URL,
  PerplexityAgentError,
  agentErrorMessage,
  buildAgentRequest,
  agentReportedCostUsd,
  mapAgentContent,
  mapAgentProviderMetadata,
  mapAgentUsage,
  mapFinishReason,
  perplexityAgentModel,
} from "./agent-api"

/** The model slug the Agent API lists for Perplexity's own search model. */
const MODEL_ID = "perplexity/sonar"

const recorded = JSON.parse(
  readFileSync(path.join(__dirname, "data", "agent-grounded-response.json"), "utf8"),
) as Record<string, unknown>

const LIVE_KEY = process.env.PERPLEXITY_API_KEY

/** A `fetch` that answers every request with one recorded body. */
function servingRecorded(body: unknown, status = 200) {
  const seen: Array<{ url: string; init: RequestInit }> = []
  const impl = (async (url: string | URL | Request, init?: RequestInit) => {
    seen.push({ url: String(url), init: init ?? {} })
    return new Response(typeof body === "string" ? body : JSON.stringify(body), {
      status,
      headers: { "content-type": "application/json" },
    })
  }) as unknown as typeof globalThis.fetch
  return { impl, seen }
}

const SIMPLE_PROMPT = [
  { role: "system" as const, content: "You are an expert SEO content researcher." },
  { role: "user" as const, content: [{ type: "text", text: "Research time tracking tools." }] },
]

describe("the Agent API request body", () => {
  it("sends only the fields the endpoint knows, with web search always offered", () => {
    const { body, warnings } = buildAgentRequest(MODEL_ID, { prompt: SIMPLE_PROMPT })

    expect(Object.keys(body).sort()).toEqual(["input", "model", "tools"])
    expect(body.model).toBe(MODEL_ID)
    expect(body.tools).toEqual([{ type: "web_search" }])
    expect(body.input).toEqual([
      { role: "system", content: "You are an expert SEO content researcher." },
      { role: "user", content: "Research time tracking tools." },
    ])
    expect(warnings).toEqual([])
  })

  it("maps the sampling settings the endpoint accepts under its own names", () => {
    const { body } = buildAgentRequest(MODEL_ID, {
      prompt: SIMPLE_PROMPT,
      maxOutputTokens: 4000,
      temperature: 0.2,
      topP: 0.9,
      frequencyPenalty: 0.1,
      presencePenalty: 0.2,
    })

    expect(body.max_output_tokens).toBe(4000)
    expect(body.temperature).toBe(0.2)
    expect(body.top_p).toBe(0.9)
    expect(body.frequency_penalty).toBe(0.1)
    expect(body.presence_penalty).toBe(0.2)
  })

  it("raises max_output_tokens to the endpoint's floor rather than being rejected", () => {
    const { body, warnings } = buildAgentRequest(MODEL_ID, {
      prompt: SIMPLE_PROMPT,
      maxOutputTokens: 8,
    })

    expect(body.max_output_tokens).toBe(16)
    expect(warnings).toContainEqual(
      expect.objectContaining({ type: "unsupported-setting", setting: "maxOutputTokens" }),
    )
  })

  it("warns rather than sending a setting the endpoint would reject as unknown", () => {
    const { body, warnings } = buildAgentRequest(MODEL_ID, {
      prompt: SIMPLE_PROMPT,
      stopSequences: ["END"],
      seed: 7,
      topK: 4,
      responseFormat: { type: "json" },
      toolChoice: { type: "auto" },
    })

    expect(Object.keys(body).sort()).toEqual(["input", "model", "tools"])
    expect(warnings.map((warning) => "setting" in warning && warning.setting).sort()).toEqual([
      "responseFormat",
      "seed",
      "stopSequences",
      "toolChoice",
      "topK",
    ])
  })

  it("drops a tool message, which the endpoint's input has no role for", () => {
    const { body, warnings } = buildAgentRequest(MODEL_ID, {
      prompt: [
        ...SIMPLE_PROMPT,
        { role: "tool" as const, content: [{ type: "tool-result", text: "ignored" }] },
      ],
    })

    expect((body.input as unknown[]).length).toBe(2)
    expect(warnings).toContainEqual({
      type: "other",
      message: "The Perplexity Agent API takes no tool messages; one was dropped.",
    })
  })
})

describe("the recorded grounded response", () => {
  it("is the shape this client exists for: a search_results item beside the message", () => {
    const types = (recorded.output as Array<{ type: string }>).map((item) => item.type)
    expect(types).toContain("search_results")
    expect(types).toContain("message")
  })

  it("becomes one text part plus a source part for every result with a url", () => {
    const content = mapAgentContent(recorded)
    const sources = content.filter((part) => part.type === "source")
    const texts = content.filter((part) => part.type === "text")

    const results = (recorded.output as Array<{ type: string; results?: unknown[] }>).find(
      (item) => item.type === "search_results",
    )?.results as Array<{ url: string; title: string; id: number }>
    expect(sources).toHaveLength(results.length)
    expect(sources[0]).toEqual({
      type: "source",
      sourceType: "url",
      id: String(results[0].id),
      url: results[0].url,
      title: results[0].title,
    })

    expect(texts).toHaveLength(1)
    expect(texts[0].type === "text" && texts[0].text).toContain("Reykjav")
  })

  it("drops a search result carrying no url, which is not a citation", () => {
    const content = mapAgentContent({
      status: "completed",
      output: [
        {
          type: "search_results",
          results: [{ id: 1, title: "no url here" }, { id: 2, url: "https://example.com" }],
        },
      ],
    })

    expect(content).toEqual([
      { type: "source", sourceType: "url", id: "2", url: "https://example.com" },
    ])
  })

  it("reports the recorded usage under the field names the AI SDK reads", () => {
    const usage = recorded.usage as { input_tokens: number; output_tokens: number }
    expect(mapAgentUsage(recorded)).toMatchObject({
      inputTokens: usage.input_tokens,
      outputTokens: usage.output_tokens,
    })
  })

  /**
   * `MODEL_COSTS` prices tokens only, and this endpoint bills `web_search`
   * separately, so the token estimate is short of the bill by whatever the
   * searches cost. The provider reports its own total, which is what the stage
   * records instead; these cases pin the channel it travels through.
   */
  it("carries the provider's own cost breakdown as provider metadata", () => {
    const cost = (recorded.usage as { cost: Record<string, unknown> }).cost
    expect(mapAgentProviderMetadata(recorded)).toEqual({
      [PERPLEXITY_AGENT_PROVIDER]: { cost },
    })
  })

  it("reports no cost metadata for a response that priced nothing", () => {
    expect(mapAgentProviderMetadata({ usage: { input_tokens: 1 } })).toBeUndefined()
    expect(mapAgentProviderMetadata({})).toBeUndefined()
  })

  it("reads the reported total back off provider metadata, and nothing else", () => {
    expect(agentReportedCostUsd(mapAgentProviderMetadata(recorded))).toBe(
      (recorded.usage as { cost: { total_cost: number } }).cost.total_cost,
    )
    expect(agentReportedCostUsd(undefined)).toBeUndefined()
    // Another provider's metadata is not this provider's bill.
    expect(agentReportedCostUsd({ openai: { cost: { total_cost: 9 } } })).toBeUndefined()
  })
})

describe("the run verdict, which arrives inside a 200 body", () => {
  it("reads completed as stop", () => {
    expect(mapFinishReason(recorded)).toBe("stop")
  })

  it("reads an output-token cutoff as length", () => {
    expect(
      mapFinishReason({
        status: "incomplete",
        incomplete_details: { reason: "max_output_tokens" },
      }),
    ).toBe("length")
  })

  it("does not call a run with no status stopped", () => {
    expect(mapFinishReason({})).toBe("unknown")
  })

  it("throws for a failed run rather than returning an empty document", async () => {
    const { impl } = servingRecorded({ status: "failed", error: { message: "upstream timeout" } })
    const model = perplexityAgentModel({ modelId: MODEL_ID, apiKey: "k", fetchImpl: impl })

    await expect(model.doGenerate({ prompt: SIMPLE_PROMPT })).rejects.toThrow(
      new PerplexityAgentError("upstream timeout", 200),
    )
  })
})

describe("error bodies the endpoint actually returns", () => {
  // Both strings are copied from live 400 responses, recorded while proving
  // the two Perplexity surfaces are disjoint.
  it("surfaces the unknown-field message that is the documented migration trap", () => {
    expect(
      agentErrorMessage(
        400,
        '{"error":{"message":"invalid request body: json: unknown field \\"max_tokens\\"","type":"invalid_request","code":400,"param":"max_tokens"}}',
      ),
    ).toBe('invalid request body: json: unknown field "max_tokens"')
  })

  it("surfaces the unsupported-model message", () => {
    expect(
      agentErrorMessage(
        400,
        '{"error":{"message":"validation failed: model \\"perplexity/nope\\" is not supported","type":"invalid_request","code":400}}',
      ),
    ).toBe('validation failed: model "perplexity/nope" is not supported')
  })

  it("keeps a non-JSON body rather than losing the only clue", () => {
    expect(agentErrorMessage(502, "<html>bad gateway</html>")).toBe("<html>bad gateway</html>")
  })

  it("names the status when the body is empty", () => {
    expect(agentErrorMessage(404, "")).toBe("Perplexity Agent API returned 404")
  })
})

describe("the model as Mastra sees it", () => {
  it("posts to the documented raw-HTTP target with a bearer credential", async () => {
    const { impl, seen } = servingRecorded(recorded)
    const model = perplexityAgentModel({ modelId: MODEL_ID, apiKey: "secret-key", fetchImpl: impl })

    await model.doGenerate({ prompt: SIMPLE_PROMPT })

    expect(seen).toHaveLength(1)
    expect(seen[0].url).toBe(PERPLEXITY_AGENT_URL)
    expect(seen[0].init.method).toBe("POST")
    expect((seen[0].init.headers as Record<string, string>).Authorization).toBe("Bearer secret-key")
    expect(JSON.parse(seen[0].init.body as string).tools).toEqual([{ type: "web_search" }])
  })

  it("reports the provider and the model the response names", async () => {
    const { impl } = servingRecorded(recorded)
    const model = perplexityAgentModel({ modelId: MODEL_ID, apiKey: "k", fetchImpl: impl })

    expect(model.provider).toBe(PERPLEXITY_AGENT_PROVIDER)
    const result = await model.doGenerate({ prompt: SIMPLE_PROMPT })
    expect(result.response.modelId).toBe(recorded.model)
  })

  it("streams the completed answer as one text block plus its sources", async () => {
    const { impl } = servingRecorded(recorded)
    const model = perplexityAgentModel({ modelId: MODEL_ID, apiKey: "k", fetchImpl: impl })

    const { stream } = await model.doStream({ prompt: SIMPLE_PROMPT })
    const reader = (stream as ReadableStream<{ type: string }>).getReader()
    const parts: Array<{ type: string }> = []
    for (;;) {
      const { done, value } = await reader.read()
      if (done) break
      parts.push(value)
    }

    expect(parts[0].type).toBe("stream-start")
    expect(parts.at(-1)?.type).toBe("finish")
    expect(parts.filter((part) => part.type === "source").length).toBeGreaterThan(0)
    expect(parts.filter((part) => part.type === "text-delta")).toHaveLength(1)
  })

  it("puts the reported cost on doGenerate and on the stream's finish part", async () => {
    const { impl } = servingRecorded(recorded)
    const model = perplexityAgentModel({ modelId: MODEL_ID, apiKey: "k", fetchImpl: impl })
    const expected = mapAgentProviderMetadata(recorded)

    const generated = await model.doGenerate({ prompt: SIMPLE_PROMPT })
    expect(generated.providerMetadata).toEqual(expected)

    const { stream } = await model.doStream({ prompt: SIMPLE_PROMPT })
    const reader = stream.getReader()
    const parts: Record<string, unknown>[] = []
    for (;;) {
      const { done, value } = await reader.read()
      if (done) break
      parts.push(value)
    }
    expect(parts.at(-1)).toMatchObject({ type: "finish", providerMetadata: expected })
  })

  it("drives a real Mastra Agent, which is the only compatibility check that counts", async () => {
    const { impl } = servingRecorded(recorded)
    const agent = new Agent({
      id: "perplexity-agent-api-probe",
      name: "perplexity-agent-api-probe",
      instructions: "You are an expert SEO content researcher.",
      model: perplexityAgentModel({ modelId: MODEL_ID, apiKey: "k", fetchImpl: impl }),
    })

    const result = await agent.generate("Research time tracking tools.")

    expect(result.text).toContain("Reykjav")
    expect(result.usage?.inputTokens).toBe((recorded.usage as { input_tokens: number }).input_tokens)
    expect(result.sources?.length).toBeGreaterThan(0)
    // The channel the `research` step reads the bill off: the metadata has to
    // survive Mastra's own wrapping, not just leave this adapter.
    expect(agentReportedCostUsd(result.providerMetadata)).toBe(
      (recorded.usage as { cost: { total_cost: number } }).cost.total_cost,
    )
  })
})

describe.skipIf(!LIVE_KEY)("live Agent API call", () => {
  it("answers a grounded research question with sources", async () => {
    const agent = new Agent({
      id: "perplexity-agent-api-live",
      name: "perplexity-agent-api-live",
      instructions:
        "You are an expert SEO content researcher. Respond ONLY with the research document in markdown format.",
      model: perplexityAgentModel({ modelId: MODEL_ID, apiKey: LIVE_KEY as string }),
    })

    const result = await agent.generate(
      "Research the topic: best time tracking tools for agencies. " +
        "Cover keyword opportunities, audience pain points, competitor content and search intent.",
    )

    expect(result.text.length).toBeGreaterThan(1000)
    expect(result.sources?.length).toBeGreaterThan(0)
    expect(result.usage?.outputTokens ?? 0).toBeGreaterThan(0)

    // The bill is real and the per-token table cannot reach it: a grounded
    // call always spends at least one `web_search` invocation, which
    // `MODEL_COSTS` prices at nothing. Measured once at $0.016587 estimated
    // against $0.01909 billed, the whole $0.0025 gap being one search.
    const reported = agentReportedCostUsd(result.providerMetadata) ?? 0
    expect(reported).toBeGreaterThan(
      stageCostUsd(result.usage?.inputTokens ?? 0, result.usage?.outputTokens ?? 0, MODEL_ID),
    )
  }, 300_000)
})
