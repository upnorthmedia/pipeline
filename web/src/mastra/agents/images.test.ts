// @vitest-environment node
/**
 * Item 3.5c, provider half: the `images` agent is registered on the Mastra
 * instance and reaches Anthropic with the request the Python stage sent for
 * step 1 of `images_node`.
 *
 * Same shape as `edit`'s provider test (see `agents/outline.test.ts` for why
 * the outbound request is captured through `globalThis.fetch` rather than a
 * `url` override). Three things are specific to this stage:
 *
 *   1. `images` is the only stage whose Python call is followed by more
 *      provider calls in the same node, so `provider_calls[0]` being the only
 *      Anthropic entry is asserted rather than assumed. Everything after it is
 *      Gemini and belongs to item 3.5d.
 *   2. Its `max_tokens=8000` is below the extended-thinking floor, so the
 *      value on the wire is 11024. `outline` shares that branch; this pins it
 *      against the recorded request rather than against `outline`'s constant.
 *   3. The system message forbids code fences and both recorded answers obey
 *      it, so `parseManifest`'s fenced-block branch is unexercised by the
 *      fixtures. That is asserted rather than assumed, because it is the
 *      reason item 3.5a needed a synthetic corpus at all.
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
import { parseManifest } from "../images/manifest"
import { mastra, pubsub } from "../index"
import {
  CLAUDE_MIN_TEXT_TOKENS,
  CLAUDE_PROVIDER,
  CLAUDE_THINKING_BUDGET_TOKENS,
  claudeEffectiveMaxTokens,
} from "./claude"
import {
  IMAGES_MAX_TOKENS,
  IMAGES_MODEL_ID,
  IMAGES_SYSTEM_MESSAGE,
  imagesAgent,
} from "./images"

import { lockApiKeysRow, unlockApiKeysRow } from "@/test/api-keys-row"

const GOLDEN_DIR = path.resolve(process.cwd(), "..", "docs", "mastra-port", "golden")
const GOLDEN_SLUGS = ["how-to-choose-a-crm-for-a-small-team", "best-time-tracking-tools-for-agencies"]

type ProviderCall = {
  provider: string
  request: {
    model: string
    max_tokens?: number
    thinking?: { type: string; budget_tokens: number }
    system?: string
    messages?: { role: string; content: string }[]
  }
  response?: { content: ({ type: string } & Record<string, unknown>)[] }
}

type ImagesFixture = {
  post_spec: { output_format: string; article_type: string }
  rendered_prompts: string[]
  provider_calls: ProviderCall[]
  stage_output: { _stage_meta: { model: string; tokens_in: number; tokens_out: number } }
}

function loadFixture(slug: string): ImagesFixture {
  return JSON.parse(fs.readFileSync(path.join(GOLDEN_DIR, slug, "images.json"), "utf8"))
}

/**
 * The manifest text as `images_node` sees it: Python's `ClaudeClient.chat()`
 * keeps only the `text` blocks, dropping the `thinking` block that precedes
 * them in both recordings.
 */
function manifestText(fixture: ImagesFixture): string {
  const blocks = fixture.provider_calls[0].response?.content ?? []
  return blocks
    .filter((b) => b.type === "text")
    .map((b) => String(b.text))
    .join("")
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
    .onConflictDoUpdate({ target: [settings.key, settings.userId], set: { value } })
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

describe("images agent registration", () => {
  it("is registered on the Mastra instance under 'images'", () => {
    expect(imagesAgent).toBeInstanceOf(Agent)
    expect(mastra.getAgent("images")).toBe(imagesAgent)
    expect(Object.keys(mastra.listAgents())).toContain("images")
  })

  it("sends the system message the Python stage sent, per the golden fixtures", async () => {
    expect(await imagesAgent.getInstructions()).toBe(IMAGES_SYSTEM_MESSAGE)

    for (const slug of GOLDEN_SLUGS) {
      expect(loadFixture(slug).provider_calls[0].request.system).toBe(IMAGES_SYSTEM_MESSAGE)
    }
  })

  it("keeps the single-line, fence-free wording Python's four literals produce", () => {
    // Equality against the fixture above already covers this, but only while
    // the fixture is the oracle. These pin the properties a hand transcription
    // of four adjacent Python literals is most likely to lose: a dropped space
    // at a literal boundary, or an invented line break.
    expect(IMAGES_SYSTEM_MESSAGE).not.toContain("\n")
    expect(IMAGES_SYSTEM_MESSAGE).not.toMatch(/ {2}/)
    expect(IMAGES_SYSTEM_MESSAGE.split(" ")).toHaveLength(28)
    expect(IMAGES_SYSTEM_MESSAGE.endsWith("Output ONLY valid JSON, no code fences.")).toBe(true)
  })

  it("is the only Anthropic call in a node that also calls Gemini", () => {
    for (const slug of GOLDEN_SLUGS) {
      const calls = loadFixture(slug).provider_calls
      expect(calls.filter((c) => c.provider === CLAUDE_PROVIDER)).toHaveLength(1)
      expect(calls[0].provider).toBe(CLAUDE_PROVIDER)
      expect(calls.slice(1).map((c) => c.provider)).toEqual(
        Array(calls.length - 1).fill("gemini"),
      )
    }
  })

  it("carries the model the golden fixtures were captured with", () => {
    for (const slug of GOLDEN_SLUGS) {
      const fixture = loadFixture(slug)
      const call = fixture.provider_calls[0]
      expect(`${call.provider}/${call.request.model}`).toBe(IMAGES_MODEL_ID)
      // `_stage_meta.model` is what the dashboard's cost view reads, and it is
      // the manifest call's model, not Gemini's.
      expect(fixture.stage_output._stage_meta.model).toBe(call.request.model)
    }
  })

  it("gets fence-free JSON back, so parseManifest's fenced branch stays untested by the fixtures", () => {
    // The system message says "no code fences" and both recorded answers obey:
    // each opens at the brace. `parseManifest`'s fenced-block branch therefore
    // has no fixture coverage, which is why item 3.5a built a synthetic corpus
    // rather than leaning on the golden files. If a prompt change ever makes
    // Claude fence its answer, this test is the thing that says so.
    expect(IMAGES_SYSTEM_MESSAGE).toContain("no code fences")
    for (const slug of GOLDEN_SLUGS) {
      const raw = manifestText(loadFixture(slug))
      expect(raw.trimStart().startsWith("```")).toBe(false)
      expect(raw.trimStart().startsWith("{")).toBe(true)
      const parsed = parseManifest(raw) as Record<string, unknown>
      expect(parsed.error).toBeUndefined()
      expect(Array.isArray(parsed.images)).toBe(true)
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
          { type: "thinking", thinking: "planning the image set", signature: "sig" },
          { type: "text", text: '{"images": [], "style_brief": {}}' },
        ],
        stop_reason: "end_turn",
        stop_sequence: null,
        usage: { input_tokens: 6712, output_tokens: 2044 },
      }),
      { status: 200, headers: { "content-type": "application/json" } },
    )
  }) as typeof globalThis.fetch
  return { captured, restore: () => void (globalThis.fetch = realFetch) }
}

