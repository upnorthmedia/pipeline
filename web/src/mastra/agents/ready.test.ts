// @vitest-environment node
/**
 * Item 3.6, provider half: the `ready` agent is registered on the Mastra
 * instance and reaches Anthropic with the request the Python stage sent.
 *
 * Same shape as the other three Claude stages' provider tests (see
 * `agents/outline.test.ts` for why the outbound request is captured through
 * `globalThis.fetch` rather than a `url` override). What is specific to this
 * stage is that its system message is assembled from five adjacent Python
 * string literals with no separator between them, so a transcription that
 * inserted the newlines those line breaks look like would read identically to a
 * human. The fixture equality catches that, and an explicit single-line
 * assertion says so out loud.
 *
 * The live smoke test writes the real key into the `settings` table, makes one
 * minimal call and removes the row, skipping when `ANTHROPIC_API_KEY` is absent
 * so the default `pnpm test` needs no credentials.
 *
 * Requires `docker compose up -d db redis`.
 */
import fs from "node:fs"
import path from "node:path"

import { Agent } from "@mastra/core/agent"
import { eq } from "drizzle-orm"
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest"

import { closeDb, getDb, settings } from "../../db"
import { encryptWithKey } from "../../lib/crypto"
import { API_KEYS_SETTING_KEY } from "../api-keys"
import { mastra, pubsub } from "../index"
import {
  CLAUDE_MIN_TEXT_TOKENS,
  CLAUDE_PROVIDER,
  CLAUDE_THINKING_BUDGET_TOKENS,
  claudeEffectiveMaxTokens,
} from "./claude"
import { READY_MAX_TOKENS, READY_MODEL_ID, READY_SYSTEM_MESSAGE, readyAgent } from "./ready"

const GOLDEN_DIR = path.resolve(process.cwd(), "..", "docs", "mastra-port", "golden")
const GOLDEN_SLUGS = ["how-to-choose-a-crm-for-a-small-team", "best-time-tracking-tools-for-agencies"]

type ReadyFixture = {
  post_spec: { output_format: string }
  rendered_prompts: string[]
  provider_calls: {
    provider: string
    request: {
      model: string
      max_tokens: number
      thinking: { type: string; budget_tokens: number }
      system: string
      messages: { role: string; content: string }[]
    }
  }[]
}

function loadFixture(slug: string): ReadyFixture {
  return JSON.parse(fs.readFileSync(path.join(GOLDEN_DIR, slug, "ready.json"), "utf8"))
}

/** A throwaway Fernet key, so no real `WP_ENCRYPTION_KEY` is needed to run this. */
const TEST_KEY = "wDnmGSXAn3lPzz0GDW0jgcpn7XMDrnxLoO4XQb4Zwss"

const LIVE_KEY = process.env.ANTHROPIC_API_KEY

let savedRow: { value: unknown } | undefined
let savedEncryptionKey: string | undefined

async function writeAnthropicKey(plaintext: string) {
  const value = { [CLAUDE_PROVIDER]: encryptWithKey(plaintext, TEST_KEY) }
  await getDb()
    .insert(settings)
    .values({ key: API_KEYS_SETTING_KEY, value })
    .onConflictDoUpdate({ target: settings.key, set: { value } })
}

async function clearKeys() {
  await getDb().delete(settings).where(eq(settings.key, API_KEYS_SETTING_KEY))
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
  await closeDb()
})

describe("ready agent registration", () => {
  it("is registered on the Mastra instance under 'ready'", () => {
    expect(readyAgent).toBeInstanceOf(Agent)
    expect(mastra.getAgent("ready")).toBe(readyAgent)
    expect(Object.keys(mastra.listAgents())).toContain("ready")
  })

  it("sends the system message the Python stage sent, per the golden fixtures", async () => {
    expect(await readyAgent.getInstructions()).toBe(READY_SYSTEM_MESSAGE)

    for (const slug of GOLDEN_SLUGS) {
      expect(loadFixture(slug).provider_calls[0].request.system).toBe(READY_SYSTEM_MESSAGE)
    }
  })

  it("is one unbroken line, because Python's literals concatenate without a separator", () => {
    // The five source lines are Python adjacent string literals, not a joined
    // list. Equality against the fixture above already covers this, but only as
    // long as the fixture is the oracle; this pins the property a hand
    // transcription is most likely to lose.
    expect(READY_SYSTEM_MESSAGE).not.toContain("\n")
    expect(READY_SYSTEM_MESSAGE).toContain("Compose the final publication-ready article")
    expect(READY_SYSTEM_MESSAGE).toContain("stripping publishing notes")
  })

  it("carries the model the golden fixtures were captured with", () => {
    for (const slug of GOLDEN_SLUGS) {
      const call = loadFixture(slug).provider_calls[0]
      expect(call.provider).toBe(CLAUDE_PROVIDER)
      expect(`${call.provider}/${call.request.model}`).toBe(READY_MODEL_ID)
    }
  })
})

