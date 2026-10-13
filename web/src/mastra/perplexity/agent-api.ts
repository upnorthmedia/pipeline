/**
 * A `LanguageModelV2` for Perplexity's Agent API, so the `research` stage can
 * leave the Sonar Chat Completions endpoint before it stops answering.
 *
 * Perplexity documents `POST https://api.perplexity.ai/chat/completions` as
 * end-of-support on 2026-09-27 and points every caller at the Agent API. The
 * two surfaces are disjoint, measured on the live key: `/chat/completions`
 * rejects `perplexity/sonar` as an unknown model, and `/v1/chat/completions`
 * answers 404 for every model. Nothing installed can reach the replacement:
 *
 * * `@ai-sdk/perplexity` 4.0.31, published two days before this was written,
 *   still builds its URL as `${baseURL}/chat/completions`.
 * * `@mastra/core`'s provider registry does carry a `perplexity-agent` entry
 *   pointing at `https://api.perplexity.ai/v1`, but its `npm` is
 *   `@ai-sdk/openai` and the router builds an `OpenAIChatLanguageModel` from
 *   it, so a call through `perplexity-agent/perplexity/sonar` posts to
 *   `/v1/chat/completions` and dies on 404.
 * * Pointing `@ai-sdk/openai`'s Responses model at the base URL does reach the
 *   endpoint, but its response schema parses `output[]` with a closed
 *   `z.discriminatedUnion("type", ...)` that has no `search_results` member.
 *   That item is present in exactly the responses this stage exists for: the
 *   grounded ones. It would reject the good answers and accept the ungrounded
 *   ones.
 *
 * So this is a direct client, deliberately small: one POST, one response
 * shape, no streaming protocol. Replace it with a first-party provider when
 * one ships.
 *
 * What the endpoint demands, learned by asking it:
 *
 * * It rejects any field it does not know with `400 invalid request body:
 *   json: unknown field "..."`, so this only ever sends mapped fields. A call
 *   option with no Agent API equivalent becomes a warning, never a key.
 * * Web search is not automatic. A request with no `tools` gets no
 *   `search_results` item and no grounding, whatever the prompt asks for, so
 *   `web_search` is offered on every call rather than being opt-in.
 * * `/v1/agent` and `/v1/responses` accept the same body and return the same
 *   document, byte for byte apart from the ids and timestamps. `/v1/agent` is
 *   the one Perplexity documents for raw HTTP callers, so that is the default.
 *
 * The `LanguageModelV2` types are transcribed rather than imported:
 * `@mastra/core` bundles `@ai-sdk/provider` v5 but exports none of its types,
 * and the repo has no direct dependency on the package. Only the subset this
 * adapter produces or consumes is spelled out here; the structural check that
 * matters happens where an `Agent` is constructed with the result.
 */
/** The documented raw-HTTP target for the Agent API. */
export const PERPLEXITY_AGENT_URL = "https://api.perplexity.ai/v1/agent"

/**
 * `@ai-sdk/perplexity` gives Sonar calls no explicit deadline and inherits the
 * runtime default. A grounded research call routinely runs past a minute (the
 * recorded fixture's larger sibling took 88s), so the deadline is set well
 * above that rather than left to whatever `fetch` decides.
 */
export const PERPLEXITY_AGENT_TIMEOUT_MS = 300_000

/** The provider name this model reports, for logs and run traces. */
export const PERPLEXITY_AGENT_PROVIDER = "perplexity-agent"

/** Raised for any Agent API response this client cannot use. */
export class PerplexityAgentError extends Error {
  readonly statusCode: number | null

  constructor(message: string, statusCode: number | null = null) {
    super(message)
    this.name = "PerplexityAgentError"
    this.statusCode = statusCode
  }
}

/** The subset of `LanguageModelV2Prompt` messages this adapter reads. */
type PromptMessage = {
  role: "system" | "user" | "assistant" | "tool"
  content: string | Array<{ type: string; text?: string }>
}

/** The subset of `LanguageModelV2CallOptions` this adapter reads. */
export interface AgentCallOptions {
  prompt: PromptMessage[]
  maxOutputTokens?: number
  temperature?: number
  topP?: number
  frequencyPenalty?: number
  presencePenalty?: number
  stopSequences?: string[]
  seed?: number
  topK?: number
  responseFormat?: { type: string }
  tools?: unknown[]
  toolChoice?: unknown
  abortSignal?: AbortSignal
  headers?: Record<string, string | undefined>
}

type CallWarning =
  | { type: "unsupported-setting"; setting: string; details?: string }
  | { type: "other"; message: string }

