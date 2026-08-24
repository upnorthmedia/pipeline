// @vitest-environment node
/**
 * Items 5.1b-i and 5.1b-ii: the three API-key endpoints of the ported settings
 * router, called directly with a `Request` against the real database and a
 * real BetterAuth session, so the 401 and the loopback gate are genuinely
 * exercised.
 *
 * The full masking and persistence semantics are covered in
 * `src/mastra/api-keys.test.ts`; what is left here is auth, the loopback gate,
 * the unknown-provider path, body validation and the wire shape.
 * `settings.api_keys` is a single global row with no `user_id` to isolate on,
 * so this file borrows it through `src/test/api-keys-row.ts` for its whole
 * lifetime and gives it back in `afterAll`.
 *
 * Ported from `api/tests/phase11/test_api_keys.py`.
 *
 * Requires `docker compose up -d db`.
 */
import { randomBytes } from "node:crypto"

import { eq } from "drizzle-orm"
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest"

import { closeDb, getDb, settings } from "@/db"
import { decryptWithKey, encryptWithKey } from "@/lib/crypto"
import { ANTHROPIC_MESSAGES_URL, PERPLEXITY_CHAT_URL } from "@/mastra/api-key-validator"
import {
  API_KEYS_SETTING_KEY,
  API_KEYS_VALIDATION_SETTING_KEY,
  PROVIDERS,
  type Provider,
} from "@/mastra/api-keys"
import { borrowApiKeysRow, returnApiKeysRow } from "@/test/api-keys-row"
import { apiRequest, createTestSession, deleteTestSessions, type TestSession } from "@/test/session"
import { swapFetch, type Swap } from "@/test/swapped-fetch"

import { GET as GET_STATUS, PUT } from "./route"
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

beforeAll(async () => {
  await borrowApiKeysRow({ encryptionKey: TEST_KEY })
  await deleteTestSessions(PREFIX)
  user = await createTestSession(PREFIX)

  await getDb().delete(settings).where(eq(settings.key, API_KEYS_VALIDATION_SETTING_KEY))

  const value = Object.fromEntries(
    Object.entries(STORED).map(([provider, key]) => [provider, encryptWithKey(key, TEST_KEY)]),
  )
  await getDb()
    .insert(settings)
    .values({ key: API_KEYS_SETTING_KEY, value })
    .onConflictDoUpdate({ target: [settings.key, settings.userId], set: { value } })
}, 30_000)

