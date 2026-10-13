// @vitest-environment node
/**
 * Item 3.1b: provider credentials come out of the `settings` table decrypted,
 * against the real Alembic-owned database and the real Fernet implementation.
 *
 * The row this reads is the one the running Python stack writes through
 * `save_api_keys()`, so the test writes ciphertext produced by `crypto.ts`
 * (already proven byte-compatible with Python in `lib/crypto.test.ts`) into
 * the real table and reads it back through the production code path.
 *
 * Requires `docker compose up -d db redis`.
 */
import { randomBytes } from "node:crypto"

import { eq } from "drizzle-orm"
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest"

import { closeDb, getDb, settings } from "../db"
import { borrowApiKeysRow, returnApiKeysRow } from "../test/api-keys-row"
import { decryptWithKey, encryptWithKey } from "../lib/crypto"
import {
  API_KEYS_SETTING_KEY,
  API_KEYS_VALIDATION_SETTING_KEY,
  PROVIDERS,
  getApiKeys,
  getMaskedKeys,
  getValidationResults,
  requireApiKey,
  revealApiKey,
  saveApiKeys,
  saveValidationResults,
} from "./api-keys"

/** A throwaway Fernet key: 32 random bytes, url-safe base64, exactly as Python generates. */
const TEST_KEY = randomBytes(32).toString("base64url")

async function writeKeys(value: Record<string, string>) {
  await getDb()
    .insert(settings)
    .values({ key: API_KEYS_SETTING_KEY, value })
    .onConflictDoUpdate({ target: [settings.key, settings.userId], set: { value } })
}

async function writeValidation(value: Record<string, unknown>) {
  await getDb()
    .insert(settings)
    .values({ key: API_KEYS_VALIDATION_SETTING_KEY, value })
    .onConflictDoUpdate({ target: [settings.key, settings.userId], set: { value } })
}

beforeAll(async () => {
  await borrowApiKeysRow({ encryptionKey: TEST_KEY })
}, 30_000)

afterEach(async () => {
  await getDb().delete(settings).where(eq(settings.key, API_KEYS_SETTING_KEY))
  await getDb().delete(settings).where(eq(settings.key, API_KEYS_VALIDATION_SETTING_KEY))
})

afterAll(async () => {
  await returnApiKeysRow()
  await closeDb()
})

describe("getApiKeys", () => {
  it("decrypts every stored provider key", async () => {
    const plaintext = {
      anthropic: "sk-ant-test-value-anthropic",
      perplexity: "pplx-test-value-perplexity",
      gemini: "AIza-test-value-gemini",
    }
    await writeKeys({
      anthropic: encryptWithKey(plaintext.anthropic, TEST_KEY),
      perplexity: encryptWithKey(plaintext.perplexity, TEST_KEY),
      gemini: encryptWithKey(plaintext.gemini, TEST_KEY),
    })

    await expect(getApiKeys()).resolves.toEqual(plaintext)
  })

  it("returns an empty string per provider when no row exists at all", async () => {
    await expect(getApiKeys()).resolves.toEqual({
      anthropic: "",
      perplexity: "",
      gemini: "",
    })
  })

  it("returns an empty string for a provider absent from an existing row", async () => {
    await writeKeys({ perplexity: encryptWithKey("pplx-only", TEST_KEY) })

    const keys = await getApiKeys()
    expect(keys.perplexity).toBe("pplx-only")
    expect(keys.anthropic).toBe("")
    expect(keys.gemini).toBe("")
    // Every provider Python knows about is present as a key, never undefined.
    expect(Object.keys(keys).sort()).toEqual([...PROVIDERS].sort())
  })

  it("raises rather than reporting an unconfigured key when the row cannot be decrypted", async () => {
    const otherKey = randomBytes(32).toString("base64url")
    await writeKeys({ perplexity: encryptWithKey("pplx-value", otherKey) })

    // A rotated WP_ENCRYPTION_KEY must not masquerade as "no key configured".
    await expect(getApiKeys()).rejects.toThrow(/token/i)
  })
})

