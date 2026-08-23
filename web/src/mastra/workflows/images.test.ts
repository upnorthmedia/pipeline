// @vitest-environment node
/**
 * The `images` stage executed for real by the evented engine (item 3.5f-ii).
 *
 * Everything else about this stage is asserted against Python one piece at a
 * time. This file asserts the thing only a real run can show: that the three
 * steps compose, that `.foreach()` actually fans the manifest out and hands
 * every entry back in manifest order, that it holds Python's semaphore width,
 * and that the stage still writes the post row exactly once when the work is
 * spread across four graph entries and a Redis round trip.
 *
 * Two boundaries are stubbed and nothing else: the Claude call (its prompt is
 * item 3.5f-i's gate) and the Gemini call (its wire format is item 3.5d's).
 * sharp encodes for real, the files land on disk for real, and the manifest is
 * read back out of Postgres.
 *
 * It runs on its own `Mastra` instance with its own Redis key prefix rather
 * than on the one `index.ts` exports. Vitest runs files in parallel, and two
 * processes subscribing to the same evented topics would share the work
 * between them: a step belonging to this file's run could execute in the
 * thread running `scaffold-check.test.ts`, where these stubs do not exist and
 * the real providers would be called.
 *
 * Requires `docker compose up -d db redis`.
 */
import { mkdtemp, readdir, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import path from "node:path"

import { Mastra } from "@mastra/core"
import { PostgresStore } from "@mastra/pg"
import { RedisStreamsPubSub } from "@mastra/redis-streams"
import { inArray } from "drizzle-orm"
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest"

import { closeDb, getDb, getPool, posts } from "../../db"
import corpus from "../images/data/image-generation-parity.json"
import { imagesAgent } from "../agents/images"
import { IMAGE_CONCURRENCY, imagesWorkflow } from "./images"

vi.mock("../api-keys", () => ({
  PROVIDERS: ["anthropic", "perplexity", "gemini"],
  API_KEYS_SETTING_KEY: "api_keys",
  getApiKeys: async () => ({ anthropic: "stub", perplexity: "stub", gemini: "stub" }),
  requireApiKey: async () => "test-key-not-a-real-credential",
}))

vi.mock("../images/gemini", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../images/gemini")>()),
  generateImage: vi.fn(),
}))

const { generateImage } = await import("../images/gemini")
const generateImageMock = vi.mocked(generateImage)

const PNG = Buffer.from(corpus.png_base64, "base64")

/** Five entries, so the fan-out has to queue behind a concurrency of three. */
const MANIFEST = {
  version: "1.0",
  style_brief: { palette: "warm" },
  images: [0, 1, 2, 3, 4].map((n) => ({
    id: `image-${n}`,
    filename: `shot-${n}.png`,
    prompt: `prompt ${n}`,
  })),
}

const POST_ID = "00000000-0000-4000-8000-0000000000f3"
/** A second post, for the run whose manifest never parses. */
const UNPARSEABLE_POST_ID = "00000000-0000-4000-8000-0000000000f4"
/** A third, for the run whose provider fails one entry with a misleading message. */
const MISLEADING_POST_ID = "00000000-0000-4000-8000-0000000000f5"

const db = getDb()
let mediaRootDir: string
let inFlightPeak = 0
let promptsSent: string[]
let agentGenerate: ReturnType<typeof vi.spyOn>
/** The parse-failure branch logs a warning; capture it instead of printing it. */
let warnings: { message: string; meta: unknown }[]
/** Python's `logger.error` beside the `image_failed` publish, likewise captured. */
let loggedErrors: string[]

/** The workflow's own Mastra instance: separate topics, same database. */
const pubsub = new RedisStreamsPubSub({
  url: process.env.REDIS_URL!,
  keyPrefix: "mastra:test:images",
})
const storage = new PostgresStore({ id: "images-workflow-test", pool: getPool() })
const testMastra = new Mastra({
  storage,
  pubsub,
  workflows: { images: imagesWorkflow },
  agents: { images: imagesAgent },
})

type WorkflowResult = Awaited<
  ReturnType<Awaited<ReturnType<typeof imagesWorkflow.createRun>>["start"]>
