// @vitest-environment node
/**
 * Item 3.2, provider half: the `outline` agent is registered on the Mastra
 * instance and reaches Anthropic with the request the Python stage sent.
 *
 * The interesting assertion here is the wire payload. `outline` is the first
 * stage whose provider request carries more than a model and a system message:
 * Python enables extended thinking and computes `max_tokens` from the thinking
 * budget, and the AI SDK provider inside `@mastra/core` derives `max_tokens`
 * differently (see `claude.ts`). So rather than asserting on the agent's
 * configuration, this test captures the serialized HTTP request the provider
 * builds by swapping `globalThis.fetch`, and compares it against the request
 * body recorded in the golden fixtures.
 *
 * The `url` override on the model config is deliberately not used for that: it
 * routes the agent through Mastra's OpenAI-compatible client instead of the
 * native Anthropic one, which sends `budgetTokens` unconverted to
 * `/chat/completions` and would have proved nothing about the real path.
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
import { CLAUDE_PROVIDER, CLAUDE_THINKING_BUDGET_TOKENS, claudeEffectiveMaxTokens } from "./claude"
import {
  OUTLINE_MAX_TOKENS,
  OUTLINE_MODEL_ID,
  OUTLINE_SYSTEM_MESSAGE,
  outlineAgent,
} from "./outline"

const GOLDEN_DIR = path.resolve(process.cwd(), "..", "docs", "mastra-port", "golden")
const GOLDEN_SLUGS = ["how-to-choose-a-crm-for-a-small-team", "best-time-tracking-tools-for-agencies"]

type OutlineFixture = {
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

function loadFixture(slug: string): OutlineFixture {
  return JSON.parse(fs.readFileSync(path.join(GOLDEN_DIR, slug, "outline.json"), "utf8"))
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

describe("outline agent registration", () => {
  it("is registered on the Mastra instance under 'outline'", () => {
    expect(outlineAgent).toBeInstanceOf(Agent)
    expect(mastra.getAgent("outline")).toBe(outlineAgent)
    expect(Object.keys(mastra.listAgents())).toContain("outline")
  })

  it("sends the system message the Python stage sent, per the golden fixtures", async () => {
    expect(await outlineAgent.getInstructions()).toBe(OUTLINE_SYSTEM_MESSAGE)

    for (const slug of GOLDEN_SLUGS) {
      expect(loadFixture(slug).provider_calls[0].request.system).toBe(OUTLINE_SYSTEM_MESSAGE)
    }
  })

  it("carries the model the golden fixtures were captured with", () => {
    for (const slug of GOLDEN_SLUGS) {
      const call = loadFixture(slug).provider_calls[0]
      expect(call.provider).toBe(CLAUDE_PROVIDER)
      expect(`${call.provider}/${call.request.model}`).toBe(OUTLINE_MODEL_ID)
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
          { type: "thinking", thinking: "considering the structure", signature: "sig" },
          { type: "text", text: "# Blog Post Outline" },
        ],
        stop_reason: "end_turn",
        stop_sequence: null,
        usage: { input_tokens: 7092, output_tokens: 4214 },
      }),
      { status: 200, headers: { "content-type": "application/json" } },
    )
  }) as typeof globalThis.fetch
  return { captured, restore: () => void (globalThis.fetch = realFetch) }
}

describe("outline agent provider request", () => {
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
    const result = await outlineAgent.generate(fixture.rendered_prompts[0])

    expect(capture.captured).toHaveLength(1)
    const sent = capture.captured[0]
    expect(sent.url).toBe("https://api.anthropic.com/v1/messages")
    expect(sent.body.model).toBe(recorded.model)
    expect(sent.body.max_tokens).toBe(recorded.max_tokens)
    expect(sent.body.thinking).toEqual(recorded.thinking)

    // Python sends `system` as a bare string and the AI SDK sends the same text
    // as a one-element block list. Anthropic accepts both, so the text is what
    // is compared; the shape is a documented divergence, not a regression.
    expect(sent.body.system).toEqual([{ type: "text", text: recorded.system }])
    expect(sent.body.messages).toEqual([
      { role: "user", content: [{ type: "text", text: recorded.messages[0].content }] },
    ])

    // The thinking block is stripped from the text, as Python's block filter did.
    expect(result.text).toBe("# Blog Post Outline")
  })

  it("keeps max_tokens pinned to the fixture rather than to the argument", () => {
    // `OUTLINE_MAX_TOKENS` is Python's 8000 argument; the wire value is the
    // thinking floor above it. A negative control: if `claudeEffectiveMaxTokens`
    // ever returned the argument unchanged, this and the wire test both fail.
    expect(OUTLINE_MAX_TOKENS).toBe(8_000)
    expect(claudeEffectiveMaxTokens(OUTLINE_MAX_TOKENS)).toBe(
      loadFixture(GOLDEN_SLUGS[0]).provider_calls[0].request.max_tokens,
    )
    expect(CLAUDE_THINKING_BUDGET_TOKENS).toBe(
      loadFixture(GOLDEN_SLUGS[0]).provider_calls[0].request.thinking.budget_tokens,
    )
  })
})

describe("outline agent credential resolution", () => {
  it("resolves its model from the encrypted key in the settings table", async () => {
    await writeAnthropicKey("sk-ant-not-a-real-key")

    const model = await outlineAgent.getModel()
    expect(model.modelId).toBe("claude-opus-4-6")
    expect(model.provider).toContain("anthropic")
  })

  it("fails at model resolution with an actionable message when no key is stored", async () => {
    await clearKeys()

    await expect(outlineAgent.getModel()).rejects.toThrow(/anthropic API key not configured/)
  })
})

describe.skipIf(!LIVE_KEY)("outline agent live smoke test", () => {
  it("reaches Anthropic and reports back the configured model id", async () => {
    await writeAnthropicKey(LIVE_KEY!)

    const result = await outlineAgent.generate("Reply with the single word OK.")
    const response = await result.response

    expect(response?.modelId).toBe("claude-opus-4-6")
    expect(result.text.trim().length).toBeGreaterThan(0)
    expect(result.usage?.outputTokens).toBeGreaterThan(0)
  }, 300_000)
})