type TextContent = { type: "text"; text: string }
type SourceContent = {
  type: "source"
  sourceType: "url"
  id: string
  url: string
  title?: string
}
type ResponseContent = TextContent | SourceContent

/**
 * `JSONValue`, which is what the AI SDK constrains `providerMetadata` values
 * to. Transcribed for the same reason the rest of these types are: the package
 * that declares it is bundled by `@mastra/core` and exported by nothing.
 */
type JsonValue = string | number | boolean | null | JsonValue[] | { [key: string]: JsonValue }

/** `LanguageModelV2FinishReason`. */
type FinishReason = "stop" | "length" | "content-filter" | "tool-calls" | "error" | "other" | "unknown"

/** `max_output_tokens` is rejected below this, per the endpoint's own error. */
const MIN_OUTPUT_TOKENS = 16

/**
 * Options a caller sets once per model, as opposed to per call.
 *
 * `fetchImpl` exists so the response mapping can be exercised against recorded
 * bodies without a network round trip; the live path leaves it unset.
 */
export interface PerplexityAgentModelOptions {
  modelId: string
  apiKey: string
  url?: string
  timeoutMs?: number
  fetchImpl?: typeof globalThis.fetch
}

/**
 * Flattens one prompt message into the single string the Agent API's `input`
 * items carry. Non-text parts are dropped rather than failing: this stage
 * sends text only, and a future image part should degrade to the words around
 * it rather than to an exception.
 */
function messageText(message: PromptMessage): string {
  if (typeof message.content === "string") return message.content
  return message.content
    .filter((part) => part.type === "text" && typeof part.text === "string")
    .map((part) => part.text as string)
    .join("")
}

/**
 * The Agent API takes `system`, `user` and `assistant` roles on `input`. A
 * `tool` message has nowhere to go here (no function tools are ever sent), so
 * it is dropped with a warning rather than posted as an unknown role.
 */
export function buildAgentInput(prompt: PromptMessage[]): {
  input: Array<{ role: string; content: string }>
  warnings: CallWarning[]
} {
  const warnings: CallWarning[] = []
  const input: Array<{ role: string; content: string }> = []
  for (const message of prompt) {
    if (message.role === "tool") {
      warnings.push({
        type: "other",
        message: "The Perplexity Agent API takes no tool messages; one was dropped.",
      })
      continue
    }
    input.push({ role: message.role, content: messageText(message) })
  }
  return { input, warnings }
}

/**
 * The request body, plus a warning for every call option with no Agent API
 * equivalent. Nothing unmapped reaches the wire, because the endpoint answers
 * 400 for an unknown key rather than ignoring it.
 */
export function buildAgentRequest(
  modelId: string,
  options: AgentCallOptions,
): { body: Record<string, unknown>; warnings: CallWarning[] } {
  const { input, warnings } = buildAgentInput(options.prompt)
  const body: Record<string, unknown> = {
    model: modelId,
    input,
    tools: [{ type: "web_search" }],
  }

  if (options.maxOutputTokens !== undefined) {
    body.max_output_tokens = Math.max(MIN_OUTPUT_TOKENS, options.maxOutputTokens)
    if (options.maxOutputTokens < MIN_OUTPUT_TOKENS) {
      warnings.push({
        type: "unsupported-setting",
        setting: "maxOutputTokens",
        details: `The Agent API rejects a value below ${MIN_OUTPUT_TOKENS}; ${MIN_OUTPUT_TOKENS} was sent instead.`,
      })
    }
  }
  if (options.temperature !== undefined) body.temperature = options.temperature
  if (options.topP !== undefined) body.top_p = options.topP
  if (options.frequencyPenalty !== undefined) body.frequency_penalty = options.frequencyPenalty
  if (options.presencePenalty !== undefined) body.presence_penalty = options.presencePenalty

  for (const setting of ["stopSequences", "seed", "topK", "responseFormat", "toolChoice"] as const) {
    if (options[setting] !== undefined) {
      warnings.push({
        type: "unsupported-setting",
        setting,
        details: "The Perplexity Agent API has no equivalent, so it was not sent.",
      })
    }
  }
  if (options.tools !== undefined && options.tools.length > 0) {
    warnings.push({
      type: "other",
      message:
        "This model offers Perplexity's own web_search tool only; caller-defined tools were not sent.",
    })
  }

  return { body, warnings }
}

