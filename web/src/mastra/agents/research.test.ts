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
import { STAGE_MODEL_ALLOWLIST, STAGE_MODEL_DEFAULTS } from "../stage-models"
import { mastra, pubsub } from "../index"
import { PERPLEXITY_AGENT_PROVIDER } from "../perplexity/agent-api"
import {
  RESEARCH_PROVIDER,
  RESEARCH_SYSTEM_MESSAGE,
  researchAgent,
} from "./research"

import { borrowApiKeysRow, returnApiKeysRow } from "@/test/api-keys-row"
import {
  borrowGlobalStageModelsRow,
  returnGlobalStageModelsRow,
} from "@/test/stage-models-row"

const GOLDEN_DIR = path.resolve(process.cwd(), "..", "docs", "mastra-port", "golden")
const GOLDEN_SLUGS = ["how-to-choose-a-crm-for-a-small-team", "best-time-tracking-tools-for-agencies"]

/** A throwaway Fernet key, so no real `WP_ENCRYPTION_KEY` is needed to run this. */
const TEST_KEY = "wDnmGSXAn3lPzz0GDW0jgcpn7XMDrnxLoO4XQb4Zwss"

const LIVE_KEY = process.env.PERPLEXITY_API_KEY

async function writePerplexityKey(plaintext: string) {
  const value = { [RESEARCH_PROVIDER]: encryptWithKey(plaintext, TEST_KEY) }
  await getDb()
    .insert(settings)
    .values({ key: API_KEYS_SETTING_KEY, value })
    .onConflictDoUpdate({ target: [settings.key, settings.userId], set: { value } })
}

async function clearKeys() {
  await getDb().delete(settings).where(eq(settings.key, API_KEYS_SETTING_KEY))
}

beforeAll(async () => {
  await borrowApiKeysRow({ encryptionKey: TEST_KEY })
  // The model this file asserts on is the default, and it resolves through the
  // global `stage_models` row, so the row is both borrowed (or another file
  // answers for this one) and cleared (or a model a human chose does). Taken
  // second, in the order `row-lock.ts` documents.
  await borrowGlobalStageModelsRow({ clear: true })
}, 30_000)

afterAll(async () => {
  await returnGlobalStageModelsRow()
  await returnApiKeysRow()
  await pubsub.close()
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

  it("draws its credential from the provider the golden fixtures name", async () => {
    // The model id deliberately no longer agrees with the recording. Python
    // captured `sonar-pro` on the Chat Completions endpoint, which Perplexity
    // retires on 2026-09-27 and whose replacement refuses that id outright
    // (P2.71b). Asserting the divergence rather than deleting the check keeps
    // the recording honest: a regenerated fixture that somehow answers
    // `perplexity/sonar` would fail here and be read rather than absorbed.
    for (const slug of GOLDEN_SLUGS) {
      const fixture = JSON.parse(
        fs.readFileSync(path.join(GOLDEN_DIR, slug, "research.json"), "utf8"),
      ) as { provider_calls: { provider: string; request: { model: string } }[] }
      expect(fixture.provider_calls[0].provider).toBe(RESEARCH_PROVIDER)
      expect(fixture.provider_calls[0].request.model).toBe("sonar-pro")
      expect(STAGE_MODEL_DEFAULTS.research.model).toBe("perplexity/sonar")
    }
  })
})

describe("research agent credential resolution", () => {
  it("resolves its model from the encrypted key in the settings table", async () => {
    await writePerplexityKey("pplx-not-a-real-key")

    const model = await researchAgent.getModel()
    expect(model.modelId).toBe("perplexity/sonar")
    // Not the model router's `perplexity` provider: that one posts to
    // `/chat/completions`. This name is the Agent API client's own.
    expect(model.provider).toBe(PERPLEXITY_AGENT_PROVIDER)
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

    expect(response?.modelId).toBe("perplexity/sonar")
    expect(result.text.trim().length).toBeGreaterThan(0)
    expect(result.usage?.outputTokens).toBeGreaterThan(0)
  }, 120_000)

  it("comes back grounded, which is the whole reason this stage exists", async () => {
    // Separate from the call above because "Reply with the single word OK."
    // legitimately searches nothing: `tool_choice` is `auto`, so grounding is
    // only observable on a question that needs it. Measured live, the same
    // request with no `tools` field returns a bare message and no sources at
    // all, so this is the assertion a migration that forgot `web_search`
    // fails on, and every length-based assertion would still pass.
    await writePerplexityKey(LIVE_KEY!)

    const result = await researchAgent.generate(
      "Research the topic: best patient scheduling software for small dental practices. " +
        "Cover keyword opportunities, audience pain points, competitor content and search intent.",
    )

    expect(result.sources?.length).toBeGreaterThan(0)
    // Mastra wraps each source part, so the URL is under `payload`.
    expect(
      result.sources?.every((source) =>
        (source.payload as { url?: unknown }).url?.toString().startsWith("http"),
      ),
    ).toBe(true)
    expect(result.text.length).toBeGreaterThan(1000)
  }, 300_000)
})

describe("research agent model configuration", () => {
  it("has one verified model, which is why nothing here asserts an override", () => {
    // Item 6.2b resolves this agent's model through the request context like
    // every Claude stage, but the Agent API accepts exactly one Perplexity
    // search model, so no stored override can change what reaches the wire and
    // a mutation that drops the context is undetectable from outside. This is
    // the tripwire: verify a second Perplexity id into the allowlist and this
    // fails, which is where the missing override test belongs.
    expect(STAGE_MODEL_ALLOWLIST.research).toEqual([STAGE_MODEL_DEFAULTS.research.model])
  })
})
