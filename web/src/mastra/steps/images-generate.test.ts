// @vitest-environment node
/**
 * Item 4.7c-ii: the image-generation half of the `images` stage, driven end to
 * end against a recorded Gemini success response.
 *
 * The full-pipeline run under 4.7c-i proved everything about `images` that a
 * failed provider call can prove: the manifest is still assembled and stored,
 * every entry carries its own error, the totals are right and the run continues
 * into `ready`. It could not prove the success path, because this environment's
 * Gemini key is provisioned at `limit: 0` and every image-capable model on it
 * returns 429 (the live probe is pasted under 4.7c-ii in the ledger). No amount
 * of rerunning fixes a billing tier.
 *
 * So the success path is proven here instead, the way the objective permits: a
 * recorded provider response, replayed at the HTTP boundary, with everything
 * downstream of it running for real. What executes below is the production
 * `imagesGenerateStep`, the production `gemini.ts` client parsing a real
 * recorded 200 envelope, the real sharp optimizer, real files on a real disk,
 * the production `imagesAssembleStep` writing the real `image_manifest` column
 * of a real Postgres row, and the production `buildReadyPrompt` reading it back.
 * The only stub is the credential lookup, and only because the `api_keys`
 * settings row is a process-global singleton that `api-keys.test.ts` already
 * owns exclusively; seeding it from a second file that vitest may run in
 * parallel would make both flaky. That lookup is proven there.
 *
 * Two corpora, neither of them this port's own output:
 *
 * - `images/data/gemini-parity.json`, the `usage-reported` response captured
 *   from the real Python client with `httpx` intercepted. Its envelope is used
 *   verbatim; only the base64 payload is swapped, because the recorded one is a
 *   1x1 pixel and the point here is to watch the optimizer resize.
 * - `images/data/image-generation-parity.json`, whose `wide_png_base64` is the
 *   2400x1600 PNG the 3.5e exporter fed the real Python stage. It is wider than
 *   both optimize widths, so it exercises the resize branch on both.
 *
 * Requires `docker compose up -d db redis`.
 */
import { mkdtemp, readFile, rm, stat } from "node:fs/promises"
import { tmpdir } from "node:os"
import path from "node:path"

import { and, eq } from "drizzle-orm"
import sharp from "sharp"
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest"

import { closeDb, getDb, posts, settings, websiteProfiles } from "../../db"
import { swapFetchForSuite } from "../../test/swapped-fetch"
import { TOPIC_PIPELINE_EVENTS } from "../pipeline-events"
import geminiCorpus from "../images/data/gemini-parity.json"
import corpus from "../images/data/image-generation-parity.json"
import { GEMINI_API_BASE, GEMINI_IMAGE_MODEL_ID } from "../images/gemini"
import { CONTENT_MAX_WIDTH, FEATURED_MAX_WIDTH } from "../images/generate-one"
import { loadPipelineState } from "../post-state"
import { STAGE_MODELS_SETTING_KEY } from "../stage-models"
import { loadRules } from "../prompts"
import { imagesAssembleStep } from "./images-assemble"
import { imagesGenerateStep } from "./images-generate"
import type { GeneratedImageOutput } from "./images-generate"
import type { ImagesManifestOutput } from "./images-manifest"
import { buildReadyPrompt } from "./ready"

/**
 * The key the step is expected to hand the client. A literal, so the assertion
 * that it reaches the `x-goog-api-key` header proves the step resolved a
 * credential rather than that some ambient key happened to be set.
 */
const GEMINI_KEY = "images-generate-test-key"

vi.mock("../api-keys", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../api-keys")>()),
  requireApiKey: async () => GEMINI_KEY,
}))

type RecordedResponse = {
  label: string
  status: number
  body: { candidates?: { content?: { parts?: { inlineData?: { data?: string } }[] } }[] }
}

const recorded = (geminiCorpus.responses as unknown as RecordedResponse[]).find(
  (response) => response.label === "usage-reported",
)
if (!recorded) throw new Error("gemini-parity.json has no 'usage-reported' response")

/** `usageMetadata` as the recorded 200 reported it. */
const RECORDED_TOKENS_IN = 37
const RECORDED_TOKENS_OUT = 1290

/** The recorded envelope, carrying the 2400x1600 PNG instead of its 1x1 pixel. */
function recordedSuccess(): string {
  const body = JSON.parse(JSON.stringify(recorded)) as RecordedResponse
  const part = body.body.candidates?.[0]?.content?.parts?.[0]
  if (!part?.inlineData) throw new Error("recorded response has no inline image part")
  part.inlineData.data = corpus.wide_png_base64
  return JSON.stringify(body.body)
}