/** The response fields this adapter reads. Everything else is passed over. */
interface AgentResponse {
  id?: string
  model?: string
  status?: string
  created_at?: number
  error?: { message?: string } | null
  incomplete_details?: { reason?: string } | null
  output?: Array<{
    type: string
    content?: Array<{ type: string; text?: string }>
    results?: Array<{ id?: number | string; url?: string; title?: string }>
  }>
  usage?: {
    input_tokens?: number
    output_tokens?: number
    total_tokens?: number
    input_tokens_details?: { cached_tokens?: number }
    output_tokens_details?: { reasoning_tokens?: number }
    /**
     * What Perplexity billed for this call, in USD, broken into its terms.
     * This is the only provider here that reports its own price, and it is the
     * only one whose price a per-token table cannot reconstruct: `web_search`
     * is billed per invocation under `tool_calls_cost`, on top of the tokens.
     *
     * Typed as JSON rather than as the recorded keys because it travels
     * through `providerMetadata`, whose values the AI SDK constrains to
     * `JSONValue`. New terms Perplexity adds ride along instead of being
     * dropped by a closed shape.
     */
    cost?: Record<string, JsonValue>
  }
}

/**
 * Walks `output[]` in the order the provider wrote it. Sources come first in
 * every grounded response recorded so far, but the order is preserved rather
 * than sorted so a reader of the content array sees what the provider sent.
 *
 * A `search_results` entry with no `url` is dropped: `LanguageModelV2Source`
 * requires one, and a source no one can open is not a citation.
 */
export function mapAgentContent(response: AgentResponse): ResponseContent[] {
  const content: ResponseContent[] = []
  for (const item of response.output ?? []) {
    if (item.type === "search_results") {
      for (const result of item.results ?? []) {
        if (!result.url) continue
        content.push({
          type: "source",
          sourceType: "url",
          id: String(result.id ?? result.url),
          url: result.url,
          ...(result.title ? { title: result.title } : {}),
        })
      }
      continue
    }
    if (item.type === "message") {
      for (const part of item.content ?? []) {
        if (part.type === "output_text" && typeof part.text === "string" && part.text !== "") {
          content.push({ type: "text", text: part.text })
        }
      }
    }
  }
  return content
}

/**
 * `status` is the Agent API's own verdict and arrives inside a 200 body, so a
 * failed run has to be read off the document rather than off the HTTP status.
 */
export function mapFinishReason(response: AgentResponse): FinishReason {
  switch (response.status) {
    case "completed":
      return "stop"
    case "incomplete":
      return response.incomplete_details?.reason === "max_output_tokens" ? "length" : "other"
    case "failed":
      return "error"
    case "cancelled":
      return "other"
    default:
      return "unknown"
  }
}

/** `usage.*`, renamed to the field names `LanguageModelV2Usage` uses. */
export function mapAgentUsage(response: AgentResponse) {
  const usage = response.usage
  return {
    inputTokens: usage?.input_tokens,
    outputTokens: usage?.output_tokens,
    totalTokens: usage?.total_tokens,
    reasoningTokens: usage?.output_tokens_details?.reasoning_tokens,
    cachedInputTokens: usage?.input_tokens_details?.cached_tokens,
  }
}

/** The key `providerMetadata` is namespaced under, which is the provider name. */
type AgentProviderMetadata = Record<string, Record<string, JsonValue>>

/**
 * `usage.cost`, verbatim, under this provider's namespace.
 *
 * `LanguageModelV2Usage` has token fields and no money field, so the bill has
 * nowhere else to travel: `providerMetadata` is the channel the AI SDK reserves
 * for exactly this, a provider-specific fact the shared shape cannot hold. The
 * whole breakdown is carried rather than the total alone, because
 * `tool_calls_cost` is what explains the gap against the token estimate and a
 * reader of a run trace is entitled to see it.
 *
 * `undefined` for a response that priced nothing, so a caller falls back to the
 * token estimate rather than recording a confident $0.00.
 */
export function mapAgentProviderMetadata(
  response: AgentResponse,
): AgentProviderMetadata | undefined {
  const cost = response.usage?.cost
  if (!cost || typeof cost.total_cost !== "number") return undefined
  return { [PERPLEXITY_AGENT_PROVIDER]: { cost } }
}

/**
 * The reported total off a generate result's `providerMetadata`, or
 * `undefined` when this provider did not write one.
 *
 * Takes `unknown` because it is called on whatever Mastra hands back, which is
 * typed as the union of every provider's metadata. Another provider's numbers
 * are ignored rather than read: a `cost` key under a different namespace is a
 * different provider's units.
 */
