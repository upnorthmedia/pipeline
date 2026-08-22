// @vitest-environment node
/**
 * Item 3.5d: `generateImage` sends what Python's `GeminiClient.generate_image`
 * sends and accounts for tokens the way it accounts for them.
 *
 * The oracle is `data/gemini-parity.json`, produced by
 * `api/scripts/export_gemini_parity.py`, which runs the real Python client with
 * `httpx` intercepted below the SDK. That gives two things the golden fixtures
 * cannot, because every Gemini call they recorded is a 429: the exact request
 * `google-genai` builds, and the result of feeding a canned answer back through
 * the SDK into Python's token accounting.
 *
 * Three things the corpus pins that a reading of the Python would not:
 *
 *   1. `attempts: 1` on both the 429 and the 500 case. `_retry` wraps this call
 *      but `_is_retryable` tests for `httpx.HTTPStatusError` and
 *      `anthropic.APIStatusError`, and `google.genai` raises neither, so no
 *      Gemini status error is ever retried. The port reproduces that.
 *   2. A part carrying `inline_data` with no bytes ends the search rather than
 *      deferring to a later image part, because Python breaks on the truthy
 *      `Blob` and only then checks for `None`.
 *   3. `candidatesTokenCount: 0` and an absent `usage_metadata` take the same
 *      fallback path, and an `image_size` outside the table falls back to the
 *      1K figure rather than erroring.
 *
 * The live smoke test is gated on `GEMINI_API_KEY` so the default `pnpm test`
 * needs no credentials.
 */
import fs from "node:fs"
import path from "node:path"

import { afterEach, describe, expect, it, vi } from "vitest"

import {
  GEMINI_API_BASE,
  GEMINI_BASE_DELAY_MS,
  GEMINI_IMAGE_MODEL_ID,
  GEMINI_IMAGE_SIZE_TOKENS,
  GEMINI_MAX_RETRIES,
  GEMINI_TIMEOUT_MS,
  GeminiApiError,
  GeminiTransportError,
  generateImage,
} from "./gemini"

type WireCase = {
  label: string
  why: string
  args: { prompt: string; model?: string; aspect_ratio?: string; image_size?: string }
  request: {
    method: string
    url: string
    headers: Record<string, string>
    body: unknown
    body_raw: string
  }
}

type ResponseCase = {
  label: string
  why: string
  args: { prompt: string; model?: string; aspect_ratio?: string; image_size?: string }
  status: number
  body: unknown
  attempts: number
  result?: { image_bytes_base64: string; model: string; tokens_in: number; tokens_out: number }
  error?: { type: string; message: string }
}

const CORPUS = JSON.parse(
  fs.readFileSync(path.join(__dirname, "data", "gemini-parity.json"), "utf8"),
) as { wire: WireCase[]; responses: ResponseCase[] }

/** The corpus records Python's argument names; the port uses camelCase. */
function toOptions(args: WireCase["args"], apiKey = "test-key-not-a-real-credential") {
  return {
    prompt: args.prompt,
    apiKey,
    model: args.model,
    aspectRatio: args.aspect_ratio,
    imageSize: args.image_size,
  }
}

type Captured = { url: string; init: RequestInit }

/**
 * Replace `globalThis.fetch` with a recorder that answers with `answer`, or
 * with the next entry of `answer` when it is a list, so the retry cases can
 * fail and then succeed.
 */
function stubFetch(answers: (() => Promise<Response>)[]): Captured[] {
  const captured: Captured[] = []
  let i = 0
  vi.stubGlobal("fetch", (url: string, init: RequestInit) => {
    captured.push({ url: String(url), init })
    const answer = answers[Math.min(i, answers.length - 1)]
    i += 1
    return answer()
  })
  return captured
}

function jsonAnswer(status: number, body: unknown) {
  return async () =>
    new Response(JSON.stringify(body), {
      status,
      headers: { "content-type": "application/json" },
    })
}

afterEach(() => {
  vi.unstubAllGlobals()
  vi.useRealTimers()
})