>

let result: WorkflowResult

beforeAll(async () => {
  mediaRootDir = await mkdtemp(path.join(tmpdir(), "images-workflow-"))
  process.env.MEDIA_DIR = mediaRootDir

  warnings = []
  vi.spyOn(testMastra.getLogger(), "warn").mockImplementation(((
    message: string,
    meta: unknown,
  ) => {
    warnings.push({ message, meta })
  }) as never)

  loggedErrors = []
  vi.spyOn(testMastra.getLogger(), "error").mockImplementation(((message: string) => {
    loggedErrors.push(message)
  }) as never)

  promptsSent = []
  agentGenerate = vi.spyOn(imagesAgent, "generate").mockImplementation((async (prompt: string) => {
    promptsSent.push(prompt)
    return {
      text: JSON.stringify(MANIFEST),
      response: { modelId: "claude-opus-4-6" },
      usage: { inputTokens: 1234, outputTokens: 567 },
    }
  }) as never)

  let inFlight = 0
  generateImageMock.mockImplementation(async () => {
    inFlight += 1
    inFlightPeak = Math.max(inFlightPeak, inFlight)
    // Long enough that a fan-out running wider than its limit would show it.
    await new Promise((resolve) => setTimeout(resolve, 40))
    inFlight -= 1
    return {
      imageBytes: PNG,
      model: "gemini-3.1-flash-image-preview",
      tokensIn: 7,
      tokensOut: 11,
    }
  })

  const stageStatus = {
    research: "complete",
    outline: "complete",
    write: "complete",
    edit: "complete",
  } as const
  // Explicit, because the `stage_settings` column's database default predates
  // the gate removal and still reads five stages as `"review"`, while
  // SQLAlchemy sent all-auto on every insert. A row that inherits the column
  // default parks at the first review gate; a post created by the app does not.
  const stageSettings = {
    research: "auto",
    outline: "auto",
    write: "auto",
    edit: "auto",
    images: "auto",
    ready: "auto",
  } as const
  await db
    .delete(posts)
    .where(inArray(posts.id, [POST_ID, UNPARSEABLE_POST_ID, MISLEADING_POST_ID]))
  await db.insert(posts).values({
    id: POST_ID,
    slug: "images-workflow-run",
    topic: "images workflow run",
    currentStage: "edit",
    stageStatus,
    stageSettings,
  })
  await db.insert(posts).values({
    id: UNPARSEABLE_POST_ID,
    slug: "images-workflow-unparseable",
    topic: "images workflow unparseable",
    currentStage: "edit",
    stageStatus,
    stageSettings,
  })
  await db.insert(posts).values({
    id: MISLEADING_POST_ID,
    slug: "images-workflow-misleading-error",
    topic: "images workflow misleading error",
    currentStage: "edit",
    stageStatus,
    stageSettings,
  })

  await storage.init()
  await testMastra.startWorkers()

  const run = await imagesWorkflow.createRun()
  result = await run.start({ inputData: { postId: POST_ID } })
}, 120_000)

afterAll(async () => {
  await testMastra.stopWorkers()
  await pubsub.close()
  await db
    .delete(posts)
    .where(inArray(posts.id, [POST_ID, UNPARSEABLE_POST_ID, MISLEADING_POST_ID]))
  await closeDb()
  await rm(mediaRootDir, { recursive: true, force: true })
  delete process.env.MEDIA_DIR
  vi.restoreAllMocks()
})

