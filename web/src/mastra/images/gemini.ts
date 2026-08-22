/**
 * Port of `GeminiClient.generate_image` from `api/src/services/llm.py`.
 *
 * The `images` stage is the only one that talks to a second provider, and this
 * is that half: prompt in, image bytes plus the token counts the stage sums
 * into `_stage_meta_gemini` out. Prompt assembly, the `.foreach()` fan-out and
 * the manifest are the step's job (item 3.5f).
 *
 * **Why this calls `generateContent` directly instead of `@google/genai`.**
 * Every Gemini call in the golden fixtures is a 429, so the fixtures pin the
 * prompt text and nothing else. The oracle is instead
 * `data/gemini-parity.json`, captured by running the real Python client with
 * `httpx` intercepted, and it records the exact request `google-genai` builds.
 * Matching a recorded request byte for byte is a check the JS SDK cannot be
 * made to perform on itself, and the surface in use here is one POST with a
 * five-field body, so a dependency whose request shape would then need its own
 * parity corpus buys nothing. `gemini.test.ts` replays that corpus.
 *
 * **What is deliberately not ported.** Python wraps this call in `_retry`,
 * whose `_is_retryable` tests for `httpx.HTTPStatusError` and
 * `anthropic.APIStatusError`. `google.genai` raises neither, so no Gemini
 * status error is ever retried and no `Retry-After` header is ever read: a 429
 * fails on the first attempt. The corpus records `attempts: 1` for both 429
 * and 500 and the tests assert it. Only the timeout and network branches
 * retry, and those are ported.
 */

/** `generate_image`'s `model` default, unchanged from Python. */
export const GEMINI_IMAGE_MODEL_ID = "gemini-3.1-flash-image-preview"

/** `generate_image`'s `aspect_ratio` default. */
export const GEMINI_DEFAULT_ASPECT_RATIO = "4:3"

/** `generate_image`'s `image_size` default. */
export const GEMINI_DEFAULT_IMAGE_SIZE = "1K"

/**
 * Python's `size_tokens`: the per-image output-token counts to bill when the
 * API reports none. An `image_size` outside this table falls back to the `1K`
 * entry rather than erroring, matching `dict.get(image_size, 1100)`.
 */
export const GEMINI_IMAGE_SIZE_TOKENS: Readonly<Record<string, number>> = {
  "512": 750,
  "1K": 1100,
  "2K": 1700,
  "4K": 2500,
}

/** The fallback used for an `image_size` the table does not know. */
export const GEMINI_FALLBACK_TOKENS_OUT = 1100

/** Python's `asyncio.wait_for(..., timeout=180.0)` around the SDK call. */
export const GEMINI_TIMEOUT_MS = 180_000

/** `MAX_RETRIES` from `api/src/services/llm.py`. */
export const GEMINI_MAX_RETRIES = 3

/** `BASE_DELAY` from `api/src/services/llm.py`, in milliseconds. */
export const GEMINI_BASE_DELAY_MS = 1_000

/** The endpoint `google-genai` posts to, as recorded in the parity corpus. */
export const GEMINI_API_BASE = "https://generativelanguage.googleapis.com/v1beta"

/** Python's `ImageGenResponse`. */
export interface ImageGenResponse {
  imageBytes: Buffer
  model: string
  tokensIn: number
  tokensOut: number
}

export interface GenerateImageOptions {
  prompt: string
  apiKey: string
  model?: string
  aspectRatio?: string
  imageSize?: string
}

/**
 * A non-2xx answer from Gemini, the TypeScript stand-in for
 * `google.genai.errors.APIError`.
 *
 * The message reproduces Python's `f'{code} {status}. {details}'` down to the
 * details, which Python renders with `repr(dict)` and this renders as JSON.
 * That string reaches the `image_manifest` JSONB column through the stage's
 * `str(e)`, so the divergence is real but confined to the failure text of a
 * failed image; reproducing Python's dict `repr` for arbitrary provider
 * payloads is not worth a second float-formatting port.
 */
export class GeminiApiError extends Error {
  readonly code: number
  readonly status: string | null
  readonly details: unknown

  constructor(code: number, details: unknown) {
    const record = isRecord(details) ? details : undefined
    const error = record && isRecord(record.error) ? record.error : undefined
    const status = (record?.status ?? error?.status ?? null) as string | null
    super(`${code} ${status}. ${JSON.stringify(details)}`)
    this.name = "GeminiApiError"
    this.code = code
    this.status = status
    this.details = details
  }
}

/**
 * A request that never produced a response: the 180s timeout expired, or the
 * connection failed. These are Python's `asyncio.TimeoutError` and
 * `ConnectionError` / `OSError` branches, the only two `_is_retryable` accepts
 * for this client.
 *
 * It exists as its own class so the retry decision is scoped to the transport
 * boundary. Everything raised after a response arrives, including the two
 * `RuntimeError`s below, is not retried, matching Python.
 */