describe("the request", () => {
  for (const wireCase of CORPUS.wire) {
    describe(`${wireCase.label}: ${wireCase.why}`, () => {
      it("posts to the URL google-genai built, with the model id in the path", async () => {
        const captured = stubFetch([jsonAnswer(200, { candidates: [] })])
        await generateImage(toOptions(wireCase.args)).catch(() => undefined)

        expect(captured).toHaveLength(1)
        expect(captured[0].url).toBe(wireCase.request.url)
        // httpx and fetch both uppercase the method on the wire, so the
        // recorded lowercase spelling is compared case-insensitively.
        expect(String(captured[0].init.method).toUpperCase()).toBe(
          wireCase.request.method.toUpperCase(),
        )
      })

      it("sends the same JSON body, in the same key order", async () => {
        const captured = stubFetch([jsonAnswer(200, { candidates: [] })])
        await generateImage(toOptions(wireCase.args)).catch(() => undefined)

        // Byte equality is unreachable: `json.dumps` writes ", " and ": " as
        // separators and escapes every non-ASCII character, `JSON.stringify`
        // does neither. Re-serialising Python's raw body through
        // `JSON.parse` normalises exactly those two differences and nothing
        // else, so key order and every value still have to match.
        expect(String(captured[0].init.body)).toBe(
          JSON.stringify(JSON.parse(wireCase.request.body_raw)),
        )
      })

      it("carries the credential in x-goog-api-key and sets no other header", async () => {
        const captured = stubFetch([jsonAnswer(200, { candidates: [] })])
        await generateImage(toOptions(wireCase.args, "sentinel-key")).catch(() => undefined)

        const headers = captured[0].init.headers as Record<string, string>
        expect(headers).toEqual({
          "content-type": "application/json",
          "x-goog-api-key": "sentinel-key",
        })
        // The corpus redacts the value but keeps the names, which is the part
        // that has to match.
        expect(Object.keys(headers).sort()).toEqual(
          ["content-type", "x-goog-api-key"].filter((name) => name in wireCase.request.headers),
        )
      })
    })
  }

  it("aborts on the same 180s deadline Python's asyncio.wait_for sets", async () => {
    const captured = stubFetch([jsonAnswer(200, { candidates: [] })])
    await generateImage(toOptions({ prompt: "p" })).catch(() => undefined)

    const signal = captured[0].init.signal as AbortSignal
    expect(signal).toBeInstanceOf(AbortSignal)
    expect(GEMINI_TIMEOUT_MS).toBe(180_000)
  })

  it("refuses to call without a key, the way the Python constructor does", async () => {
    const captured = stubFetch([jsonAnswer(200, { candidates: [] })])
    await expect(generateImage({ prompt: "p", apiKey: "" })).rejects.toThrow(
      "Gemini API key not configured",
    )
    expect(captured).toHaveLength(0)
  })

  it("defaults to the model id the incumbent stage used", () => {
    expect(GEMINI_IMAGE_MODEL_ID).toBe("gemini-3.1-flash-image-preview")
    expect(CORPUS.wire[0].request.url).toBe(
      `${GEMINI_API_BASE}/models/${GEMINI_IMAGE_MODEL_ID}:generateContent`,
    )
  })
})

describe("the answer", () => {
  for (const responseCase of CORPUS.responses) {
    it(`${responseCase.label}: ${responseCase.why}`, async () => {
      const captured = stubFetch([jsonAnswer(responseCase.status, responseCase.body)])
      const options = toOptions(responseCase.args)

      if (responseCase.result) {
        const result = await generateImage(options)
        expect(result.imageBytes.toString("base64")).toBe(responseCase.result.image_bytes_base64)
        expect(result.model).toBe(responseCase.result.model)
        expect(result.tokensIn).toBe(responseCase.result.tokens_in)
        expect(result.tokensOut).toBe(responseCase.result.tokens_out)
      } else if (responseCase.error?.type === "RuntimeError") {
        // Python raises these itself, so the message is portable verbatim.
        await expect(generateImage(options)).rejects.toThrow(responseCase.error.message)
      } else {
        // `ClientError` and `ServerError` both become `GeminiApiError`. The
        // code and the status prefix are portable; the trailing payload is
        // Python's `repr(dict)` there and JSON here.
        const error = await generateImage(options).catch((e: unknown) => e)
        expect(error).toBeInstanceOf(GeminiApiError)
        const apiError = error as GeminiApiError
        expect(apiError.code).toBe(responseCase.status)
        expect(responseCase.error?.message.startsWith(`${apiError.code} ${apiError.status}. `)).toBe(
          true,
        )
      }

      // The number of HTTP requests Python made for this case, which is 1
      // even for 429 and 500.
      expect(captured).toHaveLength(responseCase.attempts)
    })
  }

  it("falls back to the 1K figure for an image_size outside the table", () => {
    expect(GEMINI_IMAGE_SIZE_TOKENS).toEqual({ "512": 750, "1K": 1100, "2K": 1700, "4K": 2500 })
    const unknownSize = CORPUS.responses.find((c) => c.label === "unknown-image-size")
    expect(unknownSize?.result?.tokens_out).toBe(GEMINI_IMAGE_SIZE_TOKENS["1K"])
  })
})