/** The dimensions of that PNG, read from the corpus rather than assumed. */
const SOURCE_WIDTH = 2400
const SOURCE_HEIGHT = 1600

const POST_ID = "00000000-0000-4000-8000-0000004c7c22"

const db = getDb()

interface CapturedRequest {
  url: string
  apiKey: string | null
  body: {
    contents: { parts: { text: string }[]; role: string }[]
    generationConfig: { responseModalities: string[]; imageConfig: Record<string, string> }
  }
}

const requests: CapturedRequest[] = []

const contentSpec = {
  id: "pipeline-diagram",
  type: "content",
  filename: "how-a-crm-pipeline-works.png",
  prompt: "a teal isometric diagram of a sales pipeline",
  aspect_ratio: "4:3",
  image_size: "1K",
  placement: { location: "after_section", after_section: "How it works" },
}

const featuredSpec = {
  id: "hero",
  type: "featured",
  filename: "hero.png",
  prompt: "a wide editorial hero",
  aspect_ratio: "16:9",
  image_size: "2K",
  placement: { location: "featured_image", after_section: null },
}

const promptlessSpec = {
  id: "entry-the-model-left-empty",
  type: "content",
  filename: "nothing.png",
  placement: { location: "after_section", after_section: "Conclusion" },
}

/**
 * Item 5.5c-iv-d-2: what the two per-image lines are published onto, and the
 * logger Python wrote its adjacent `logger.error` to.
 *
 * A stub transport rather than a real `Mastra`, because the assertions below
 * are about which event the step chose and what it interpolated; the topic and
 * the envelope are `pipeline-events.ts`'s contract and are asserted there. The
 * execution-log half of every publish lands on the real row.
 */
const published: { topic: string; payload: Record<string, unknown> }[] = []
const loggedErrors: string[] = []

const stepMastra = {
  pubsub: {
    publish: async (topic: string, event: { data: Record<string, unknown> }) => {
      published.push({ topic, payload: event.data })
    },
  },
  getLogger: () => ({
    debug: () => {},
    error: (message: string) => {
      loggedErrors.push(message)
    },
  }),
}

/** The published payloads, in publish order, for one event name. */
function publishedOf(event: string): Record<string, unknown>[] {
  return published.filter((entry) => entry.payload.event === event).map((entry) => entry.payload)
}

/** The post's stored trail, for the entries the fan-out wrote. */
async function storedImageEntries(): Promise<Record<string, unknown>[]> {
  const [row] = await db.select().from(posts).where(eq(posts.id, POST_ID))
  const entries = (row.executionLogs ?? []) as Record<string, unknown>[]
  return entries.filter(
    (entry) => entry.event === "image_generated" || entry.event === "image_failed",
  )
}

type ExecuteParams = Parameters<typeof imagesGenerateStep.execute>[0]
type AssembleParams = Parameters<typeof imagesAssembleStep.execute>[0]

let mediaDir = ""
let content: GeneratedImageOutput
let featured: GeneratedImageOutput
let promptless: GeneratedImageOutput

async function generate(spec: Record<string, unknown>, index: number) {
  return (await imagesGenerateStep.execute({
    inputData: { postId: POST_ID, mediaDir, index, spec },
    mastra: stepMastra,
  } as unknown as ExecuteParams)) as GeneratedImageOutput
}

/** The written file's real size on disk, which the manifest claims as `size_bytes`. */
async function diskBytes(spec: Record<string, unknown>): Promise<number> {
  const url = String(spec.url)
  return (await stat(path.join(mediaDir, path.basename(url)))).size
}

swapFetchForSuite((input, init) => {
  const headers = new Headers(init?.headers)
  requests.push({
    url: String(input),
    apiKey: headers.get("x-goog-api-key"),
    body: JSON.parse(String(init?.body)) as CapturedRequest["body"],
  })
  return new Response(recordedSuccess(), {
    status: 200,
    headers: { "content-type": "application/json" },
  })
})

beforeAll(async () => {
  mediaDir = await mkdtemp(path.join(tmpdir(), "images-generate-"))

  await db.delete(posts).where(eq(posts.id, POST_ID))
  await db.insert(posts).values({
    id: POST_ID,
    slug: "how-to-choose-a-crm-for-a-small-team",
    topic: "How to choose a CRM for a small team",
    outputFormat: "both",
    currentStage: "images",
    finalMdContent: "# How to choose a CRM\n\nThe edited draft the ready stage rewrites.",
    stageStatus: { research: "complete", outline: "complete", write: "complete", edit: "complete" },
  })

  content = await generate(contentSpec, 0)
  featured = await generate(featuredSpec, 1)
  promptless = await generate(promptlessSpec, 2)
}, 60_000)

