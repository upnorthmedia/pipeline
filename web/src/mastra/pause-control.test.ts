// @vitest-environment node
/**
 * Ledger item P2.115: pausing a run has to stop it.
 *
 * `POST /api/posts/{id}/pause` writes `current_stage = "paused"` and nothing
 * else, and until this item nothing in the worker read that value. The stage
 * in flight finished, the next one started, and the six-stage pipeline ran to
 * `complete` while the dashboard's badge said `Paused`. Every stage after the
 * pause was billed to a provider the operator had just asked to stop.
 *
 * So the question here is not whether the row changes, `pause/route.test.ts`
 * already pins that. It is whether a run in flight notices. Every run in this
 * file is real: real Postgres, real Redis, the real evented engine, the real
 * six-step pipeline. Only the provider boundaries are stubbed, so a stage that
 * should not have run announces itself as an extra call on a stub rather than
 * as a bill.
 *
 * The pause is applied from *inside* a stub, which is what makes it a real
 * mid-run pause rather than a seeded row: the row moves to `"paused"` while
 * the stage before the one under test is still executing, exactly as it does
 * when a person presses the button.
 *
 * Own `Mastra` instance and own Redis key prefix, for the reason
 * `pipeline.test.ts` records: a worker running beside the suite must not
 * consume these runs.
 *
 * Requires `docker compose up -d db redis`.
 */
import { mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import path from "node:path"

import { Mastra } from "@mastra/core"
import { PostgresStore } from "@mastra/pg"
import { RedisStreamsPubSub } from "@mastra/redis-streams"
import { eq } from "drizzle-orm"
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest"

import { closeDb, getDb, getPool, posts } from "../db"
import { editAgent } from "./agents/edit"
import { imagesAgent } from "./agents/images"
import { outlineAgent } from "./agents/outline"
import { readyAgent } from "./agents/ready"
import { researchAgent } from "./agents/research"
import { writeAgent } from "./agents/write"
import corpus from "./images/data/image-generation-parity.json"
import { CURRENT_STAGE_PAUSED, STAGES, STATUS_COMPLETE } from "./state"
import type { Stage } from "./state"
import { imagesWorkflow } from "./workflows/images"
import { pipelineWorkflow } from "./workflows/pipeline"

vi.mock("./api-keys", () => ({
  PROVIDERS: ["anthropic", "perplexity", "gemini"],
  API_KEYS_SETTING_KEY: "api_keys",
  getApiKeys: async () => ({ anthropic: "stub", perplexity: "stub", gemini: "stub" }),
  requireApiKey: async () => "test-key-not-a-real-credential",
}))

vi.mock("./images/gemini", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./images/gemini")>()),
  generateImage: vi.fn(),
}))

const { generateImage } = await import("./images/gemini")
const generateImageMock = vi.mocked(generateImage)

const PNG = Buffer.from(corpus.png_base64, "base64")

const MANIFEST = {
  version: "1.0",
  images: [{ id: "inline", filename: "inline.png", prompt: "an inline diagram" }],
}

const AGENT_TEXT = {
  research: "## Keyword analysis\n\n## Pain point\n\n## Competitor\n\n## Search intent",
  outline: "# Outline\n\n1. Opening\n2. Close",
  write: "# Draft\n\nThe draft body.",
  edit: "# Edited\n\nThe edited body.",
  images: JSON.stringify(MANIFEST),
  ready: "---\ntitle: Ready\n---\n\nThe publishable article.",
} as const

/** Paused while `research` is still calling its provider. */
const EARLY_POST_ID = "00000000-0000-4000-8000-000000000631"
/** Paused while `edit` is running, so the pause lands in front of `images`. */
const BEFORE_IMAGES_POST_ID = "00000000-0000-4000-8000-000000000632"
/** Paused, then started again the way `resume-all` starts one. */
const RESUMED_POST_ID = "00000000-0000-4000-8000-000000000633"

const db = getDb()
let mediaRootDir: string

const pubsub = new RedisStreamsPubSub({
  url: process.env.REDIS_URL!,
  keyPrefix: "mastra:test:pause-control",
})
const storage = new PostgresStore({ id: "pause-control-test", pool: getPool() })
const agents = {
  research: researchAgent,
  outline: outlineAgent,
  write: writeAgent,
  edit: editAgent,
  images: imagesAgent,
  ready: readyAgent,
} as const
const testMastra = new Mastra({
  storage,
  pubsub,
  workflows: { pipeline: pipelineWorkflow, images: imagesWorkflow },
  agents,
})