export class GeminiTransportError extends Error {
  readonly timedOut: boolean

  constructor(cause: unknown) {
    const timedOut = cause instanceof Error && cause.name === "TimeoutError"
    super(
      timedOut ? `Gemini request timed out after ${GEMINI_TIMEOUT_MS}ms` : "Gemini request failed",
      { cause },
    )
    this.name = "GeminiTransportError"
    this.timedOut = timedOut
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
}

/** `_is_retryable`, restricted to what this client can actually raise. */
function isRetryable(error: unknown): boolean {
  return error instanceof GeminiTransportError
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

/** The request body `google-genai` builds for one `generate_image` call. */
function requestBody(prompt: string, aspectRatio: string, imageSize: string) {
  return {
    contents: [{ parts: [{ text: prompt }], role: "user" }],
    generationConfig: {
      responseModalities: ["IMAGE"],
      imageConfig: { aspectRatio, imageSize },
    },
  }
}

/** One HTTP attempt, timeout included. */
async function attempt(options: Required<GenerateImageOptions>): Promise<ImageGenResponse> {
  const { prompt, apiKey, model, aspectRatio, imageSize } = options

  let response: Response
  try {
    response = await fetch(`${GEMINI_API_BASE}/models/${model}:generateContent`, {
      method: "post",
      headers: { "content-type": "application/json", "x-goog-api-key": apiKey },
      body: JSON.stringify(requestBody(prompt, aspectRatio, imageSize)),
      signal: AbortSignal.timeout(GEMINI_TIMEOUT_MS),
    })
  } catch (cause) {
    throw new GeminiTransportError(cause)
  }

  // `raise_for_response` tests for exactly 200, not for the 2xx range.
  if (response.status !== 200) {
    throw new GeminiApiError(response.status, await response.json().catch(() => null))
  }
  const payload: unknown = await response.json()

  // `response.parts` in the Python SDK is `candidates[0].content.parts`, and
  // an absent candidate, an absent content and an empty list are all falsy
  // there, which is the one branch the safety filter produces.
  const candidate =
    isRecord(payload) && Array.isArray(payload.candidates) ? payload.candidates[0] : undefined
  const content = isRecord(candidate) && isRecord(candidate.content) ? candidate.content : undefined
  const parts = Array.isArray(content?.parts) ? content.parts : []
  if (parts.length === 0) {
    throw new Error("Empty response from Gemini (possible safety filter)")
  }

  // Python breaks on the first part that *has* `inline_data`, so a part
  // carrying inline data with no bytes ends the loop and fails rather than
  // deferring to a later image part.
  let data: string | undefined
  for (const part of parts) {
    if (isRecord(part) && isRecord(part.inlineData)) {
      data = typeof part.inlineData.data === "string" ? part.inlineData.data : undefined
      break
    }
  }
  if (data === undefined) {
    throw new Error("No image returned in Gemini response")
  }

  const usage = isRecord(payload) && isRecord(payload.usageMetadata) ? payload.usageMetadata : undefined
  const tokensIn = typeof usage?.promptTokenCount === "number" ? usage.promptTokenCount : 0
  const reportedOut = typeof usage?.candidatesTokenCount === "number" ? usage.candidatesTokenCount : 0
  const tokensOut =
    reportedOut === 0 ? (GEMINI_IMAGE_SIZE_TOKENS[imageSize] ?? GEMINI_FALLBACK_TOKENS_OUT) : reportedOut

  return { imageBytes: Buffer.from(data, "base64"), model, tokensIn, tokensOut }
}

/**
 * Generate one image and return its bytes with usage metadata.
 *
 * `model` is echoed back rather than read from the response because Python
 * does the same: the stage stores it as `_stage_meta_gemini.model`.
 */
export async function generateImage(options: GenerateImageOptions): Promise<ImageGenResponse> {
  if (!options.apiKey) {
    throw new Error("Gemini API key not configured")
  }

  const resolved: Required<GenerateImageOptions> = {
    prompt: options.prompt,
    apiKey: options.apiKey,
    model: options.model ?? GEMINI_IMAGE_MODEL_ID,
    aspectRatio: options.aspectRatio ?? GEMINI_DEFAULT_ASPECT_RATIO,
    imageSize: options.imageSize ?? GEMINI_DEFAULT_IMAGE_SIZE,
  }

  for (let i = 0; ; i++) {
    try {
      return await attempt(resolved)
    } catch (error) {
      if (i === GEMINI_MAX_RETRIES - 1 || !isRetryable(error)) throw error
      await sleep(GEMINI_BASE_DELAY_MS * 2 ** i)
    }
  }
}