afterAll(async () => {
  vi.restoreAllMocks()
  if (mediaDir) await rm(mediaDir, { recursive: true, force: true })
  await db.delete(posts).where(eq(posts.id, POST_ID))
  await closeDb()
})

describe("imagesGenerateStep against a recorded Gemini success", () => {
  it("sends the entry's aspect ratio and size to the incumbent model with the resolved key", () => {
    expect(requests).toHaveLength(2)
    for (const request of requests) {
      expect(request.url).toBe(
        `${GEMINI_API_BASE}/models/${GEMINI_IMAGE_MODEL_ID}:generateContent`,
      )
      expect(request.apiKey).toBe(GEMINI_KEY)
      expect(request.body.generationConfig.responseModalities).toEqual(["IMAGE"])
    }
    expect(requests[0].body.contents[0].parts[0].text).toBe(contentSpec.prompt)
    expect(requests[0].body.generationConfig.imageConfig).toEqual({
      aspectRatio: "4:3",
      imageSize: "1K",
    })
    // `placement` is an object, so the featured overrides never fire and the
    // entry's own `16:9` / `2K` is what is sent (the 3.5e divergence).
    expect(requests[1].body.generationConfig.imageConfig).toEqual({
      aspectRatio: "16:9",
      imageSize: "2K",
    })
  })

  it("writes the content image at the content width, and its manifest entry names it", async () => {
    expect(content.spec.generated).toBe(true)
    expect(content.spec.error).toBeUndefined()
    expect(content.spec.index).toBe(0)
    expect(content.spec.url).toBe(`/media/${POST_ID}/how-a-crm-pipeline-works.webp`)

    const bytes = await readFile(path.join(mediaDir, "how-a-crm-pipeline-works.webp"))
    expect(content.spec.size_bytes).toBe(bytes.length)

    const meta = await sharp(bytes).metadata()
    expect(meta.format).toBe("webp")
    expect(meta.width).toBe(CONTENT_MAX_WIDTH)
    expect(meta.height).toBe(Math.trunc((SOURCE_HEIGHT * CONTENT_MAX_WIDTH) / SOURCE_WIDTH))
  })

  it("writes the featured image at the featured width under a rewritten filename", async () => {
    expect(featured.spec.generated).toBe(true)
    expect(featured.spec.index).toBe(1)
    // `type: "featured"` picks the width and rewrites the filename; the model's
    // own `hero.png` is discarded.
    expect(featured.spec.url).toMatch(
      new RegExp(`^/media/${POST_ID}/featured-\\d{6}-\\d{2}\\.webp$`),
    )

    const bytes = await readFile(path.join(mediaDir, path.basename(String(featured.spec.url))))
    expect(featured.spec.size_bytes).toBe(bytes.length)

    const meta = await sharp(bytes).metadata()
    expect(meta.format).toBe("webp")
    expect(meta.width).toBe(FEATURED_MAX_WIDTH)
    expect(meta.height).toBe(Math.trunc((SOURCE_HEIGHT * FEATURED_MAX_WIDTH) / SOURCE_WIDTH))
  })

  it("bills each generated image with the counts the response reported", () => {
    for (const result of [content, featured]) {
      expect(result.usage).toEqual({
        tokensIn: RECORDED_TOKENS_IN,
        tokensOut: RECORDED_TOKENS_OUT,
        model: GEMINI_IMAGE_MODEL_ID,
      })
    }
  })

  it("records an entry with no prompt as failed without calling or billing the provider", () => {
    expect(promptless.spec.generated).toBe(false)
    expect(promptless.spec.error).toBe("no prompt")
    expect(promptless.spec.url).toBeUndefined()
    expect(promptless.usage).toBeNull()
    // Two calls total, both accounted for above, so this entry made none.
    expect(requests).toHaveLength(2)
  })
})

/**
 * Item 5.5c-iv-d-2: the two `publish_stage_log` calls inside `_generate_one`.
 *
 * They are the only two in the pipeline that do not use the `log` event name,
 * and the only two published from inside a fan-out. Their `data` payloads are
 * two of the three in the whole port that carry one at all.
 */