export function agentReportedCostUsd(providerMetadata: unknown): number | undefined {
  const namespaced = (providerMetadata as AgentProviderMetadata | undefined)?.[
    PERPLEXITY_AGENT_PROVIDER
  ]
  const cost = namespaced?.cost as Record<string, unknown> | undefined
  const total = cost?.total_cost
  return typeof total === "number" ? total : undefined
}

/** The message a non-200 body carries, or the raw body when it is not JSON. */
export function agentErrorMessage(status: number, body: string): string {
  try {
    const parsed = JSON.parse(body) as { error?: { message?: string } }
    if (parsed.error?.message) return parsed.error.message
  } catch {
    // Fall through to the raw body: a gateway error page is still a clue.
  }
  return body === "" ? `Perplexity Agent API returned ${status}` : body.slice(0, 200)
}

/**
 * A `LanguageModelV2` over the Agent API.
 *
 * `doStream` replays a completed call as one text block rather than opening
 * the endpoint's SSE channel. The `research` stage reads only the finished
 * text, so a real stream would buy nothing and cost a second protocol to keep
 * correct; a caller that wants token-by-token output needs that work done
 * first.
 */
export function perplexityAgentModel(options: PerplexityAgentModelOptions) {
  const {
    modelId,
    apiKey,
    url = PERPLEXITY_AGENT_URL,
    timeoutMs = PERPLEXITY_AGENT_TIMEOUT_MS,
    fetchImpl,
  } = options

  async function callAgent(callOptions: AgentCallOptions) {
    const { body, warnings } = buildAgentRequest(modelId, callOptions)
    const doFetch = fetchImpl ?? globalThis.fetch
    const headers: Record<string, string> = {
      Authorization: `Bearer ${apiKey}`,
      "Content-Type": "application/json",
    }
    for (const [name, value] of Object.entries(callOptions.headers ?? {})) {
      if (value !== undefined) headers[name] = value
    }

    const timeout = AbortSignal.timeout(timeoutMs)
    const signal = callOptions.abortSignal
      ? AbortSignal.any([callOptions.abortSignal, timeout])
      : timeout

    const response = await doFetch(url, {
      method: "POST",
      headers,
      body: JSON.stringify(body),
      signal,
    })
    const text = await response.text()
    if (!response.ok) {
      throw new PerplexityAgentError(agentErrorMessage(response.status, text), response.status)
    }

    let parsed: AgentResponse
    try {
      parsed = JSON.parse(text) as AgentResponse
    } catch {
      throw new PerplexityAgentError(
        `Perplexity Agent API returned a body that is not JSON: ${text.slice(0, 200)}`,
        response.status,
      )
    }
    if (parsed.status === "failed") {
      throw new PerplexityAgentError(
        parsed.error?.message ?? "The Perplexity Agent API reported a failed run.",
        response.status,
      )
    }

    return { parsed, warnings, requestBody: body }
  }

  return {
    specificationVersion: "v2" as const,
    provider: PERPLEXITY_AGENT_PROVIDER,
    modelId,
    supportedUrls: {},

    async doGenerate(callOptions: AgentCallOptions) {
      const { parsed, warnings, requestBody } = await callAgent(callOptions)
      return {
        content: mapAgentContent(parsed),
        finishReason: mapFinishReason(parsed),
        usage: mapAgentUsage(parsed),
        providerMetadata: mapAgentProviderMetadata(parsed),
        warnings,
        request: { body: requestBody },
        response: {
          id: parsed.id,
          modelId: parsed.model,
          timestamp: parsed.created_at ? new Date(parsed.created_at * 1000) : undefined,
        },
      }
    },

    async doStream(callOptions: AgentCallOptions) {
      const { parsed, warnings, requestBody } = await callAgent(callOptions)
      const content = mapAgentContent(parsed)
      const stream = new ReadableStream({
        start(controller) {
          controller.enqueue({ type: "stream-start", warnings })
          controller.enqueue({
            type: "response-metadata",
            id: parsed.id,
            modelId: parsed.model,
            timestamp: parsed.created_at ? new Date(parsed.created_at * 1000) : undefined,
          })
          let block = 0
          for (const part of content) {
            if (part.type === "source") {
              controller.enqueue(part)
              continue
            }
            const id = String(block++)
            controller.enqueue({ type: "text-start", id })
            controller.enqueue({ type: "text-delta", id, delta: part.text })
            controller.enqueue({ type: "text-end", id })
          }
          controller.enqueue({
            type: "finish",
            finishReason: mapFinishReason(parsed),
            usage: mapAgentUsage(parsed),
            providerMetadata: mapAgentProviderMetadata(parsed),
          })
          controller.close()
        },
      })
      return { stream, request: { body: requestBody } }
    },
  }
}