afterAll(async () => {
  await returnApiKeysRow()
  await deleteTestSessions(PREFIX)
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

/**
 * Item 5.1b-ii, ported from `test_put_api_keys_saves_and_validates`,
 * `test_put_api_keys_encrypted_at_rest`, `test_put_api_keys_partial_update`
 * and `test_put_api_keys_validation_failure` in
 * `api/tests/phase11/test_api_keys.py`.
 *
 * Python patched `validate_keys` out. This stubs the HTTP transport instead,
 * so the real validator runs and the assertion covers the handler's use of it
 * as well as the handler itself. Anything that is not a provider URL falls
 * through to the real `fetch`, so nothing else in the process is affected.
 */
describe("PUT /api/settings/api-keys", () => {
  let swap: Swap | undefined

  /** Replays one status per provider endpoint and records what was called. */
  function stubProviders(status: Partial<Record<Provider, number>>) {
    const calledFor: Provider[] = []
    swap = swapFetch((input, init, realFetch) => {
      const url = typeof input === "string" ? input : String(input)
      const provider: Provider | undefined = url.startsWith(ANTHROPIC_MESSAGES_URL)
        ? "anthropic"
        : url.startsWith(PERPLEXITY_CHAT_URL)
          ? "perplexity"
          : url.includes("generativelanguage.googleapis.com")
            ? "gemini"
            : undefined
      if (!provider) return realFetch(input, init)
      calledFor.push(provider)
      return new Response("{}", {
        status: status[provider] ?? 200,
        headers: { "content-type": "application/json" },
      })
    })
    return calledFor
  }

  const put = (body: unknown) =>
    apiRequest(STATUS_URL, { method: "PUT", cookie: user.cookie, body: JSON.stringify(body) })

  async function storedKeys(): Promise<Record<string, string>> {
    const rows = await getDb()
      .select({ value: settings.value })
      .from(settings)
      .where(eq(settings.key, API_KEYS_SETTING_KEY))
      .limit(1)
    return (rows[0]?.value ?? {}) as Record<string, string>
  }

  beforeEach(async () => {
    const value = Object.fromEntries(
      Object.entries(STORED).map(([provider, key]) => [provider, encryptWithKey(key, TEST_KEY)]),
    )
    await getDb()
      .insert(settings)
      .values({ key: API_KEYS_SETTING_KEY, value })
      .onConflictDoUpdate({ target: [settings.key, settings.userId], set: { value } })
    await getDb().delete(settings).where(eq(settings.key, API_KEYS_VALIDATION_SETTING_KEY))
  })

  it("401s without a session", async () => {
    const response = await PUT(
      apiRequest(STATUS_URL, { method: "PUT", body: JSON.stringify({ anthropic: "sk-ant-x" }) }),
    )

    expect(response.status).toBe(401)
    expect(await response.json()).toEqual({ detail: "Not authenticated" })
  })

  it("422s a body that is not an object of provider strings", async () => {
    for (const body of [[], "anthropic", { anthropic: 7 }]) {
      const response = await PUT(put(body))

      expect(response.status, JSON.stringify(body)).toBe(422)
      expect(await response.json()).toEqual({ detail: "Each provider key must be a string" })
    }
  })

  it("stores the key and reports the provider's verdict", async () => {
    const calledFor = stubProviders({ anthropic: 200 })

    const response = await PUT(put({ anthropic: "sk-ant-newkey1234" }))

    expect(response.status).toBe(200)
    expect(calledFor).toEqual(["anthropic"])
    expect((await response.json()).anthropic).toEqual({
      provider: "anthropic",
      configured: true,
      source: "db",
      hint: "...1234",
      valid: true,
    })
  })

  it("stores the key encrypted, never in plaintext", async () => {
    stubProviders({ anthropic: 200 })

    await PUT(put({ anthropic: "sk-ant-secret-value" }))

    const stored = await storedKeys()
    expect(stored.anthropic).not.toBe("sk-ant-secret-value")
    expect(decryptWithKey(stored.anthropic, TEST_KEY)).toBe("sk-ant-secret-value")
  })

  it("leaves the providers the body did not name alone", async () => {
    stubProviders({ perplexity: 200 })

    const body = await (await PUT(put({ perplexity: "pplx-newkey5678" }))).json()

    expect(body.perplexity.hint).toBe("...5678")
    expect(body.perplexity.valid).toBe(true)
    expect(body.anthropic).toEqual({
      provider: "anthropic",
      configured: true,
      source: "db",
      hint: `...${STORED.anthropic!.slice(-4)}`,
      valid: null,
    })
  })

  it("still stores a key the provider rejected, and says it is invalid", async () => {
    stubProviders({ anthropic: 401 })

    const body = await (await PUT(put({ anthropic: "sk-ant-badkey12345" }))).json()

    expect(body.anthropic.configured).toBe(true)
    expect(body.anthropic.valid).toBe(false)
    expect(decryptWithKey((await storedKeys()).anthropic, TEST_KEY)).toBe("sk-ant-badkey12345")
  })

  it("persists the verdict so a later GET reports it without re-validating", async () => {
    stubProviders({ anthropic: 200, perplexity: 401 })

    await PUT(put({ anthropic: "sk-ant-newkey1234", perplexity: "pplx-badkey5678" }))
    // Taking the transport away before the GET: a re-validation would have to
    // reach a real provider, so the assertion below cannot pass by accident.
    swap?.restore()

    const body = await (await GET_STATUS(apiRequest(STATUS_URL, { cookie: user.cookie }))).json()
    expect(body.anthropic.valid).toBe(true)
    expect(body.perplexity.valid).toBe(false)
    expect(body.gemini.valid).toBeNull()
  })

  it("neither validates nor clears a provider submitted as an empty string", async () => {
    const calledFor = stubProviders({})

    const body = await (await PUT(put({ anthropic: "" }))).json()

    expect(calledFor).toEqual([])
    expect(body.anthropic.hint).toBe(`...${STORED.anthropic!.slice(-4)}`)
    expect(body.anthropic.valid).toBeNull()
  })

  it("never returns a plaintext key", async () => {
    stubProviders({ anthropic: 200 })

    const serialised = await (await PUT(put({ anthropic: "sk-ant-supersecretkey" }))).text()

    expect(serialised).not.toContain("sk-ant-supersecretkey")
  })
})
