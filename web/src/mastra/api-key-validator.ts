/**
 * Live per-provider credential validation, ported from
 * `api/src/services/api_key_validator.py`.
 *
 * Each validator makes the smallest real call the provider offers, because the
 * only thing that actually proves a key works is the provider accepting it.
 * Python reached the three providers through three SDKs (`anthropic`,
 * `httpx`, `google-genai`); this port uses `fetch` against the same endpoints
 * so no dependency is added for what is three HTTP requests. The endpoints and
 * their unauthenticated responses were confirmed live on 2026-08-22:
 *
 *   POST https://api.anthropic.com/v1/messages          -> 401 authentication_error
 *   POST https://api.perplexity.ai/chat/completions      -> 401 invalid_api_key
 *   GET  https://generativelanguage.googleapis.com/v1beta/models
 *                                                        -> 400 API_KEY_INVALID
 *
 * **Intentional deviation: one timeout for all three.** Python bounded only
 * the Perplexity call, at 15s, and let the Anthropic SDK's 600s default and
 * the `google-genai` default stand. These validators run sequentially inside a
 * `PUT /api/settings/api-keys` that a human is waiting on, so a wedged
 * provider could park that request for ten minutes. All three share the 15s
 * bound here, which turns a hang into a reportable error string.
 */
import { GEMINI_API_BASE } from "./images/gemini"
import { PROVIDERS, type Provider } from "./api-keys"

/** Python's `httpx.AsyncClient(timeout=15.0)`, applied to every provider. */
export const VALIDATION_TIMEOUT_MS = 15_000

/**
 * The model the Anthropic probe names, carried over verbatim from
 * `validate_anthropic()`. It is not a stage model and not a choice made here;
 * verifying and possibly upgrading the six stage models is ledger item 6.1.
 */
export const ANTHROPIC_VALIDATION_MODEL = "claude-haiku-4-5-20251001"

/** The model the Perplexity probe names, from `validate_perplexity()`. */
export const PERPLEXITY_VALIDATION_MODEL = "sonar"

/** `anthropic-version` is required on every Messages API request. */
export const ANTHROPIC_API_VERSION = "2023-06-01"

export const ANTHROPIC_MESSAGES_URL = "https://api.anthropic.com/v1/messages"
export const PERPLEXITY_CHAT_URL = "https://api.perplexity.ai/chat/completions"

/** Python returned `tuple[bool, str | None]`; this is the same pair, named. */
export interface ValidationResult {
  valid: boolean
  error: string | null
}

/** Python's `"No key provided"` branch, shared by all three validators. */
const NO_KEY: ValidationResult = { valid: false, error: "No key provided" }

/** Python's `"Invalid API key"` branch, the one error the UI can act on. */
const INVALID_KEY: ValidationResult = { valid: false, error: "Invalid API key" }

/** Whatever the provider said, or the status, so the UI never shows an empty error. */
function unexpected(status: number, body: string): ValidationResult {
  const message = providerMessage(body)
  return { valid: false, error: message ?? `Unexpected status ${status}` }
}

/** The human-readable message out of an error body, in either shape the three use. */
function providerMessage(body: string): string | null {
  try {
    const parsed: unknown = JSON.parse(body)
    if (parsed === null || typeof parsed !== "object") return null
    const error = (parsed as { error?: unknown }).error
    if (error === null || typeof error !== "object") return null
    const message = (error as { message?: unknown }).message
    return typeof message === "string" && message ? message : null
  } catch {
    return null
  }
}

/**
 * Python caught every non-auth exception with `str(e)`. The equivalent here is
 * the `fetch` rejection message, which covers DNS failure, connection refusal
 * and the abort the 15s timeout raises.
 */
function transportError(error: unknown): ValidationResult {
  return { valid: false, error: error instanceof Error ? error.message : String(error) }
}

