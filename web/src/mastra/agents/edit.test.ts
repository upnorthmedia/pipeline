// @vitest-environment node
/**
 * Item 3.4d, provider half: the `edit` agent is registered on the Mastra
 * instance and reaches Anthropic with the request the Python stage sent.
 *
 * Same shape as `write`'s provider test (see `agents/outline.test.ts` for why
 * the outbound request is captured through `globalThis.fetch` rather than a
 * `url` override). Two things are specific to this stage and get their own
 * assertions:
 *
 *   1. `edit`'s system message is the only one carrying embedded newlines and
 *      literal em-dashes. A transcription that normalized either would still
 *      read correctly, so the code points are pinned by position and count,
 *      not just by string equality.
 *   2. `edit_node` is the only stage that names a `format_instruction`, and it
 *      is unconditional: the comment above it records that the stage always
 *      emits Markdown regardless of `output_format`. The two fixtures were
 *      captured at different `output_format` values, so asserting one system
 *      message across both is what proves the constant is not a branch.
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
  CLAUDE_DEFAULT_EFFORT,
  CLAUDE_PROVIDER,
  CLAUDE_THINKING_BUDGET_TOKENS,
  claudeEffectiveMaxTokens,
} from "./claude"
import {
  EDIT_FORMAT_INSTRUCTION,
  EDIT_MAX_TOKENS,
  EDIT_MODEL_ID,
  EDIT_SYSTEM_MESSAGE,
  editAgent,
} from "./edit"

import { lockApiKeysRow, unlockApiKeysRow } from "@/test/api-keys-row"

const GOLDEN_DIR = path.resolve(process.cwd(), "..", "docs", "mastra-port", "golden")
const GOLDEN_SLUGS = ["how-to-choose-a-crm-for-a-small-team", "best-time-tracking-tools-for-agencies"]

type EditFixture = {
  post_spec: { output_format: string; article_type: string }
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

function loadFixture(slug: string): EditFixture {
  return JSON.parse(fs.readFileSync(path.join(GOLDEN_DIR, slug, "edit.json"), "utf8"))
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

describe("edit agent registration", () => {
  it("is registered on the Mastra instance under 'edit'", () => {
    expect(editAgent).toBeInstanceOf(Agent)
    expect(mastra.getAgent("edit")).toBe(editAgent)
    expect(Object.keys(mastra.listAgents())).toContain("edit")
  })

  it("sends the system message the Python stage sent, per the golden fixtures", async () => {
    expect(await editAgent.getInstructions()).toBe(EDIT_SYSTEM_MESSAGE)

    for (const slug of GOLDEN_SLUGS) {
      expect(loadFixture(slug).provider_calls[0].request.system).toBe(EDIT_SYSTEM_MESSAGE)
    }
  })

  it("keeps the em-dashes and the line breaks the prompt text depends on", () => {
    // The requirement list is newline-separated, and requirement 1 is about
    // em-dashes while itself containing one. Equality against the fixture above
    // already covers this, but only as long as the fixture is the oracle; these
    // pin the two properties a hand transcription is most likely to lose.
    const emDashes = [...EDIT_SYSTEM_MESSAGE].filter((c) => c === "—")
    expect(emDashes).toHaveLength(2)
    expect(EDIT_SYSTEM_MESSAGE.split("\n")).toHaveLength(10)
    expect(EDIT_SYSTEM_MESSAGE.split("\n")[1]).toBe(
      "1. ZERO em-dashes (—) anywhere in output",
    )
    expect(EDIT_SYSTEM_MESSAGE).not.toContain("--—")
  })

  it("appends the Markdown format instruction regardless of output_format", () => {
    // `edit_node` is the only stage with a `format_instruction`, and it is a
    // constant: the stage always emits Markdown, with the WordPress HTML
    // conversion deferred to publish time. The fixtures were captured at two
    // different `output_format` values, so one system message across both is
    // the evidence that it does not branch.
    const formats = GOLDEN_SLUGS.map((slug) => loadFixture(slug).post_spec.output_format)
    expect(new Set(formats).size).toBe(2)

    for (const slug of GOLDEN_SLUGS) {
      expect(loadFixture(slug).provider_calls[0].request.system).toMatch(
        new RegExp(`${EDIT_FORMAT_INSTRUCTION.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}$`),
      )
    }
    expect(EDIT_SYSTEM_MESSAGE.endsWith(EDIT_FORMAT_INSTRUCTION)).toBe(true)
  })

  it("carries the model item 6.1 verified, on the provider the fixtures used", () => {
    expect(EDIT_MODEL_ID).toBe("anthropic/claude-opus-5")
    for (const slug of GOLDEN_SLUGS) {
      const call = loadFixture(slug).provider_calls[0]
      expect(call.provider).toBe(CLAUDE_PROVIDER)
      // The provider is still the fixtures'; the model deliberately is not.
      // Item 6.1 moved every Claude stage off `claude-opus-4-6`, so the
      // fixtures pin the prompt and the token budget from here on, not the
      // model id.
      expect(`${call.provider}/${call.request.model}`).not.toBe(EDIT_MODEL_ID)
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
        model: "claude-opus-5",
        content: [
          { type: "thinking", thinking: "checking the SEO checklist", signature: "sig" },
          { type: "text", text: "# The Edited Draft" },
        ],
        stop_reason: "end_turn",
        stop_sequence: null,
        usage: { input_tokens: 8123, output_tokens: 4210 },
      }),
      { status: 200, headers: { "content-type": "application/json" } },
    )
  }) as typeof globalThis.fetch
  return { captured, restore: () => void (globalThis.fetch = realFetch) }
}

describe("edit agent provider request", () => {
  let restoreFetch: (() => void) | undefined

  afterEach(() => {
    restoreFetch?.()
    restoreFetch = undefined
  })

  it("puts item 6.1's model and thinking config on the wire, at Python's max_tokens", async () => {
    await writeAnthropicKey("sk-ant-not-a-real-key")
    const fixture = loadFixture(GOLDEN_SLUGS[0])
    const recorded = fixture.provider_calls[0].request

    const capture = captureAnthropicRequests()
    restoreFetch = capture.restore
    const result = await editAgent.generate(fixture.rendered_prompts[0])

    expect(capture.captured).toHaveLength(1)
    const sent = capture.captured[0]
    expect(sent.url).toBe("https://api.anthropic.com/v1/messages")
    // The model and the thinking parameter both moved in item 6.1: the fixed
    // budget Python sent is rejected by `claude-opus-5`, and adaptive thinking
    // plus `output_config.effort` replaces it.
    expect(sent.body.model).toBe("claude-opus-5")
    expect(sent.body.model).not.toBe(recorded.model)
    expect(sent.body.thinking).toEqual({ type: "adaptive" })
    expect(sent.body.output_config).toEqual({ effort: CLAUDE_DEFAULT_EFFORT })

    // `max_tokens` did not move. Under adaptive thinking the provider stops
    // adding a budget term to it, so passing Python's `effective_max` as
    // `maxOutputTokens` puts the fixture's value back on the wire unchanged.
    expect(sent.body.max_tokens).toBe(recorded.max_tokens)

    // Python sends `system` as a bare string and the AI SDK sends the same text
    // as a one-element block list, as recorded under item 3.2.
    expect(sent.body.system).toEqual([{ type: "text", text: recorded.system }])
    expect(sent.body.messages).toEqual([
      { role: "user", content: [{ type: "text", text: recorded.messages[0].content }] },
    ])

    // The thinking block is stripped from the text, as Python's block filter did.
    expect(result.text).toBe("# The Edited Draft")
  })

  it("passes 16000 through untouched because it clears the thinking floor", () => {
    expect(EDIT_MAX_TOKENS).toBe(16_000)
    expect(EDIT_MAX_TOKENS).toBeGreaterThan(CLAUDE_THINKING_BUDGET_TOKENS + CLAUDE_MIN_TEXT_TOKENS)
    expect(claudeEffectiveMaxTokens(EDIT_MAX_TOKENS)).toBe(EDIT_MAX_TOKENS)
    for (const slug of GOLDEN_SLUGS) {
      expect(claudeEffectiveMaxTokens(EDIT_MAX_TOKENS)).toBe(
        loadFixture(slug).provider_calls[0].request.max_tokens,
      )
    }
  })
})

describe("edit agent credential resolution", () => {
  it("resolves its model from the encrypted key in the settings table", async () => {
    await writeAnthropicKey("sk-ant-not-a-real-key")

    const model = await editAgent.getModel()
    expect(model.modelId).toBe("claude-opus-5")
    expect(model.provider).toContain("anthropic")
  })

  it("fails at model resolution with an actionable message when no key is stored", async () => {
    await clearKeys()

    await expect(editAgent.getModel()).rejects.toThrow(/anthropic API key not configured/)
  })
})

describe.skipIf(!LIVE_KEY)("edit agent live smoke test", () => {
  it("reaches Anthropic and reports back the configured model id", async () => {
    await writeAnthropicKey(LIVE_KEY!)

    const result = await editAgent.generate("Reply with the single word OK.")
    const response = await result.response

    expect(response?.modelId).toBe("claude-opus-5")
    expect(result.text.trim().length).toBeGreaterThan(0)
    expect(result.usage?.outputTokens).toBeGreaterThan(0)
  }, 300_000)
})
