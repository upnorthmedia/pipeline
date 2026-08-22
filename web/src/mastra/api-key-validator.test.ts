// @vitest-environment node
/**
 * Item 5.1b-ii: the ported per-provider validators.
 *
 * Ported from `api/tests/phase11/test_api_key_validator.py`, which patched the
 * three SDK clients. The equivalent boundary here is the HTTP transport, so
 * these tests swap `globalThis.fetch` and assert both halves of the port: the
 * request that reaches the provider (URL, method, auth header, body) and the
 * mapping from the provider's answer to a `ValidationResult`. The provider
 * responses replayed below are the real ones, recorded on 2026-08-22 by
 * calling each endpoint with a deliberately invalid key.
 *
 * The live smoke against a real credential is `validates a real key end to
 * end` at the bottom, which runs only when `GEMINI_API_KEY` is set. Anthropic
 * and Perplexity have no equivalent here because this environment holds no key
 * for either; that gap is recorded in the ledger.
 */
import { afterEach, describe, expect, it } from "vitest"

import {
  ANTHROPIC_API_VERSION,
  ANTHROPIC_MESSAGES_URL,
  ANTHROPIC_VALIDATION_MODEL,
  PERPLEXITY_CHAT_URL,
  PERPLEXITY_VALIDATION_MODEL,
  validateAnthropic,
  validateGemini,
  validateKeys,
  validatePerplexity,
} from "./api-key-validator"
import { GEMINI_API_BASE } from "./images/gemini"

interface SentRequest {
  url: string
  method: string
  headers: Headers
  body: Record<string, unknown> | null
}

/** The verbatim 401 body `api.anthropic.com` returns for a bad `x-api-key`. */
const ANTHROPIC_401 = JSON.stringify({
  type: "error",
  error: { type: "authentication_error", message: "API key is invalid." },
  request_id: null,
})

/** The verbatim 401 body `api.perplexity.ai` returns for a bad bearer token. */
const PERPLEXITY_401 = JSON.stringify({
  error: {
    message: "Invalid API key provided. Ensure your API key is correct and active.",
    type: "invalid_api_key",
    code: 401,
  },
})

/** The verbatim 400 body the Gemini models endpoint returns for a bad key. */
const GEMINI_400 = JSON.stringify({
  error: {
    code: 400,
    message: "API key not valid. Please pass a valid API key.",
    status: "INVALID_ARGUMENT",
    details: [
      {
        "@type": "type.googleapis.com/google.rpc.ErrorInfo",
        reason: "API_KEY_INVALID",
        domain: "googleapis.com",
      },
    ],
  },
})

let restoreFetch: (() => void) | undefined

afterEach(() => {
  restoreFetch?.()
  restoreFetch = undefined
})

/** Replaces `fetch` with one that records the request and replays `respond`. */
function stubFetch(respond: (sent: SentRequest) => Response | Promise<Response>) {
  const sent: SentRequest[] = []
  const realFetch = globalThis.fetch
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const request: SentRequest = {
      url: typeof input === "string" ? input : String(input),
      method: init?.method ?? "GET",
      headers: new Headers(init?.headers),
      body: init?.body ? JSON.parse(String(init.body)) : null,
    }
    sent.push(request)
    return respond(request)
  }) as typeof globalThis.fetch
  restoreFetch = () => void (globalThis.fetch = realFetch)
  return sent
}

/** Shorthand for a replayed provider answer. */
const reply = (status: number, body: string) =>
  new Response(body, { status, headers: { "content-type": "application/json" } })

describe("validateAnthropic", () => {
  it("sends the one-token probe the Python validator sent", async () => {
    const sent = stubFetch(() => reply(200, JSON.stringify({ id: "msg_ok" })))

    const result = await validateAnthropic("sk-ant-valid")

    expect(result).toEqual({ valid: true, error: null })
    expect(sent).toHaveLength(1)
    expect(sent[0].url).toBe(ANTHROPIC_MESSAGES_URL)
    expect(sent[0].method).toBe("POST")
    expect(sent[0].headers.get("x-api-key")).toBe("sk-ant-valid")
    expect(sent[0].headers.get("anthropic-version")).toBe(ANTHROPIC_API_VERSION)
    expect(sent[0].body).toEqual({
      model: ANTHROPIC_VALIDATION_MODEL,
      max_tokens: 1,
      messages: [{ role: "user", content: "hi" }],
    })
  })

  it("reports a 401 as the actionable 'Invalid API key'", async () => {
    stubFetch(() => reply(401, ANTHROPIC_401))

    expect(await validateAnthropic("sk-ant-invalid")).toEqual({
      valid: false,
      error: "Invalid API key",
    })
  })

  it("passes any other provider error through with its message", async () => {
    stubFetch(() =>
      reply(429, JSON.stringify({ error: { type: "rate_limit_error", message: "Slow down." } })),
    )

    expect(await validateAnthropic("sk-ant-throttled")).toEqual({
      valid: false,
      error: "Slow down.",
    })
  })

  it("falls back to the status when the error body carries no message", async () => {
    stubFetch(() => reply(502, "<html>bad gateway</html>"))

    expect(await validateAnthropic("sk-ant-any")).toEqual({
      valid: false,
      error: "Unexpected status 502",
    })
  })

  it("reports a transport failure rather than throwing", async () => {
    stubFetch(() => {
      throw new TypeError("fetch failed")
    })

    expect(await validateAnthropic("sk-ant-any")).toEqual({ valid: false, error: "fetch failed" })
  })

  it("rejects an empty key without calling the provider", async () => {
    const sent = stubFetch(() => reply(200, "{}"))

    expect(await validateAnthropic("")).toEqual({ valid: false, error: "No key provided" })
    expect(sent).toHaveLength(0)
  })
})