const POST_IDS = [EARLY_POST_ID, BEFORE_IMAGES_POST_ID, RESUMED_POST_ID]

/**
 * The pause the next stub call applies, or null for a run nobody pauses.
 *
 * A stage stub knows which stage it is but not which post is running, and the
 * agents are module singletons shared by every run. The runs here are started
 * one at a time and awaited, so a single slot is enough and is honest: it is
 * the operator, who is also one at a time.
 */
let pauseDuring: { stage: Stage; postId: string } | null = null

async function maybePause(stage: Stage): Promise<void> {
  if (!pauseDuring || pauseDuring.stage !== stage) return
  const { postId } = pauseDuring
  pauseDuring = null
  // The write `POST /api/posts/{id}/pause` makes, and only that write: the
  // stage map is deliberately left as the running stage set it.
  await db
    .update(posts)
    .set({ currentStage: CURRENT_STAGE_PAUSED, updatedAt: new Date() })
    .where(eq(posts.id, postId))
}

function seedValues(postId: string) {
  return {
    id: postId,
    slug: `pause-control-${postId.slice(-3)}`,
    topic: "composable pipelines",
    currentStage: "pending",
    // Every gate open: this file is about the control signal, not the gates.
    stageSettings: Object.fromEntries(STAGES.map((stage) => [stage, "auto"])),
    stageStatus: {},
  }
}

async function deleteRunsFor(postIds: string[]) {
  await getPool().query(
    'delete from mastra_workflow_snapshot where "resourceId" = any($1::text[])',
    [postIds],
  )
}

async function readPost(postId: string) {
  const [row] = await db.select().from(posts).where(eq(posts.id, postId))
  return row
}

/** Wait for a run to stop being in flight, whatever it stopped as. */
async function settledRun(runId: string) {
  for (let attempt = 0; attempt < 900; attempt += 1) {
    const state = await pipelineWorkflow.getWorkflowRunById(runId)
    if (state && state.status !== "suspended" && state.status !== "running") return state
    await new Promise((resolve) => setTimeout(resolve, 100))
  }
  throw new Error(`run ${runId} never settled`)
}

/** Start a run the way `startPipeline()` does, and wait for it to settle. */
async function runToSettled(postId: string, stages?: Stage[]) {
  const run = await pipelineWorkflow.createRun({ resourceId: postId })
  await run.startAsync({ inputData: { postId, stages } })
  return await settledRun(run.runId)
}

/** How many times each stage called its provider, for a before/after diff. */
function providerCalls(): Record<string, number> {
  return {
    ...Object.fromEntries(
      Object.entries(agents).map(([stage, agent]) => [
        stage,
        vi.mocked(agent.generate).mock.calls.length,
      ]),
    ),
    gemini: generateImageMock.mock.calls.length,
  }
}

beforeAll(async () => {
  mediaRootDir = await mkdtemp(path.join(tmpdir(), "pause-control-"))
  process.env.MEDIA_DIR = mediaRootDir

  // `edit`'s readability and SEO checks all fail on the stubbed three-line
  // draft. Captured rather than printed, so a real warning from a later change
  // is not buried in this file's stderr.
  vi.spyOn(testMastra.getLogger(), "warn").mockImplementation((() => {}) as never)

  for (const [stage, agent] of Object.entries(agents)) {
    vi.spyOn(agent, "generate").mockImplementation((async () => {
      await maybePause(stage as Stage)
      return {
        text: AGENT_TEXT[stage as keyof typeof AGENT_TEXT],
        response: { modelId: `stub-${stage}` },
        usage: { inputTokens: 100, outputTokens: 20 },
      }
    }) as never)
  }
  generateImageMock.mockResolvedValue({
    imageBytes: PNG,
    model: "gemini-3.1-flash-image-preview",
    tokensIn: 7,
    tokensOut: 11,
  })

  for (const postId of POST_IDS) await db.delete(posts).where(eq(posts.id, postId))
  await deleteRunsFor(POST_IDS)
  for (const postId of POST_IDS) await db.insert(posts).values(seedValues(postId))

  await storage.init()
  await testMastra.startWorkers()
}, 180_000)