describe("retrying", () => {
  it("retries a transport failure up to MAX_RETRIES with Python's backoff", async () => {
    vi.useFakeTimers()
    const captured = stubFetch([
      async () => {
        throw new TypeError("fetch failed")
      },
    ])

    const pending = generateImage(toOptions({ prompt: "p" })).catch((e: unknown) => e)
    // Python's `base_delay * 2 ** attempt` at `BASE_DELAY = 1.0`: 1s then 2s.
    // The delays are spelled out rather than computed from the port's own
    // constants, which would make the assertion self-referential.
    await vi.advanceTimersByTimeAsync(999)
    expect(captured).toHaveLength(1)
    await vi.advanceTimersByTimeAsync(1)
    expect(captured).toHaveLength(2)
    await vi.advanceTimersByTimeAsync(1999)
    expect(captured).toHaveLength(2)
    await vi.advanceTimersByTimeAsync(1)
    const error = await pending

    // `MAX_RETRIES` is 3 attempts total, not 3 retries after the first.
    expect(captured).toHaveLength(3)
    expect(GEMINI_MAX_RETRIES).toBe(3)
    expect(GEMINI_BASE_DELAY_MS).toBe(1_000)
    expect(error).toBeInstanceOf(GeminiTransportError)
    expect((error as GeminiTransportError).timedOut).toBe(false)
  })

  it("stops retrying as soon as an attempt succeeds", async () => {
    vi.useFakeTimers()
    const image = Buffer.from("not really a png").toString("base64")
    let attempt = 0
    vi.stubGlobal("fetch", async () => {
      attempt += 1
      if (attempt === 1) throw new TypeError("fetch failed")
      return new Response(
        JSON.stringify({
          candidates: [{ content: { parts: [{ inlineData: { data: image } }] } }],
        }),
        { status: 200, headers: { "content-type": "application/json" } },
      )
    })

    const pending = generateImage(toOptions({ prompt: "p" }))
    await vi.advanceTimersByTimeAsync(1_000)
    const result = await pending

    expect(attempt).toBe(2)
    expect(result.imageBytes.toString("base64")).toBe(image)
  })

  it("marks a timeout as such and retries it, unlike a status error", async () => {
    vi.useFakeTimers()
    const captured = stubFetch([
      (init?: unknown) => {
        void init
        const timeout = new Error("The operation was aborted due to timeout")
        timeout.name = "TimeoutError"
        return Promise.reject(timeout)
      },
    ])

    const pending = generateImage(toOptions({ prompt: "p" })).catch((e: unknown) => e)
    await vi.advanceTimersByTimeAsync(1_000)
    await vi.advanceTimersByTimeAsync(2_000)
    const error = await pending

    expect(captured).toHaveLength(3)
    expect(error).toBeInstanceOf(GeminiTransportError)
    expect((error as GeminiTransportError).timedOut).toBe(true)
  })
})

describe("live smoke", () => {
  const key = process.env.GEMINI_API_KEY

  it.skipIf(!key)("the configured model id resolves against the live API", async () => {
    const response = await fetch(`${GEMINI_API_BASE}/models/${GEMINI_IMAGE_MODEL_ID}`, {
      headers: { "x-goog-api-key": key as string },
    })
    expect(response.status).toBe(200)

    const model = (await response.json()) as {
      name: string
      supportedGenerationMethods: string[]
    }
    expect(model.name).toBe(`models/${GEMINI_IMAGE_MODEL_ID}`)
    // The method `generateImage` posts to; a model that cannot serve it would
    // 404 the call this client makes.
    expect(model.supportedGenerationMethods).toContain("generateContent")
  }, 30_000)

  /**
   * The end-to-end call, gated a second time because the developer key's
   * project has no image quota at all: the live 429 reports
   * `generate_content_free_tier_requests, limit: 0` for this model, which is
   * also why every Gemini call in the golden fixtures is a 429. Set
   * `GEMINI_IMAGE_QUOTA=1` on a project with image quota to run it.
   */
  it.skipIf(!key || !process.env.GEMINI_IMAGE_QUOTA)(
    "reaches Gemini and returns bytes for the configured model id",
    async () => {
      const result = await generateImage({
        prompt: "A single flat teal circle centred on a white background.",
        apiKey: key as string,
        imageSize: "1K",
      })

      expect(result.model).toBe(GEMINI_IMAGE_MODEL_ID)
      expect(result.imageBytes.length).toBeGreaterThan(0)
      // The PNG magic number, which is what the stage hands to `optimizeImage`.
      expect(result.imageBytes.subarray(0, 4)).toEqual(Buffer.from([0x89, 0x50, 0x4e, 0x47]))
      expect(result.tokensOut).toBeGreaterThan(0)
    },
    200_000,
  )
})
