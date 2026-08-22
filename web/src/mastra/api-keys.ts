/**
 * Provider credential lookup, ported from `get_api_keys()` in
 * `api/src/services/api_keys.py`.
 *
 * Keys live encrypted in the `settings` table under the `api_keys` row, not in
 * the environment, and every stage agent resolves its key from there at call
 * time. Doing the lookup inside the agent rather than threading the key
 * through the workflow's input keeps credentials out of `RequestContext`, out
 * of the Redis event payloads and out of the workflow snapshots Postgres
 * persists, which is the same reason `pipelineContextSchema` excludes them.
 *
 * The cost is one indexed single-row read per provider call; the alternative
 * is a secret in the run history of every pipeline that has ever run.
 */
import { eq } from "drizzle-orm"

import { getDb, settings } from "../db"
import { decrypt } from "../lib/crypto"

/** Providers the pipeline holds keys for, matching Python's `PROVIDERS`. */
export const PROVIDERS = ["anthropic", "perplexity", "gemini"] as const

export type Provider = (typeof PROVIDERS)[number]

/** The `settings.key` the encrypted key map is stored under. */
export const API_KEYS_SETTING_KEY = "api_keys"

/**
 * Decrypted keys for every provider. A provider with no stored key maps to
 * `""`, matching Python, so callers distinguish "not configured" from
 * "configured but empty" the same way in both stacks.
 *
 * A value that fails to decrypt is a real error, not an empty key: silently
 * returning `""` would surface as a confusing "key not configured" message
 * when the true cause is a rotated `WP_ENCRYPTION_KEY`.
 */
export async function getApiKeys(): Promise<Record<Provider, string>> {
  const rows = await getDb()
    .select({ value: settings.value })
    .from(settings)
    .where(eq(settings.key, API_KEYS_SETTING_KEY))
    .limit(1)

  const stored = (rows[0]?.value ?? {}) as Record<string, unknown>
  const out = {} as Record<Provider, string>
  for (const provider of PROVIDERS) {
    const ciphertext = stored[provider]
    out[provider] = typeof ciphertext === "string" && ciphertext ? decrypt(ciphertext) : ""
  }
  return out
}

/**
 * The key for one provider, or a thrown error naming the provider. Agents call
 * this so a missing key fails at model resolution with an actionable message
 * instead of as a provider 401 several layers down.
 */
export async function requireApiKey(provider: Provider): Promise<string> {
  const key = (await getApiKeys())[provider]
  if (!key) {
    throw new Error(
      `${provider} API key not configured. Add it on the settings page; ` +
        `keys are read from the '${API_KEYS_SETTING_KEY}' settings row.`,
    )
  }
  return key
}

/** The `settings.key` the persisted per-provider validation results live under. */
export const API_KEYS_VALIDATION_SETTING_KEY = "api_keys_validation"

/**
 * One provider's row in `GET /api/settings/api-keys`, matching `ApiKeyStatus`
 * in `api/src/models/schemas.py` and in `web/src/lib/api.ts`.
 */
export interface ApiKeyStatus {
  provider: Provider
  configured: boolean
  source: "db" | "env" | "none"
  hint: string
  valid: boolean | null
}

/**
 * Persisted validation results, ported from `_load_validation()`. Missing row,
 * missing provider and a non-boolean stored value all collapse the same way
 * Python's `bool(v)` did.
 */
export async function getValidationResults(): Promise<Partial<Record<Provider, boolean>>> {
  const rows = await getDb()
    .select({ value: settings.value })
    .from(settings)
    .where(eq(settings.key, API_KEYS_VALIDATION_SETTING_KEY))
    .limit(1)

  const stored = (rows[0]?.value ?? {}) as Record<string, unknown>
  const out: Partial<Record<Provider, boolean>> = {}
  for (const provider of PROVIDERS) {
    if (provider in stored) out[provider] = Boolean(stored[provider])
  }
  return out
}

/**
 * Masked status per provider, ported from `get_masked_keys()`. Never returns a
 * key: the only thing derived from the plaintext is the last four characters.
 *
 * `source` is only ever `"db"` or `"none"` here. `"env"` stays in the union
 * because `ApiKeyStatus` in `web/src/lib/api.ts` declares it, and Python's
 * schema typed it as a bare `str` with the same three values in a comment; no
 * code path in either stack produces it, since keys moved out of the
 * environment and into the `api_keys` row.
 */
export async function getMaskedKeys(): Promise<Record<Provider, ApiKeyStatus>> {
  const keys = await getApiKeys()
  const validation = await getValidationResults()

  const out = {} as Record<Provider, ApiKeyStatus>
  for (const provider of PROVIDERS) {
    const value = keys[provider]
    out[provider] = value
      ? {
          provider,
          configured: true,
          source: "db",
          hint: value.length >= 4 ? `...${value.slice(-4)}` : "...***",
          valid: validation[provider] ?? null,
        }
      : { provider, configured: false, source: "none", hint: "", valid: null }
  }
  return out
}

/**
 * The plaintext key for one provider, or `null` when the provider is unknown
 * or has no key stored. Ported from `reveal_api_key()`.
 */
export async function revealApiKey(provider: string): Promise<string | null> {
  if (!(PROVIDERS as readonly string[]).includes(provider)) return null
  return (await getApiKeys())[provider as Provider] || null
}