describe("the images workflow, executed by the evented engine", () => {
  it("runs the three steps to a success", () => {
    expect(result.status).toBe("success")
    expect(promptsSent).toHaveLength(1)
  })

  it("calls Gemini once per manifest entry", () => {
    expect(generateImageMock).toHaveBeenCalledTimes(MANIFEST.images.length)
    expect(generateImageMock.mock.calls.map(([call]) => call.prompt).sort()).toEqual(
      MANIFEST.images.map((image) => image.prompt),
    )
  })

  it("holds the fan-out to Python's semaphore width", () => {
    expect(inFlightPeak).toBeGreaterThan(1)
    expect(inFlightPeak).toBeLessThanOrEqual(IMAGE_CONCURRENCY)
  })

  it("hands the entries back in manifest order, not completion order", async () => {
    const [row] = await db.select().from(posts).where(inArray(posts.id, [POST_ID]))
    const stored = row.imageManifest as { images: Record<string, unknown>[] }

    expect(stored.images.map((image) => image.index)).toEqual([0, 1, 2, 3, 4])
    expect(stored.images.map((image) => image.id)).toEqual(
      MANIFEST.images.map((image) => image.id),
    )
    expect(stored.images.map((image) => image.url)).toEqual(
      MANIFEST.images.map((_, index) => `/media/${POST_ID}/shot-${index}.webp`),
    )
  })

  it("commits the folded manifest and the stage status", async () => {
    const [row] = await db.select().from(posts).where(inArray(posts.id, [POST_ID]))
    const stored = row.imageManifest as Record<string, unknown>

    expect(stored.version).toBe(MANIFEST.version)
    expect(stored.style_brief).toEqual(MANIFEST.style_brief)
    expect(stored.total_generated).toBe(5)
    expect(stored.total_failed).toBe(0)
    expect(row.currentStage).toBe("images")
    expect((row.stageStatus as Record<string, string>).images).toBe("complete")
  })

  it("writes one file per entry into the media directory", async () => {
    const files = await readdir(path.join(mediaRootDir, POST_ID))

    expect(files.sort()).toEqual(MANIFEST.images.map((_, index) => `shot-${index}.webp`))
  })

  /**
   * Item 5.5c-iv-d-2, on a real run: the fan-out's own per-image line, written
   * by the process that generated the image rather than by the step that folds
   * the manifest back together.
   */
  it("publishes one `image_generated` per entry, on the row, in manifest order", async () => {
    const [row] = await db.select().from(posts).where(inArray(posts.id, [POST_ID]))
    const stored = row.imageManifest as { images: Record<string, unknown>[] }
    const entries = ((row.executionLogs ?? []) as Record<string, unknown>[]).filter(
      (entry) => entry.event === "image_generated" || entry.event === "image_failed",
    )

    // `.foreach()` runs three at a time, so the entries are appended in
    // completion order rather than manifest order; sorted by the index each
    // one carries, they have to cover the manifest exactly once.
    const byIndex = [...entries].sort(
      (a, b) =>
        Number((a.data as { index: number }).index) - Number((b.data as { index: number }).index),
    )
    expect(byIndex).toEqual(
      stored.images.map((image) => ({
        ts: expect.any(String),
        stage: "images",
        level: "info",
        event: "image_generated",
        message: `Image ${image.index} generated (${image.size_bytes} bytes)`,
        data: { index: image.index, bytes: image.size_bytes, path: image.url },
      })),
    )
  })

  it("returns both meta records, with Gemini's usage summed over the fan-out", () => {
    expect(result.status).toBe("success")
    const output = result.status === "success" ? result.result : undefined

    expect(output?.stage).toBe("images")
    expect(output?.model).toBe("claude-opus-4-6")
    expect(output?.tokensIn).toBe(1234)
    expect(output?.tokensOut).toBe(567)
    expect(output?.totalGenerated).toBe(5)
    expect(output?.gemini?.tokensIn).toBe(5 * 7)
    expect(output?.gemini?.tokensOut).toBe(5 * 11)
    expect(output?.durationS).toBeGreaterThan(0)
  })

  /**
   * The branch that decides whether the stage bills anything at all. It lives
   * in the `.map()`, which the fixture-driven tests cannot reach, so it gets
   * its own run rather than an assertion on a function call.
   */
  it("fans nothing out and bills nothing when the manifest never parses", async () => {
    const callsBefore = generateImageMock.mock.calls.length
    agentGenerate.mockImplementationOnce((async () => ({
      text: "I am not able to produce an image manifest for this article.",
      response: { modelId: "claude-opus-4-6" },
      usage: { inputTokens: 12, outputTokens: 3 },
    })) as never)

    const run = await imagesWorkflow.createRun()
    const failed = await run.start({ inputData: { postId: UNPARSEABLE_POST_ID } })

    expect(failed.status).toBe("success")
    const output = failed.status === "success" ? failed.result : undefined
    expect(output?.parseFailed).toBe(true)
    expect(output?.gemini).toBeNull()
    expect(output?.durationS).toBe(0)
    expect(generateImageMock.mock.calls).toHaveLength(callsBefore)
    // Python returns before it constructs the Gemini client and before it
    // creates the media directory, so a failed manifest leaves no trace on
    // disk. `images` is already empty by the time the mapping runs, so this
    // directory is the only thing that distinguishes the short-circuit from
    // simply mapping over nothing.
    expect(await readdir(mediaRootDir)).toEqual([POST_ID])

    const [row] = await db.select().from(posts).where(inArray(posts.id, [UNPARSEABLE_POST_ID]))
    expect(row.imageManifest).toEqual({
      images: [],
      style_brief: {},
      error: "Failed to parse manifest",
    })
    expect((row.stageStatus as Record<string, string>).images).toBe("failed")
    // Item 5.5c-iv-d-1 moved the parse failure off the logger and onto the
    // event bus, which is where Python published it. The row's own trail is
    // asserted rather than the topic because the entry is written by the
    // process that publishes, so it cannot race the assertion.
    expect(warnings).toEqual([])
    const line = (message: string, extra: Record<string, unknown> = {}) => ({
      ts: expect.any(String),
      stage: "images",
      level: "info",
      event: "log",
      message,
      ...extra,
    })
    const entries = (row.executionLogs ?? []) as Record<string, unknown>[]
    expect(entries.filter((entry) => entry.event === "log")).toEqual([
      line("Rules loaded, building prompt..."),
      line("Calling Claude for image manifest..."),
      // The stub reports 3 output tokens, and Python published what the
      // manifest cost before it discovered the manifest was unusable.
      line("Manifest received (3 tokens)"),
      line("Manifest parse failed: Failed to parse manifest", {
        level: "warning",
        data: {
          error: "Failed to parse manifest",
          raw_snippet: "I am not able to produce an image manifest for this article.",
        },
      }),
    ])
    // The "Generating N images" line is on the far side of the short-circuit,
    // so a failed parse never claims images are being generated.
  }, 60_000)

  /**
   * The inference item 5.5c-iv-d-2's discriminant exists to prevent, run
   * against the real engine rather than argued about.
   *
   * One entry's provider call fails with a message that reads exactly like the
   * no-prompt short circuit, so the stored entry is indistinguishable from an
   * entry the model never gave a prompt for: same `generated: false`, same
   * `error`, same absent `usage`. Python published `image_failed` for it and
   * nothing for the short circuit, so a step that picked its line by reading
   * the entry back would go silent here.
   */
  it("publishes `image_failed` for a provider error that reads like the short circuit", async () => {
    generateImageMock.mockImplementation(async ({ prompt }: { prompt: string }) => {
      if (prompt === "prompt 2") throw new Error("no prompt")
      return { imageBytes: PNG, model: "gemini-3.1-flash-image-preview", tokensIn: 7, tokensOut: 11 }
    })

    const run = await imagesWorkflow.createRun()
    const misleading = await run.start({ inputData: { postId: MISLEADING_POST_ID } })
    expect(misleading.status).toBe("success")

    const [row] = await db.select().from(posts).where(inArray(posts.id, [MISLEADING_POST_ID]))
    const stored = row.imageManifest as { images: Record<string, unknown>[] }
    expect(stored.images[2]).toMatchObject({ generated: false, error: "no prompt", index: 2 })

    const entries = ((row.executionLogs ?? []) as Record<string, unknown>[]).filter(
      (entry) => entry.event === "image_generated" || entry.event === "image_failed",
    )
    expect(entries.filter((entry) => entry.event === "image_generated")).toHaveLength(4)
    expect(entries.filter((entry) => entry.event === "image_failed")).toEqual([
      {
        ts: expect.any(String),
        stage: "images",
        level: "error",
        event: "image_failed",
        message: "Image 2 failed: no prompt",
        data: { index: 2, error: "no prompt" },
      },
    ])
    expect(loggedErrors).toEqual(["Failed to generate image 2: no prompt"])
  }, 60_000)
})