/** A one-token `messages.create`, the same probe `validate_anthropic()` made. */
export async function validateAnthropic(apiKey: string): Promise<ValidationResult> {
  if (!apiKey) return NO_KEY
  try {
    const response = await fetch(ANTHROPIC_MESSAGES_URL, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-api-key": apiKey,
        "anthropic-version": ANTHROPIC_API_VERSION,
      },
      body: JSON.stringify({
        model: ANTHROPIC_VALIDATION_MODEL,
        max_tokens: 1,
        messages: [{ role: "user", content: "hi" }],
      }),
      signal: AbortSignal.timeout(VALIDATION_TIMEOUT_MS),
    })
    if (response.ok) return { valid: true, error: null }
    if (response.status === 401) return INVALID_KEY
    return unexpected(response.status, await response.text())
  } catch (error) {
    return transportError(error)
  }
}

/** A one-token completion, the same probe `validate_perplexity()` made. */
export async function validatePerplexity(apiKey: string): Promise<ValidationResult> {
  if (!apiKey) return NO_KEY
  try {
    const response = await fetch(PERPLEXITY_CHAT_URL, {
      method: "POST",
      headers: { "content-type": "application/json", authorization: `Bearer ${apiKey}` },
      body: JSON.stringify({
        model: PERPLEXITY_VALIDATION_MODEL,
        max_tokens: 1,
        messages: [{ role: "user", content: "hi" }],
      }),
      signal: AbortSignal.timeout(VALIDATION_TIMEOUT_MS),
    })
    if (response.status === 401) return INVALID_KEY
    if (response.status === 200) return { valid: true, error: null }
    return { valid: false, error: `Unexpected status ${response.status}` }
  } catch (error) {
    return transportError(error)
  }
}

/**
 * A model list, the metadata-only probe `validate_gemini()` made through
 * `client.models.list()`. It costs no tokens and, unlike a generation call,
 * still succeeds on a key whose generation quota is exhausted.
 *
 * Google answers a bad key with 400 `API_KEY_INVALID` rather than a 401, which
 * is why Python matched on the message rather than the status. The same three
 * markers are matched here so both stacks report `"Invalid API key"` for the
 * same failures and pass everything else through verbatim.
 */
export async function validateGemini(apiKey: string): Promise<ValidationResult> {
  if (!apiKey) return NO_KEY
  try {
    const response = await fetch(`${GEMINI_API_BASE}/models`, {
      headers: { "x-goog-api-key": apiKey },
      signal: AbortSignal.timeout(VALIDATION_TIMEOUT_MS),
    })
    if (response.ok) return { valid: true, error: null }

    const body = await response.text()
    if (isGeminiKeyRejection(response.status, body)) return INVALID_KEY
    return unexpected(response.status, body)
  } catch (error) {
    return transportError(error)
  }
}

/** Python's `"401" in err or "API_KEY_INVALID" in err or "PERMISSION_DENIED" in err`. */
function isGeminiKeyRejection(status: number, body: string): boolean {
  return status === 401 || body.includes("API_KEY_INVALID") || body.includes("PERMISSION_DENIED")
}

/** Python's `VALIDATORS` map. */
export const VALIDATORS: Record<Provider, (apiKey: string) => Promise<ValidationResult>> = {
  anthropic: validateAnthropic,
  perplexity: validatePerplexity,
  gemini: validateGemini,
}

/**
 * Validate several keys at once, ported from `validate_keys()`. Providers with
 * an empty or absent key are skipped entirely rather than reported invalid, so
 * the caller can tell "not checked" from "checked and rejected".
 *
 * Python awaited the three calls in sequence. This keeps that ordering, since
 * the endpoints are unrelated and three sequential 15s bounds are the ceiling
 * the timeout deviation above was chosen against.
 */
export async function validateKeys(
  keys: Partial<Record<Provider, string>>,
): Promise<Partial<Record<Provider, ValidationResult>>> {
  const results: Partial<Record<Provider, ValidationResult>> = {}
  for (const provider of PROVIDERS) {
    const key = keys[provider]
    if (key) results[provider] = await VALIDATORS[provider](key)
  }
  return results
}
