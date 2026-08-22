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
import { encryptWithKey } from "../lib/crypto"
import { API_KEYS_SETTING_KEY, PROVIDERS, getApiKeys, requireApiKey } from "./api-keys"

/** A throwaway Fernet key: 32 random bytes, url-safe base64, exactly as Python generates. */
const TEST_KEY = randomBytes(32).toString("base64url")

/** Whatever the developer's database already held, restored on the way out. */
let savedRow: { value: unknown } | undefined
let savedEncryptionKey: string | undefined

async function writeKeys(value: Record<string, string>) {
  await getDb()
    .insert(settings)
    .values({ key: API_KEYS_SETTING_KEY, value })
    .onConflictDoUpdate({ target: settings.key, set: { value } })
}

beforeAll(async () => {
  savedEncryptionKey = process.env.WP_ENCRYPTION_KEY
  process.env.WP_ENCRYPTION_KEY = TEST_KEY
  const rows = await getDb()
    .select({ value: settings.value })
    .from(settings)
    .where(eq(settings.key, API_KEYS_SETTING_KEY))
    .limit(1)
  savedRow = rows[0]
}, 30_000)

afterEach(async () => {
  await getDb().delete(settings).where(eq(settings.key, API_KEYS_SETTING_KEY))
})

afterAll(async () => {
  if (savedRow) await writeKeys(savedRow.value as Record<string, string>)
  if (savedEncryptionKey === undefined) delete process.env.WP_ENCRYPTION_KEY
  else process.env.WP_ENCRYPTION_KEY = savedEncryptionKey
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