afterAll(async () => {
  await testMastra.stopWorkers()
  await pubsub.close()
  for (const postId of POST_IDS) await db.delete(posts).where(eq(posts.id, postId))
  await deleteRunsFor(POST_IDS)
  await closeDb()
  await rm(mediaRootDir, { recursive: true, force: true })
  delete process.env.MEDIA_DIR
  vi.restoreAllMocks()
})

beforeEach(() => {
  pauseDuring = null
})

describe("a run paused while it is executing", () => {
  it("stops at the next stage boundary instead of running the other five", async () => {
    pauseDuring = { stage: "research", postId: EARLY_POST_ID }
    const before = providerCalls()

    const settled = await runToSettled(EARLY_POST_ID)
    const row = await readPost(EARLY_POST_ID)
    const after = providerCalls()

    // The stage that was in flight when the pause landed finishes and commits.
    expect(row.stageStatus?.research).toBe(STATUS_COMPLETE)
    expect(after.research - before.research).toBe(1)
    // Nothing after it runs. This is the whole item: before the fix every one
    // of these differences is 1, and `gemini` is 1 as well.
    for (const stage of ["outline", "write", "edit", "images", "ready"]) {
      expect(after[stage] - before[stage]).toBe(0)
    }
    expect(after.gemini - before.gemini).toBe(0)
    // The row still says what the operator asked for, and the completion hook
    // never ran over it.
    expect(row.currentStage).toBe(CURRENT_STAGE_PAUSED)
    expect(row.completedAt).toBeNull()
    // The run itself ended cleanly. A pause is not a failure: nothing here is
    // retried, and nothing is left parked in storage for a reaper to find.
    expect(settled.status).toBe("success")
  }, 240_000)

  it("bills no image when the pause lands in front of the images stage", async () => {
    pauseDuring = { stage: "edit", postId: BEFORE_IMAGES_POST_ID }
    const before = providerCalls()

    await runToSettled(BEFORE_IMAGES_POST_ID)
    const row = await readPost(BEFORE_IMAGES_POST_ID)
    const after = providerCalls()

    expect(row.stageStatus?.edit).toBe(STATUS_COMPLETE)
    // `images` is the one stage that is a nested workflow and the one stage
    // that bills two providers, so it gets its own case.
    expect(after.images - before.images).toBe(0)
    expect(after.gemini - before.gemini).toBe(0)
    expect(after.ready - before.ready).toBe(0)
    expect(row.imageManifest).toBeNull()
    expect(row.readyContent).toBeNull()
    expect(row.currentStage).toBe(CURRENT_STAGE_PAUSED)
  }, 240_000)

  it("says in the run's own log where it stopped", async () => {
    const logs = (await readPost(EARLY_POST_ID)).executionLogs ?? []
    const paused = logs.filter((entry) => /paused/i.test(String(entry.message ?? "")))

    expect(paused).toHaveLength(1)
    expect(paused[0]).toMatchObject({ stage: "outline", level: "warning" })
  }, 30_000)
})

describe("a run started again after a pause", () => {
  it("runs every stage, so the pause is a stop and not a poison pill", async () => {
    pauseDuring = { stage: "research", postId: RESUMED_POST_ID }
    await runToSettled(RESUMED_POST_ID)
    expect((await readPost(RESUMED_POST_ID)).currentStage).toBe(CURRENT_STAGE_PAUSED)

    // What `POST /api/queue/resume-all` does: move the row off `"paused"` to
    // the first stage `stage_status` does not call complete, then start a run.
    // Every start endpoint writes `current_stage` before it starts anything,
    // which is what clears the pause.
    await db
      .update(posts)
      .set({ currentStage: "outline", updatedAt: new Date() })
      .where(eq(posts.id, RESUMED_POST_ID))
    const before = providerCalls()

    const settled = await runToSettled(RESUMED_POST_ID)
    const row = await readPost(RESUMED_POST_ID)
    const after = providerCalls()

    expect(settled.status).toBe("success")
    for (const stage of STAGES) expect(row.stageStatus?.[stage]).toBe(STATUS_COMPLETE)
    expect(row.currentStage).toBe(STATUS_COMPLETE)
    // `research` committed before the pause, so the resumed run skips it: a
    // resumed run must not re-bill what the paused one already paid for.
    expect(after.research - before.research).toBe(0)
    expect(after.ready - before.ready).toBe(1)
  }, 300_000)
})