describe("requireApiKey", () => {
  it("returns the decrypted key for a configured provider", async () => {
    await writeKeys({ perplexity: encryptWithKey("pplx-configured", TEST_KEY) })

    await expect(requireApiKey("perplexity")).resolves.toBe("pplx-configured")
  })

  it("throws naming the provider when the key is missing", async () => {
    await expect(requireApiKey("perplexity")).rejects.toThrow(
      /perplexity API key not configured/,
    )
  })
})

/**
 * Item 5.1b-i: the masking and reveal half of `api/src/services/api_keys.py`.
 * Ported from `api/tests/phase11/test_api_keys_service.py`
 * (`test_get_masked_keys_configured`, `test_get_masked_keys_never_returns_actual_key`)
 * plus the reveal cases that suite never had.
 *
 * These live in this file rather than beside the route handlers because
 * `settings.api_keys` is a single global row with no `user_id` to isolate on,
 * and every extra test file that rewrites it widens the known cross-file race
 * logged in `todo.md`.
 */
describe("getValidationResults", () => {
  it("returns nothing when no validation row exists", async () => {
    await expect(getValidationResults()).resolves.toEqual({})
  })

  it("returns only known providers, coerced to booleans", async () => {
    await writeValidation({ anthropic: true, perplexity: 0, openai: true })

    await expect(getValidationResults()).resolves.toEqual({
      anthropic: true,
      perplexity: false,
    })
  })
})

describe("getMaskedKeys", () => {
  it("reports every provider unconfigured when no row exists", async () => {
    const masked = await getMaskedKeys()

    expect(Object.keys(masked).sort()).toEqual([...PROVIDERS].sort())
    for (const provider of PROVIDERS) {
      expect(masked[provider]).toEqual({
        provider,
        configured: false,
        source: "none",
        hint: "",
        valid: null,
      })
    }
  })

  it("masks a configured key down to its last four characters", async () => {
    await writeKeys({ anthropic: encryptWithKey("sk-ant-secret-abcd", TEST_KEY) })

    const masked = await getMaskedKeys()
    expect(masked.anthropic).toEqual({
      provider: "anthropic",
      configured: true,
      source: "db",
      hint: "...abcd",
      valid: null,
    })
    expect(masked.gemini.configured).toBe(false)
  })

  it("masks a key shorter than four characters without leaking it", async () => {
    await writeKeys({ gemini: encryptWithKey("ab", TEST_KEY) })

    expect((await getMaskedKeys()).gemini.hint).toBe("...***")
  })

  it("never returns the plaintext key anywhere in the payload", async () => {
    const plaintext = "pplx-do-not-leak-me-wxyz"
    await writeKeys({ perplexity: encryptWithKey(plaintext, TEST_KEY) })

    const serialised = JSON.stringify(await getMaskedKeys())
    expect(serialised).not.toContain(plaintext)
    expect(serialised).not.toContain("pplx-do-not-leak-me")
    expect(serialised).toContain("...wxyz")
  })

  it("carries the persisted validation result onto a configured provider", async () => {
    await writeKeys({ anthropic: encryptWithKey("sk-ant-1234", TEST_KEY) })
    await writeValidation({ anthropic: false, gemini: true })

    const masked = await getMaskedKeys()
    expect(masked.anthropic.valid).toBe(false)
    // A stored result for a provider with no key stays null: Python reported
    // `valid` only off the configured branch.
    expect(masked.gemini.valid).toBeNull()
  })
})

describe("revealApiKey", () => {
  it("returns the decrypted key for a configured provider", async () => {
    await writeKeys({ gemini: encryptWithKey("AIza-revealed", TEST_KEY) })

    await expect(revealApiKey("gemini")).resolves.toBe("AIza-revealed")
  })

  it("returns null for a provider with no key stored", async () => {
    await expect(revealApiKey("gemini")).resolves.toBeNull()
  })

  it("returns null for a provider name it does not know", async () => {
    await writeKeys({ anthropic: encryptWithKey("sk-ant-1234", TEST_KEY) })

    await expect(revealApiKey("openai")).resolves.toBeNull()
  })
})