/**
 * One captured outbound request, plus a canned Anthropic response shaped like
 * the one the fixtures recorded (a thinking block followed by a text block, so
 * the reasoning-stripping path runs rather than being skipped).
 */
function captureAnthropicRequests() {
  const captured: { url: string; body: Record<string, unknown> }[] = []
  const realFetch = globalThis.fetch
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    captured.push({
      url: typeof input === "string" ? input : String(input),
      body: JSON.parse(String(init?.body)),
    })
    return new Response(
      JSON.stringify({
        id: "msg_capture",
        type: "message",
        role: "assistant",
        model: "claude-opus-4-6",
        content: [
          { type: "thinking", thinking: "placing the featured image", signature: "sig" },
          { type: "text", text: "# The Published Article" },
        ],
        stop_reason: "end_turn",
        stop_sequence: null,
        usage: { input_tokens: 5222, output_tokens: 2967 },
      }),
      { status: 200, headers: { "content-type": "application/json" } },
    )
  }) as typeof globalThis.fetch
  return { captured, restore: () => void (globalThis.fetch = realFetch) }
}

describe("ready agent provider request", () => {
  let restoreFetch: (() => void) | undefined

  afterEach(() => {
    restoreFetch?.()
    restoreFetch = undefined
  })

  it("puts Python's model, max_tokens and thinking budget on the wire", async () => {
    await writeAnthropicKey("sk-ant-not-a-real-key")
    const fixture = loadFixture(GOLDEN_SLUGS[0])
    const recorded = fixture.provider_calls[0].request

    const capture = captureAnthropicRequests()
    restoreFetch = capture.restore
    const result = await readyAgent.generate(fixture.rendered_prompts[0])

    expect(capture.captured).toHaveLength(1)
    const sent = capture.captured[0]
    expect(sent.url).toBe("https://api.anthropic.com/v1/messages")
    expect(sent.body.model).toBe(recorded.model)
    expect(sent.body.max_tokens).toBe(recorded.max_tokens)
    expect(sent.body.thinking).toEqual(recorded.thinking)

    // Python sends `system` as a bare string and the AI SDK sends the same text
    // as a one-element block list, as recorded under item 3.2.
    expect(sent.body.system).toEqual([{ type: "text", text: recorded.system }])
    expect(sent.body.messages).toEqual([
      { role: "user", content: [{ type: "text", text: recorded.messages[0].content }] },
    ])

    // The thinking block is stripped from the text, as Python's block filter did.
    expect(result.text).toBe("# The Published Article")
  })

  it("passes 16000 through untouched because it clears the thinking floor", () => {
    expect(READY_MAX_TOKENS).toBe(16_000)
    expect(READY_MAX_TOKENS).toBeGreaterThan(CLAUDE_THINKING_BUDGET_TOKENS + CLAUDE_MIN_TEXT_TOKENS)
    expect(claudeEffectiveMaxTokens(READY_MAX_TOKENS)).toBe(READY_MAX_TOKENS)
    for (const slug of GOLDEN_SLUGS) {
      expect(claudeEffectiveMaxTokens(READY_MAX_TOKENS)).toBe(
        loadFixture(slug).provider_calls[0].request.max_tokens,
      )
    }
  })
})

describe("ready agent credential resolution", () => {
  it("resolves its model from the encrypted key in the settings table", async () => {
    await writeAnthropicKey("sk-ant-not-a-real-key")

    const model = await readyAgent.getModel()
    expect(model.modelId).toBe("claude-opus-4-6")
    expect(model.provider).toContain("anthropic")
  })

  it("fails at model resolution with an actionable message when no key is stored", async () => {
    await clearKeys()

    await expect(readyAgent.getModel()).rejects.toThrow(/anthropic API key not configured/)
  })
})

describe.skipIf(!LIVE_KEY)("ready agent live smoke test", () => {
  it("reaches Anthropic and reports back the configured model id", async () => {
    await writeAnthropicKey(LIVE_KEY!)

    const result = await readyAgent.generate("Reply with the single word OK.")
    const response = await result.response

    expect(response?.modelId).toBe("claude-opus-4-6")
    expect(result.text.trim().length).toBeGreaterThan(0)
    expect(result.usage?.outputTokens).toBeGreaterThan(0)
  }, 300_000)
})