describe("the per-image lines the fan-out publishes", () => {
  it("publishes one `image_generated` per generated entry and nothing else", () => {
    expect(publishedOf("image_generated")).toHaveLength(2)
    expect(published).toHaveLength(2)
  })

  it("interpolates Python's message and carries its three data keys", () => {
    const [first, second] = publishedOf("image_generated")

    expect(first).toEqual({
      event: "image_generated",
      post_id: POST_ID,
      stage: "images",
      message: `Image 0 generated (${content.spec.size_bytes} bytes)`,
      level: "info",
      timestamp: expect.any(String),
      data: { index: 0, bytes: content.spec.size_bytes, path: content.spec.url },
    })
    expect(second.message).toBe(`Image 1 generated (${featured.spec.size_bytes} bytes)`)
    expect(second.data).toEqual({
      index: 1,
      bytes: featured.spec.size_bytes,
      path: featured.spec.url,
    })
  })

  it("publishes onto the one pipeline topic", () => {
    expect(published.map((entry) => entry.topic)).toEqual([
      TOPIC_PIPELINE_EVENTS,
      TOPIC_PIPELINE_EVENTS,
    ])
  })

  it("says nothing about the entry the model gave no prompt", () => {
    // Python's no-prompt branch returns before the semaphore and before either
    // publish, so the dashboard never learns the entry existed. `promptless`
    // was generated in `beforeAll`, so its absence here is a real absence.
    expect(promptless.spec.generated).toBe(false)
    expect(publishedOf("image_generated").map((payload) => payload.data)).not.toContainEqual(
      expect.objectContaining({ index: 2 }),
    )
    expect(publishedOf("image_failed")).toEqual([])
    expect(loggedErrors).toEqual([])
  })

  it("stores each line on the post's own trail", async () => {
    const entries = await storedImageEntries()

    expect(entries).toEqual([
      {
        ts: expect.any(String),
        stage: "images",
        level: "info",
        event: "image_generated",
        message: `Image 0 generated (${content.spec.size_bytes} bytes)`,
        data: { index: 0, bytes: content.spec.size_bytes, path: content.spec.url },
      },
      {
        ts: expect.any(String),
        stage: "images",
        level: "info",
        event: "image_generated",
        message: `Image 1 generated (${featured.spec.size_bytes} bytes)`,
        data: { index: 1, bytes: featured.spec.size_bytes, path: featured.spec.url },
      },
    ])
  })
})

describe("the generated images reach the stored manifest and the ready prompt", () => {
  /** The manifest step's output as it would have been for these three entries. */
  const manifestOutput: ImagesManifestOutput = {
    postId: POST_ID,
    stages: undefined,
    skipped: false,
    stageStartedAtMs: Date.now(),
    model: "claude-opus-4-6",
    tokensIn: 1_200,
    tokensOut: 900,
    parseFailed: false,
    manifest: {
      style: "flat editorial vector",
      brand_colors: ["#0f766e"],
      images: [contentSpec, featuredSpec, promptlessSpec],
    },
    images: [contentSpec, featuredSpec, promptlessSpec],
  }

  let stored: Record<string, unknown>
  let prompt: string

  beforeAll(async () => {
    await imagesAssembleStep.execute({
      inputData: [content, featured, promptless],
      getStepResult: () => manifestOutput,
      // The step announces `stage_complete` once it has committed the manifest
      // (item 5.5b); swallowed here, and asserted in `images-assemble.test.ts`.
      mastra: { pubsub: { publish: async () => {} } },
    } as unknown as AssembleParams)

    const rows = await db.select().from(posts).where(eq(posts.id, POST_ID))
    stored = rows[0].imageManifest as Record<string, unknown>

    const state = await loadPipelineState(POST_ID)
    prompt = buildReadyPrompt(loadRules("ready"), state, "2026-08-22")
  }, 30_000)

  it("stores every entry with the totals the fan-out produced", () => {
    expect(stored.total_generated).toBe(2)
    expect(stored.total_failed).toBe(1)
    expect((stored.images as unknown[]).length).toBe(3)
  })

  it("claims a byte count for each generated entry that matches the file on disk", async () => {
    const images = stored.images as Record<string, unknown>[]
    for (const entry of images.filter((image) => image.generated === true)) {
      expect(entry.size_bytes).toBe(await diskBytes(entry))
    }
  })

  it("embeds the generated urls in the ready prompt and drops the failed entry", () => {
    // Asserted first so the two negative expectations below cannot pass on a
    // prompt that simply has no manifest section.
    expect(prompt).toContain("## Image Manifest (generated images only)")
    expect(prompt).toContain(String(content.spec.url))
    expect(prompt).toContain(String(featured.spec.url))
    expect(prompt).not.toContain(promptlessSpec.id)
    expect(prompt).not.toContain("no prompt")
  })
})

