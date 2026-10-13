/**
 * Ledger item 6.1: prove every stage model ID resolves against the live
 * provider, using the credentials the pipeline itself uses.
 *
 * Nothing here is a parity check. The single question is whether an ID this
 * repo is about to hardcode is a real, reachable model on the account whose
 * key sits in `settings.api_keys`, answered by the provider's own reported
 * model field rather than by documentation. A documented ID that 404s on this
 * account is not usable, and an undocumented ID that answers is not a model
 * this repo should adopt, so both halves of 6.1 (docs and a live call) are
 * needed and only the second one is scriptable.
 *
 * It stays a script rather than a suite member because it bills three
 * providers on every run, including one image generation.
 *
 * Run from `web/` with the repo `.env` sourced:
 *
 *   set -a && . ../.env && set +a
 *   node --disable-warning=MODULE_TYPELESS_PACKAGE_JSON \
 *     --experimental-strip-types src/mastra/scripts/verify-models.mjs
 */
import pg from "pg"

import { decrypt } from "../../lib/crypto.ts"

const ANTHROPIC_CANDIDATES = ["claude-opus-5", "claude-fable-5", "claude-opus-4-6"]
const PERPLEXITY_CANDIDATES = ["sonar-pro"]
const GEMINI_CANDIDATES = ["gemini-3-pro-image", "gemini-3.1-flash-image-preview"]

function requireEnv(name) {
  const value = process.env[name]
  if (!value) throw new Error(`${name} is not set`)
  return value
}

/** The same `user_id IS NULL` read `getApiKeys()` performs. */
async function loadKeys() {
  const client = new pg.Client({
    connectionString: process.env.DATABASE_URL_SYNC ?? requireEnv("DATABASE_URL"),
  })
  await client.connect()
  try {
    const { rows } = await client.query(
      "select value from settings where key = 'api_keys' and user_id is null limit 1",
    )
    const stored = rows[0]?.value ?? {}
    return {
      anthropic: stored.anthropic ? decrypt(stored.anthropic) : "",
      perplexity: stored.perplexity ? decrypt(stored.perplexity) : "",
      gemini: stored.gemini ? decrypt(stored.gemini) : "",
    }
  } finally {
    await client.end()
  }
}

function line(...parts) {
  console.log(parts.join(" "))
}

/**
 * Anthropic, with the exact request shape the four reasoning stages would send
 * after the upgrade: adaptive thinking plus `output_config.effort`, which the
 * older `thinking.budget_tokens` form is rejected in favour of on this tier.
 */
async function checkAnthropic(apiKey, model) {
  const started = Date.now()
  const response = await fetch("https://api.anthropic.com/v1/messages", {
    method: "post",
    headers: {
      "content-type": "application/json",
      "x-api-key": apiKey,
      "anthropic-version": "2023-06-01",
    },
    body: JSON.stringify({
      model,
      max_tokens: 1024,
      thinking: { type: "adaptive" },
      output_config: { effort: "high" },
      messages: [{ role: "user", content: "Reply with the single word: ok" }],
    }),
  })
  const elapsed = ((Date.now() - started) / 1000).toFixed(1)
  const payload = await response.json()
  if (response.status !== 200) {
    line(`anthropic ${model}: HTTP ${response.status}`, JSON.stringify(payload))
    return
  }
  const text = (payload.content ?? [])
    .filter((block) => block.type === "text")
    .map((block) => block.text)
    .join("")
  line(
    `anthropic ${model}: HTTP 200 model=${payload.model} stop_reason=${payload.stop_reason}`,
    `text=${JSON.stringify(text)}`,
    `usage=${JSON.stringify(payload.usage)}`,
    `${elapsed}s`,
  )
}

/** Perplexity, checked for the citation grounding the research stage needs. */
async function checkPerplexity(apiKey, model) {
  const started = Date.now()
  const response = await fetch("https://api.perplexity.ai/chat/completions", {
    method: "post",
    headers: { "content-type": "application/json", authorization: `Bearer ${apiKey}` },
    body: JSON.stringify({
      model,
      max_tokens: 256,
      messages: [{ role: "user", content: "Name one 2026 SEO trend and cite a source." }],
    }),
  })
  const elapsed = ((Date.now() - started) / 1000).toFixed(1)
  const payload = await response.json()
  if (response.status !== 200) {
    line(`perplexity ${model}: HTTP ${response.status}`, JSON.stringify(payload))
    return
  }
  const citations = payload.citations ?? payload.search_results ?? []
  line(
    `perplexity ${model}: HTTP 200 model=${payload.model}`,
    `citations=${citations.length}`,
    `usage=${JSON.stringify(payload.usage)}`,
    `${elapsed}s`,
  )
}

/** Gemini, using the exact body `generate_image` posts. */
async function checkGemini(apiKey, model) {
  const started = Date.now()
  const response = await fetch(
    `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent`,
    {
      method: "post",
      headers: { "content-type": "application/json", "x-goog-api-key": apiKey },
      body: JSON.stringify({
        contents: [
          { parts: [{ text: "A plain teal square on a white background." }], role: "user" },
        ],
        generationConfig: {
          responseModalities: ["IMAGE"],
          imageConfig: { aspectRatio: "4:3", imageSize: "1K" },
        },
      }),
    },
  )
  const elapsed = ((Date.now() - started) / 1000).toFixed(1)
  const payload = await response.json()
  if (response.status !== 200) {
    line(`gemini ${model}: HTTP ${response.status}`, JSON.stringify(payload).slice(0, 400))
    return
  }
  const parts = payload.candidates?.[0]?.content?.parts ?? []
  const image = parts.find((part) => part.inlineData)
  line(
    `gemini ${model}: HTTP 200 modelVersion=${payload.modelVersion}`,
    image
      ? `mimeType=${image.inlineData.mimeType} bytes=${Buffer.from(image.inlineData.data, "base64").length}`
      : "NO IMAGE PART",
    `usage=${JSON.stringify(payload.usageMetadata)}`,
    `${elapsed}s`,
  )
}

const keys = await loadKeys()
for (const model of ANTHROPIC_CANDIDATES) await checkAnthropic(keys.anthropic, model)
for (const model of PERPLEXITY_CANDIDATES) await checkPerplexity(keys.perplexity, model)
for (const model of GEMINI_CANDIDATES) await checkGemini(keys.gemini, model)