describe("images agent provider request", () => {
  let restoreFetch: (() => void) | undefined

  afterEach(() => {
    restoreFetch?.()
    restoreFetch = undefined
  })

  for (const slug of GOLDEN_SLUGS) {
    it(`puts Python's model, max_tokens, thinking budget and prompt on the wire (${slug})`, async () => {
      await writeAnthropicKey("sk-ant-not-a-real-key")
      const fixture = loadFixture(slug)
      const recorded = fixture.provider_calls[0].request

      const capture = captureAnthropicRequests()
      restoreFetch = capture.restore
      const result = await imagesAgent.generate(fixture.rendered_prompts[0])

      expect(capture.captured).toHaveLength(1)
      const sent = capture.captured[0]
      expect(sent.url).toBe("https://api.anthropic.com/v1/messages")
      expect(sent.body.model).toBe(recorded.model)
      expect(sent.body.max_tokens).toBe(recorded.max_tokens)
      expect(sent.body.thinking).toEqual(recorded.thinking)

      // Python sends `system` as a bare string and the AI SDK sends the same
      // text as a one-element block list, as recorded under item 3.2.
      expect(sent.body.system).toEqual([{ type: "text", text: recorded.system }])
      expect(sent.body.messages).toEqual([
        { role: "user", content: [{ type: "text", text: recorded.messages![0].content }] },
      ])

      // The thinking block is stripped from the text, as Python's block filter
      // did, so what reaches `parseManifest` is the JSON alone.
      expect(result.text).toBe('{"images": [], "style_brief": {}}')
    })
  }

  it("raises 8000 to the 11024 the thinking floor forces", () => {
    expect(IMAGES_MAX_TOKENS).toBe(8_000)
    expect(IMAGES_MAX_TOKENS).toBeLessThan(CLAUDE_THINKING_BUDGET_TOKENS + CLAUDE_MIN_TEXT_TOKENS)
    expect(claudeEffectiveMaxTokens(IMAGES_MAX_TOKENS)).toBe(
      CLAUDE_THINKING_BUDGET_TOKENS + CLAUDE_MIN_TEXT_TOKENS,
    )
    for (const slug of GOLDEN_SLUGS) {
      expect(claudeEffectiveMaxTokens(IMAGES_MAX_TOKENS)).toBe(
        loadFixture(slug).provider_calls[0].request.max_tokens,
      )
    }
  })
})

describe("images agent credential resolution", () => {
  it("resolves its model from the encrypted key in the settings table", async () => {
    await writeAnthropicKey("sk-ant-not-a-real-key")

    const model = await imagesAgent.getModel()
    expect(model.modelId).toBe("claude-opus-4-6")
    expect(model.provider).toContain("anthropic")
  })

  it("fails at model resolution with an actionable message when no key is stored", async () => {
    await clearKeys()

    await expect(imagesAgent.getModel()).rejects.toThrow(/anthropic API key not configured/)
  })
})

describe.skipIf(!LIVE_KEY)("images agent live smoke test", () => {
  it("reaches Anthropic and reports back the configured model id", async () => {
    await writeAnthropicKey(LIVE_KEY!)

    const result = await imagesAgent.generate("Reply with the single word OK.")
    const response = await result.response

    expect(response?.modelId).toBe("claude-opus-4-6")
    expect(result.text.trim().length).toBeGreaterThan(0)
    expect(result.usage?.outputTokens).toBeGreaterThan(0)
  }, 300_000)
})