/**
 * Item 5.1b-ii. Ported from `test_save_and_load_round_trip`,
 * `test_save_empty_key_not_stored` and `test_save_upserts_existing` in
 * `api/tests/phase11/test_api_keys_service.py`.
 */
describe("saveApiKeys", () => {
  /** The stored ciphertext for one provider, read straight out of the row. */
  async function storedValue(): Promise<Record<string, string>> {
    const rows = await getDb()
      .select({ value: settings.value })
      .from(settings)
      .where(eq(settings.key, API_KEYS_SETTING_KEY))
      .limit(1)
    return (rows[0]?.value ?? {}) as Record<string, string>
  }

  it("stores ciphertext, not the key, and reads back the plaintext", async () => {
    await saveApiKeys({ anthropic: "sk-ant-test123", perplexity: "pplx-test456" })

    const stored = await storedValue()
    expect(stored.anthropic).not.toBe("sk-ant-test123")
    expect(decryptWithKey(stored.anthropic, TEST_KEY)).toBe("sk-ant-test123")

    expect(await getApiKeys()).toEqual({
      anthropic: "sk-ant-test123",
      perplexity: "pplx-test456",
      gemini: "",
    })
  })

  it("does not store an empty key", async () => {
    await saveApiKeys({ anthropic: "sk-ant-test", gemini: "" })

    expect(Object.keys(await storedValue())).toEqual(["anthropic"])
  })

  it("upserts the row rather than inserting a second one", async () => {
    await saveApiKeys({ anthropic: "sk-ant-first" })
    await saveApiKeys({ anthropic: "sk-ant-second" })

    expect((await getApiKeys()).anthropic).toBe("sk-ant-second")
  })

  it("leaves providers absent from the call untouched", async () => {
    await saveApiKeys({ anthropic: "sk-ant-keep", perplexity: "pplx-keep" })
    await saveApiKeys({ perplexity: "pplx-new" })

    expect(await getApiKeys()).toEqual({
      anthropic: "sk-ant-keep",
      perplexity: "pplx-new",
      gemini: "",
    })
  })

  it("keeps both writes when two providers are saved concurrently", async () => {
    await Promise.all([
      saveApiKeys({ anthropic: "sk-ant-concurrent" }),
      saveApiKeys({ perplexity: "pplx-concurrent" }),
    ])

    expect(await getApiKeys()).toEqual({
      anthropic: "sk-ant-concurrent",
      perplexity: "pplx-concurrent",
      gemini: "",
    })
  })

  it("writes nothing at all when every supplied key is empty", async () => {
    await saveApiKeys({ anthropic: "", perplexity: "", gemini: "" })

    const rows = await getDb()
      .select({ key: settings.key })
      .from(settings)
      .where(eq(settings.key, API_KEYS_SETTING_KEY))
    expect(rows).toEqual([])
  })
})

/** Item 5.1b-ii, ported from `save_validation_results()` in `api_keys.py`. */
describe("saveValidationResults", () => {
  it("persists a verdict that a later read returns", async () => {
    await saveValidationResults({ anthropic: true, perplexity: false })

    expect(await getValidationResults()).toEqual({ anthropic: true, perplexity: false })
  })

  it("merges into existing results instead of replacing them", async () => {
    await saveValidationResults({ anthropic: true })
    await saveValidationResults({ perplexity: false })

    expect(await getValidationResults()).toEqual({ anthropic: true, perplexity: false })
  })

  it("overwrites a provider's earlier verdict", async () => {
    await saveValidationResults({ anthropic: true })
    await saveValidationResults({ anthropic: false })

    expect(await getValidationResults()).toEqual({ anthropic: false })
  })

  it("writes nothing when there is nothing to record", async () => {
    await saveValidationResults({})

    const rows = await getDb()
      .select({ key: settings.key })
      .from(settings)
      .where(eq(settings.key, API_KEYS_VALIDATION_SETTING_KEY))
    expect(rows).toEqual([])
  })
})
