// @vitest-environment node
/**
 * Item 5.1b-i: the two read endpoints of the ported settings router, called
 * directly with a `Request` against the real database and a real BetterAuth
 * session, so the 401 and the loopback gate are genuinely exercised.
 *
 * The full masking semantics are covered in `src/mastra/api-keys.test.ts`;
 * what is left here is auth, the loopback gate, the unknown-provider path and
 * the wire shape. `settings.api_keys` is a single global row with no `user_id`
 * to isolate on, so this file swaps it once in `beforeAll` and restores it in
 * `afterAll` rather than per test, keeping the window in which a sibling file
 * could observe it as narrow as the file allows. That cross-file race is a
 * known defect logged in `todo.md`.
 *
 * Ported from `test_get_api_keys_empty` and
 * `test_get_api_keys_never_returns_plaintext` in
 * `api/tests/phase11/test_api_keys.py`.
 *
 * Requires `docker compose up -d db`.
 */
import { randomBytes } from "node:crypto"

import { eq } from "drizzle-orm"
import { afterAll, beforeAll, describe, expect, it } from "vitest"

import { closeDb, getDb, settings } from "@/db"
import { encryptWithKey } from "@/lib/crypto"
import { API_KEYS_SETTING_KEY, PROVIDERS, type Provider } from "@/mastra/api-keys"
import { lockApiKeysRow, unlockApiKeysRow } from "@/test/api-keys-row"
import { apiRequest, createTestSession, deleteTestSessions, type TestSession } from "@/test/session"

import { GET as GET_STATUS } from "./route"
import { GET as GET_REVEAL } from "./[provider]/reveal/route"

const PREFIX = "api-keys-route-test-"
const STATUS_URL = "http://localhost:3000/api/settings/api-keys"
const revealUrl = (provider: string) =>
  `http://localhost:3000/api/settings/api-keys/${provider}/reveal`

/** Next.js hands a route handler its dynamic segments as a promise. */
const segment = (provider: string) => ({ params: Promise.resolve({ provider }) })

/** A throwaway Fernet key, so no real `WP_ENCRYPTION_KEY` is needed to run this. */
const TEST_KEY = randomBytes(32).toString("base64url")

/**
 * `gemini` is deliberately left out so both branches of the reveal handler and
 * both branches of the masking are exercised by the same fixture.
 */
const STORED: Partial<Record<Provider, string>> = {
  anthropic: "sk-ant-route-test-abcd",
  perplexity: "pplx-route-test-wxyz",
}

let user: TestSession
let savedRow: { value: unknown } | undefined
let savedEncryptionKey: string | undefined

beforeAll(async () => {
  await lockApiKeysRow()
  await deleteTestSessions(PREFIX)
  user = await createTestSession(PREFIX)

  savedEncryptionKey = process.env.WP_ENCRYPTION_KEY
  process.env.WP_ENCRYPTION_KEY = TEST_KEY

  const rows = await getDb()
    .select({ value: settings.value })
    .from(settings)
    .where(eq(settings.key, API_KEYS_SETTING_KEY))
    .limit(1)
  savedRow = rows[0]

  const value = Object.fromEntries(
    Object.entries(STORED).map(([provider, key]) => [provider, encryptWithKey(key, TEST_KEY)]),
  )
  await getDb()
    .insert(settings)
    .values({ key: API_KEYS_SETTING_KEY, value })
    .onConflictDoUpdate({ target: settings.key, set: { value } })
}, 30_000)

afterAll(async () => {
  if (savedRow) {
    const value = savedRow.value as Record<string, string>
    await getDb()
      .insert(settings)
      .values({ key: API_KEYS_SETTING_KEY, value })
      .onConflictDoUpdate({ target: settings.key, set: { value } })
  } else {
    await getDb().delete(settings).where(eq(settings.key, API_KEYS_SETTING_KEY))
  }
  if (savedEncryptionKey === undefined) delete process.env.WP_ENCRYPTION_KEY
  else process.env.WP_ENCRYPTION_KEY = savedEncryptionKey

  await deleteTestSessions(PREFIX)
  await unlockApiKeysRow()
  await closeDb()
})