describe("validatePerplexity", () => {
  it("sends the one-token completion the Python validator sent", async () => {
    const sent = stubFetch(() => reply(200, JSON.stringify({ id: "cmpl_ok" })))

    const result = await validatePerplexity("pplx-valid")

    expect(result).toEqual({ valid: true, error: null })
    expect(sent[0].url).toBe(PERPLEXITY_CHAT_URL)
    expect(sent[0].method).toBe("POST")
    expect(sent[0].headers.get("authorization")).toBe("Bearer pplx-valid")
    expect(sent[0].body).toEqual({
      model: PERPLEXITY_VALIDATION_MODEL,
      max_tokens: 1,
      messages: [{ role: "user", content: "hi" }],
    })
  })

  it("reports a 401 as 'Invalid API key'", async () => {
    stubFetch(() => reply(401, PERPLEXITY_401))

    expect(await validatePerplexity("pplx-invalid")).toEqual({
      valid: false,
      error: "Invalid API key",
    })
  })

  it("reports any other status by number, as Python did", async () => {
    stubFetch(() => reply(500, JSON.stringify({ error: { message: "upstream" } })))

    expect(await validatePerplexity("pplx-any")).toEqual({
      valid: false,
      error: "Unexpected status 500",
    })
  })

  it("rejects an empty key without calling the provider", async () => {
    const sent = stubFetch(() => reply(200, "{}"))

    expect(await validatePerplexity("")).toEqual({ valid: false, error: "No key provided" })
    expect(sent).toHaveLength(0)
  })
})

describe("validateGemini", () => {
  it("lists models, the metadata-only probe that costs no tokens", async () => {
    const sent = stubFetch(() => reply(200, JSON.stringify({ models: [] })))

    const result = await validateGemini("AIzaValid")

    expect(result).toEqual({ valid: true, error: null })
    expect(sent[0].url).toBe(`${GEMINI_API_BASE}/models`)
    expect(sent[0].method).toBe("GET")
    expect(sent[0].headers.get("x-goog-api-key")).toBe("AIzaValid")
    expect(sent[0].body).toBeNull()
  })

  it("reads a bad key out of Google's 400, which is not a 401", async () => {
    stubFetch(() => reply(400, GEMINI_400))

    expect(await validateGemini("AIzaBadKey")).toEqual({
      valid: false,
      error: "Invalid API key",
    })
  })

  it("treats PERMISSION_DENIED as a bad key too", async () => {
    stubFetch(() =>
      reply(
        403,
        JSON.stringify({ error: { message: "denied", status: "PERMISSION_DENIED" } }),
      ),
    )

    expect(await validateGemini("AIzaNoAccess")).toEqual({
      valid: false,
      error: "Invalid API key",
    })
  })

  it("passes a quota failure through instead of blaming the key", async () => {
    stubFetch(() =>
      reply(429, JSON.stringify({ error: { message: "Quota exceeded", status: "RESOURCE_EXHAUSTED" } })),
    )

    expect(await validateGemini("AIzaOutOfQuota")).toEqual({
      valid: false,
      error: "Quota exceeded",
    })
  })

  it("rejects an empty key without calling the provider", async () => {
    const sent = stubFetch(() => reply(200, "{}"))

    expect(await validateGemini("")).toEqual({ valid: false, error: "No key provided" })
    expect(sent).toHaveLength(0)
  })
})

describe("validateKeys", () => {
  it("validates every supplied provider and reports each verdict", async () => {
    const sent = stubFetch((request) =>
      request.url.startsWith(ANTHROPIC_MESSAGES_URL)
        ? reply(200, JSON.stringify({ id: "msg_ok" }))
        : reply(401, PERPLEXITY_401),
    )

    const results = await validateKeys({ anthropic: "key1", perplexity: "key2" })

    expect(results).toEqual({
      anthropic: { valid: true, error: null },
      perplexity: { valid: false, error: "Invalid API key" },
    })
    expect(sent).toHaveLength(2)
  })

  it("skips empty and absent providers entirely", async () => {
    const sent = stubFetch(() => reply(200, "{}"))

    expect(await validateKeys({ anthropic: "", perplexity: "" })).toEqual({})
    expect(await validateKeys({})).toEqual({})
    expect(sent).toHaveLength(0)
  })
})

/**
 * The live smoke. It calls the real endpoint with the real credential, which
 * is the only thing that proves the URL, the header name and the success
 * branch are right rather than merely self-consistent with the stub above.
 *
 * Listing models is metadata-only, so this stays green on the zero-quota key
 * this environment holds, which a generation probe would not.
 */
describe.skipIf(!process.env.GEMINI_API_KEY)("live provider smoke", () => {
  it("validates a real Gemini key against the real endpoint", async () => {
    expect(await validateGemini(process.env.GEMINI_API_KEY!)).toEqual({
      valid: true,
      error: null,
    })
  }, 30_000)

  it("rejects a malformed key against the real endpoint", async () => {
    expect(await validateGemini("AIzaNotARealKey")).toEqual({
      valid: false,
      error: "Invalid API key",
    })
  }, 30_000)
})