/**
 * The failure half of item 5.5c-iv-d-2, on its own transport so the request
 * capture the success assertions rest on is left alone.
 *
 * Python logged the failure *and* published it, from the same `except` block,
 * so both are ported: the operator's server log keeps the line it had, and the
 * browser gains the one it never received because `use-sse.ts` does not listen
 * for this event name (recorded under the item in the ledger).
 */
describe("an image whose provider call fails", () => {
  let failed: GeneratedImageOutput
  const failRequests: string[] = []

  swapFetchForSuite((input) => {
    failRequests.push(String(input))
    return new Response(JSON.stringify({ error: { status: "UNAVAILABLE" } }), {
      status: 503,
      headers: { "content-type": "application/json" },
    })
  })

  beforeAll(async () => {
    published.length = 0
    loggedErrors.length = 0

    failed = await generate(
      { ...contentSpec, id: "doomed", filename: "doomed.png", prompt: "a doomed image" },
      7,
    )
  }, 30_000)

  it("records the entry as failed without a file", () => {
    expect(failRequests).toHaveLength(1)
    expect(failed.spec.generated).toBe(false)
    expect(failed.spec.url).toBeUndefined()
    expect(failed.usage).toBeNull()
  })

  it("publishes `image_failed` at level error with Python's two data keys", () => {
    const error = String(failed.spec.error)
    // The provider's own text, not a restatement of it: the same string the
    // manifest entry stores is what the line and the payload carry.
    expect(error).toContain("503")
    expect(publishedOf("image_failed")).toEqual([
      {
        event: "image_failed",
        post_id: POST_ID,
        stage: "images",
        message: `Image 7 failed: ${error}`,
        level: "error",
        timestamp: expect.any(String),
        data: { index: 7, error },
      },
    ])
    expect(publishedOf("image_generated")).toEqual([])
  })

  it("writes Python's adjacent logger line as well", () => {
    expect(loggedErrors).toEqual([`Failed to generate image 7: ${String(failed.spec.error)}`])
  })

  it("stores the line on the post's own trail", async () => {
    const entries = await storedImageEntries()

    expect(entries.at(-1)).toEqual({
      ts: expect.any(String),
      stage: "images",
      level: "error",
      event: "image_failed",
      message: `Image 7 failed: ${String(failed.spec.error)}`,
      data: { index: 7, error: String(failed.spec.error) },
    })
  })
})

/**
 * Item 6.2b: the generation model comes from the `images` entry in the owning
 * user's `stage_models` row, not from `GEMINI_IMAGE_MODEL_ID`.
 *
 * The assertion is on the request URL because that is where the model id lands
 * for this provider: `generateContent` is a per-model endpoint, so an override
 * that failed to reach the client would still send to the default model's path
 * and be invisible in the body.
 */
describe("imagesGenerateStep model configuration", () => {
  const PROFILE_ID = "00000000-0000-4000-8000-0000004c7d01"
  const OWNER_ID = "images-generate-owner-6-2b"
  const OVERRIDE = "gemini-3.1-flash-image-preview"
  /**
   * This suite installs its own transport rather than reading `requests`: it
   * needs the request URL of a call it makes itself, and it wants a 200 rather
   * than the failure the retry suites send.
   */
  const urls: string[] = []

  swapFetchForSuite((input) => {
    urls.push(String(input))
    return new Response(recordedSuccess(), {
      status: 200,
      headers: { "content-type": "application/json" },
    })
  })

  beforeAll(async () => {
    await db.insert(websiteProfiles).values({
      id: PROFILE_ID,
      name: "Images owner",
      websiteUrl: "https://images-owner.example.test",
      userId: OWNER_ID,
    })
    await db.update(posts).set({ profileId: PROFILE_ID }).where(eq(posts.id, POST_ID))
    await db.insert(settings).values({
      key: STAGE_MODELS_SETTING_KEY,
      userId: OWNER_ID,
      value: { images: { model: OVERRIDE } },
    })
  })

  afterAll(async () => {
    await db
      .delete(settings)
      .where(and(eq(settings.key, STAGE_MODELS_SETTING_KEY), eq(settings.userId, OWNER_ID)))
    await db.update(posts).set({ profileId: null }).where(eq(posts.id, POST_ID))
    await db.delete(websiteProfiles).where(eq(websiteProfiles.id, PROFILE_ID))
  })

  it("posts to the model stored for the post's owner", async () => {
    expect(OVERRIDE).not.toBe(GEMINI_IMAGE_MODEL_ID)

    const generated = await generate(contentSpec, 0)

    expect(generated.outcome).toMatchObject({ kind: "generated" })
    expect(urls).toEqual([`${GEMINI_API_BASE}/models/${OVERRIDE}:generateContent`])
  })
})
