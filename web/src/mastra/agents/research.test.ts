// @vitest-environment node
/**
 * Item 3.1b: the `research` agent is registered on the Mastra instance and
 * reaches Perplexity with the same system message and model the Python stage
 * sends.
 *
 * The system message is compared against the golden fixtures rather than
 * against a copy of the string, so a drift between the two stacks fails here
 * instead of silently changing what the provider is told.
 *
 * The live smoke test writes the real key into the `settings` table, runs one
 * minimal call, and removes the row: that exercises the whole production path
 * (encrypted row -> `crypto.ts` -> model router -> Perplexity) rather than a
 * stubbed provider. It skips when `PERPLEXITY_API_KEY` is absent so the
 * default `pnpm test` needs no credentials.
 *
 * Requires `docker compose up -d db redis`.
 */
import fs from "node:fs"
import path from "node:path"

import { Agent } from "@mastra/core/agent"
import { eq } from "drizzle-orm"
import { afterAll, beforeAll, describe, expect, it } from "vitest"

import { closeDb, getDb, settings } from "../../db"
import { encryptWithKey } from "../../lib/crypto"
import { API_KEYS_SETTING_KEY } from "../api-keys"
import { mastra, pubsub } from "../index"
import {
  RESEARCH_MODEL_ID,
  RESEARCH_PROVIDER,
  RESEARCH_SYSTEM_MESSAGE,
  researchAgent,
} from "./research"

import { lockApiKeysRow, unlockApiKeysRow } from "@/test/api-keys-row"

const GOLDEN_DIR = path.resolve(process.cwd(), "..", "docs", "mastra-port", "golden")
const GOLDEN_SLUGS = ["how-to-choose-a-crm-for-a-small-team", "best-time-tracking-tools-for-agencies"]

/** A throwaway Fernet key, so no real `WP_ENCRYPTION_KEY` is needed to run this. */
const TEST_KEY = "wDnmGSXAn3lPzz0GDW0jgcpn7XMDrnxLoO4XQb4Zwss"

const LIVE_KEY = process.env.PERPLEXITY_API_KEY

let savedRow: { value: unknown } | undefined
let savedEncryptionKey: string | undefined

async function writePerplexityKey(plaintext: string) {
  const value = { [RESEARCH_PROVIDER]: encryptWithKey(plaintext, TEST_KEY) }
  await getDb()
    .insert(settings)
    .values({ key: API_KEYS_SETTING_KEY, value })
    .onConflictDoUpdate({ target: settings.key, set: { value } })
}

async function clearKeys() {
  await getDb().delete(settings).where(eq(settings.key, API_KEYS_SETTING_KEY))
}

beforeAll(async () => {
  await lockApiKeysRow()
  savedEncryptionKey = process.env.WP_ENCRYPTION_KEY
  process.env.WP_ENCRYPTION_KEY = TEST_KEY
  const rows = await getDb()
    .select({ value: settings.value })
    .from(settings)
    .where(eq(settings.key, API_KEYS_SETTING_KEY))
    .limit(1)
  savedRow = rows[0]
}, 30_000)

afterAll(async () => {
  await clearKeys()
  if (savedRow) {
    await getDb()
      .insert(settings)
      .values({ key: API_KEYS_SETTING_KEY, value: savedRow.value as object })
  }
  if (savedEncryptionKey === undefined) delete process.env.WP_ENCRYPTION_KEY
  else process.env.WP_ENCRYPTION_KEY = savedEncryptionKey
  await pubsub.close()
  await unlockApiKeysRow()
  await closeDb()
})

describe("research agent registration", () => {
  it("is registered on the Mastra instance under 'research'", () => {
    expect(researchAgent).toBeInstanceOf(Agent)
    expect(mastra.getAgent("research")).toBe(researchAgent)
    expect(Object.keys(mastra.listAgents())).toContain("research")
  })

  it("sends the system message the Python stage sent, per the golden fixtures", async () => {
    expect(await researchAgent.getInstructions()).toBe(RESEARCH_SYSTEM_MESSAGE)

    for (const slug of GOLDEN_SLUGS) {
      const fixture = JSON.parse(
        fs.readFileSync(path.join(GOLDEN_DIR, slug, "research.json"), "utf8"),
      ) as { provider_calls: { request: { messages: { role: string; content: string }[] } }[] }
      const system = fixture.provider_calls[0].request.messages.find((m) => m.role === "system")
      expect(system?.content).toBe(RESEARCH_SYSTEM_MESSAGE)
    }
  })

  it("carries the model the golden fixtures were captured with", async () => {
    for (const slug of GOLDEN_SLUGS) {
      const fixture = JSON.parse(
        fs.readFileSync(path.join(GOLDEN_DIR, slug, "research.json"), "utf8"),
      ) as { provider_calls: { provider: string; request: { model: string } }[] }
      expect(fixture.provider_calls[0].provider).toBe(RESEARCH_PROVIDER)
      expect(`${fixture.provider_calls[0].provider}/${fixture.provider_calls[0].request.model}`).toBe(
        RESEARCH_MODEL_ID,
      )
    }
  })
})

describe("research agent credential resolution", () => {
  it("resolves its model from the encrypted key in the settings table", async () => {
    await writePerplexityKey("pplx-not-a-real-key")

    const model = await researchAgent.getModel()
    expect(model.modelId).toBe("sonar-pro")
    expect(model.provider).toContain("perplexity")
  })

  it("fails at model resolution with an actionable message when no key is stored", async () => {
    await clearKeys()

    await expect(researchAgent.getModel()).rejects.toThrow(
      /perplexity API key not configured/,
    )
  })
})

describe.skipIf(!LIVE_KEY)("research agent live smoke test", () => {
  it("reaches Perplexity and reports back the configured model id", async () => {
    await writePerplexityKey(LIVE_KEY!)

    const result = await researchAgent.generate("Reply with the single word OK.")
    const response = await result.response

    expect(response?.modelId).toBe("sonar-pro")
    expect(result.text.trim().length).toBeGreaterThan(0)
    expect(result.usage?.outputTokens).toBeGreaterThan(0)
  }, 120_000)
})