describe("GET /api/settings/api-keys", () => {
  it("401s without a session", async () => {
    const response = await GET_STATUS(apiRequest(STATUS_URL))

    expect(response.status).toBe(401)
    expect(await response.json()).toEqual({ detail: "Not authenticated" })
  })

  it("returns one ApiKeyStatus per provider, keyed by provider", async () => {
    const response = await GET_STATUS(apiRequest(STATUS_URL, { cookie: user.cookie }))

    expect(response.status).toBe(200)
    const body = await response.json()
    expect(Object.keys(body).sort()).toEqual([...PROVIDERS].sort())
    expect(body.anthropic).toEqual({
      provider: "anthropic",
      configured: true,
      source: "db",
      hint: "...abcd",
      valid: null,
    })
    expect(body.gemini).toEqual({
      provider: "gemini",
      configured: false,
      source: "none",
      hint: "",
      valid: null,
    })
  })

  it("never returns a plaintext key", async () => {
    const response = await GET_STATUS(apiRequest(STATUS_URL, { cookie: user.cookie }))
    const serialised = await response.text()

    for (const [provider, key] of Object.entries(STORED)) {
      expect(serialised, provider).not.toContain(key)
      expect(serialised, provider).toContain(`...${key.slice(-4)}`)
    }
  })
})

describe("GET /api/settings/api-keys/{provider}/reveal", () => {
  it("401s without a session, before the loopback gate", async () => {
    const response = await GET_REVEAL(
      apiRequest(revealUrl("anthropic"), { headers: { "x-forwarded-for": "203.0.113.7" } }),
      segment("anthropic"),
    )

    expect(response.status).toBe(401)
    expect(await response.json()).toEqual({ detail: "Not authenticated" })
  })

  it("403s a request that carries a proxy forwarding header", async () => {
    for (const header of ["forwarded", "x-forwarded-for", "x-forwarded-host", "x-real-ip"]) {
      const response = await GET_REVEAL(
        apiRequest(revealUrl("anthropic"), {
          cookie: user.cookie,
          headers: { [header]: "203.0.113.7" },
        }),
        segment("anthropic"),
      )

      expect(response.status, header).toBe(403)
      expect(await response.json()).toEqual({ detail: "Forbidden" })
    }
  })

  it("403s a request whose Host is not loopback", async () => {
    const response = await GET_REVEAL(
      apiRequest("http://app.example.com/api/settings/api-keys/anthropic/reveal", {
        cookie: user.cookie,
        headers: { host: "app.example.com" },
      }),
      segment("anthropic"),
    )

    expect(response.status).toBe(403)
  })

  it("allows 127.0.0.1 and [::1] as well as localhost", async () => {
    for (const host of ["127.0.0.1:3000", "[::1]:3000", "LOCALHOST"]) {
      const response = await GET_REVEAL(
        apiRequest(revealUrl("anthropic"), { cookie: user.cookie, headers: { host } }),
        segment("anthropic"),
      )

      expect(response.status, host).not.toBe(403)
    }
  })

  it("404s a provider name it does not know", async () => {
    const response = await GET_REVEAL(
      apiRequest(revealUrl("openai"), { cookie: user.cookie, headers: { host: "localhost:3000" } }),
      segment("openai"),
    )

    expect(response.status).toBe(404)
    expect(await response.json()).toEqual({ detail: "Key not configured" })
  })

  it("returns the plaintext key for a loopback request, or 404 when unset", async () => {
    for (const provider of PROVIDERS) {
      const response = await GET_REVEAL(
        apiRequest(revealUrl(provider), {
          cookie: user.cookie,
          headers: { host: "localhost:3000" },
        }),
        segment(provider),
      )

      if (STORED[provider]) {
        expect(response.status, provider).toBe(200)
        expect(await response.json()).toEqual({ provider, key: STORED[provider] })
      } else {
        expect(response.status, provider).toBe(404)
        expect(await response.json()).toEqual({ detail: "Key not configured" })
      }
    }
  })
})
