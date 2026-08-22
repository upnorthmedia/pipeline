// @vitest-environment node
/**
 * Stage selection (item 4.2a): which of the six steps a run actually executes.
 *
 * Python decided this in `_run_pipeline()`: a call with `stages=[x]` ran exactly
 * `x`, and a call without ran every stage `stage_status` did not already call
 * complete. The chain here is fixed, so the same two rules are decided per step
 * from the run's input instead, and this file is the proof that the two
 * behaviours survived the move.
 *
 * Two real runs, on two posts:
 *
 * 1. **Resume.** A post whose first four stages are already complete, started
 *    with no selection. Only `images` and `ready` may call a provider, and the
 *    four completed columns must come back untouched.
 * 2. **Single stage.** A post whose six stages are *all* complete, started with
 *    `stages: ["outline"]`. Only `outline` may run, and it must run despite
 *    being complete, which is the dashboard's rerun button.
 *
 * Every provider boundary is stubbed and nothing else. The database, Redis and
 * the evented engine are real. Own `Mastra` instance and own Redis key prefix,
 * for the reason `pipeline.test.ts` records: vitest runs files in parallel and
 * two processes on the same evented topics would share the work between them.
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
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest"

import { closeDb, getDb, getPool, posts } from "../../db"
import { editAgent } from "../agents/edit"
import { imagesAgent } from "../agents/images"
import { outlineAgent } from "../agents/outline"
import { readyAgent } from "../agents/ready"
import { researchAgent } from "../agents/research"
import { writeAgent } from "../agents/write"
import corpus from "../images/data/image-generation-parity.json"
import { STAGES, STATUS_COMPLETE } from "../state"
import { imagesWorkflow } from "./images"
import { pipelineWorkflow } from "./pipeline"

/**
 * `requireApiKey` is a spy rather than a stub function because the count is an
 * assertion below: the images fan-out demands the Gemini credential, and a
 * stage the run is only passing through must not.
 */
const requireApiKeyMock = vi.hoisted(() =>
  vi.fn(async () => "test-key-not-a-real-credential"),
)

vi.mock("../api-keys", () => ({
  PROVIDERS: ["anthropic", "perplexity", "gemini"],
  API_KEYS_SETTING_KEY: "api_keys",
  getApiKeys: async () => ({ anthropic: "stub", perplexity: "stub", gemini: "stub" }),
  requireApiKey: requireApiKeyMock,
}))

vi.mock("../images/gemini", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../images/gemini")>()),
  generateImage: vi.fn(),
}))

const { generateImage } = await import("../images/gemini")
const generateImageMock = vi.mocked(generateImage)

const PNG = Buffer.from(corpus.png_base64, "base64")

const MANIFEST = {
  version: "1.0",
  images: [{ id: "inline", filename: "inline.png", prompt: "an inline diagram" }],
}

/** Stage -> the text its stubbed agent returns, so each column is identifiable. */
const AGENT_TEXT = {
  research: "## Keyword analysis\n\n## Pain point\n\n## Competitor\n\n## Search intent",
  outline: "# Outline, rerun\n\n1. Opening\n2. Close",
  write: "# Draft\n\nThe draft body.",
  edit: "# Edited\n\nThe edited body.",
  images: JSON.stringify(MANIFEST),
  ready: "---\ntitle: Ready\n---\n\nThe publishable article.",
} as const

/** What the two posts are seeded with, so an untouched column is recognisable. */
const SEEDED = {
  research: "seeded research",
  outline: "seeded outline",
  write: "seeded draft",
  edit: "seeded final markdown",
  ready: "seeded ready",
} as const

const RESUME_POST_ID = "00000000-0000-4000-8000-0000000004a1"
const SINGLE_POST_ID = "00000000-0000-4000-8000-0000000004a2"

const db = getDb()
let mediaRootDir: string
/** Stage ids in the order their agent was called, reset before each run. */
let callOrder: string[]

const pubsub = new RedisStreamsPubSub({
  url: process.env.REDIS_URL!,
  keyPrefix: "mastra:test:stage-selection",
})
const storage = new PostgresStore({ id: "stage-selection-test", pool: getPool() })
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

type PipelineResult = Awaited<
  ReturnType<Awaited<ReturnType<typeof pipelineWorkflow.createRun>>["start"]>
>

/** The two runs' results and the agents each of them called. */
let resume: { result: PipelineResult; called: string[] }
let single: { result: PipelineResult; called: string[] }

function seedValues(postId: string, complete: readonly string[]) {
  return {
    id: postId,
    slug: `stage-selection-${postId.slice(-3)}`,
    topic: "composable pipelines",
    currentStage: "pending",
    stageStatus: Object.fromEntries(complete.map((stage) => [stage, STATUS_COMPLETE])),
    researchContent: SEEDED.research,
    outlineContent: SEEDED.outline,
    draftContent: SEEDED.write,
    finalMdContent: SEEDED.edit,
    readyContent: SEEDED.ready,
    imageManifest: { seeded: true },
  }
}

async function readPost(postId: string) {
  const [row] = await db.select().from(posts).where(eq(posts.id, postId))
  return row
}

beforeAll(async () => {
  mediaRootDir = await mkdtemp(path.join(tmpdir(), "stage-selection-"))
  process.env.MEDIA_DIR = mediaRootDir

  callOrder = []
  for (const [stage, agent] of Object.entries(agents)) {
    vi.spyOn(agent, "generate").mockImplementation((async () => {
      callOrder.push(stage)
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

  for (const postId of [RESUME_POST_ID, SINGLE_POST_ID]) {
    await db.delete(posts).where(eq(posts.id, postId))
  }
  await db.insert(posts).values(seedValues(RESUME_POST_ID, ["research", "outline", "write", "edit"]))
  await db.insert(posts).values(seedValues(SINGLE_POST_ID, STAGES))

  await storage.init()
  await testMastra.startWorkers()

  callOrder = []
  const resumeRun = await pipelineWorkflow.createRun()
  resume = {
    result: await resumeRun.start({ inputData: { postId: RESUME_POST_ID } }),
    called: [],
  }
  resume.called = callOrder
  // The resume run resolved the Gemini key for its own `images` stage; the
  // single-stage run below must resolve nothing, which is what this clears for.
  requireApiKeyMock.mockClear()

  callOrder = []
  const singleRun = await pipelineWorkflow.createRun()
  single = {
    result: await singleRun.start({
      inputData: { postId: SINGLE_POST_ID, stages: ["outline"] },
    }),
    called: [],
  }
  single.called = callOrder
}, 180_000)

afterAll(async () => {
  await testMastra.stopWorkers()
  await pubsub.close()
  for (const postId of [RESUME_POST_ID, SINGLE_POST_ID]) {
    await db.delete(posts).where(eq(posts.id, postId))
  }
  await closeDb()
  await rm(mediaRootDir, { recursive: true, force: true })
  delete process.env.MEDIA_DIR
  vi.restoreAllMocks()
})

describe("a full run over a partly complete post", () => {
  it("succeeds", () => {
    expect(resume.result.status).toBe("success")
  })

  it("calls a provider only for the stages that were not already complete", () => {
    expect(resume.called).toEqual(["images", "ready"])
  })

  it("leaves the completed stages' columns exactly as it found them", async () => {
    const row = await readPost(RESUME_POST_ID)

    expect(row.researchContent).toBe(SEEDED.research)
    expect(row.outlineContent).toBe(SEEDED.outline)
    expect(row.draftContent).toBe(SEEDED.write)
    expect(row.finalMdContent).toBe(SEEDED.edit)
  })

  it("runs the stages that were not complete", async () => {
    const row = await readPost(RESUME_POST_ID)

    expect(generateImageMock).toHaveBeenCalledTimes(MANIFEST.images.length)
    expect((row.imageManifest as Record<string, unknown>).total_generated).toBe(1)
    expect(row.readyContent).toBe(AGENT_TEXT.ready)
    expect(row.stageStatus).toEqual(Object.fromEntries(STAGES.map((s) => [s, STATUS_COMPLETE])))
  })

  it("reports the skip on each skipped step rather than a zeroed measurement", () => {
    const steps = resume.result.steps as Record<
      string,
      { status: string; output?: { skipped?: boolean; model?: string } }
    >

    for (const stage of ["research", "outline", "write", "edit"]) {
      expect(steps[stage]?.output?.skipped, stage).toBe(true)
      expect(steps[stage]?.output?.model, stage).toBe("")
    }
    expect(steps.images?.output?.skipped).toBe(false)
    expect(steps.ready?.output?.skipped).toBe(false)
  })
})

describe("a run that names a single stage", () => {
  it("succeeds", () => {
    expect(single.result.status).toBe("success")
  })

  /**
   * The point of the case: `outline` is already complete, and Python's
   * single-stage path deliberately does not consult `stage_status`, so a
   * completed stage reruns on request.
   */
  it("runs only the named stage, even though it is already complete", () => {
    expect(single.called).toEqual(["outline"])
  })

  it("writes the named stage's column and no other", async () => {
    const row = await readPost(SINGLE_POST_ID)

    expect(row.outlineContent).toBe(AGENT_TEXT.outline)
    expect(row.researchContent).toBe(SEEDED.research)
    expect(row.draftContent).toBe(SEEDED.write)
    expect(row.finalMdContent).toBe(SEEDED.edit)
    expect(row.readyContent).toBe(SEEDED.ready)
    expect(row.imageManifest).toEqual({ seeded: true })
  })

  /**
   * The nested `images` workflow has three steps and a fan-out, so its skip is
   * the one that could leak work: a manifest call, a media directory, or a
   * Gemini call made on a run that was never asked to touch the stage.
   */
  it("short-circuits the whole nested images workflow", () => {
    const steps = single.result.steps as Record<
      string,
      { status: string; output?: { skipped?: boolean; totalGenerated?: number } }
    >

    expect(steps.images?.output?.skipped).toBe(true)
    expect(steps.images?.output?.totalGenerated).toBe(0)
    // Once, for the `images` stage of the resume run above, and not again.
    expect(generateImageMock).toHaveBeenCalledTimes(MANIFEST.images.length)
  })

  /**
   * The fan-out resolves the Gemini key before it dispatches a single image, so
   * a run passing through `images` without a Gemini key configured would fail
   * on a stage it was never asked to touch.
   */
  it("does not demand the Gemini credential for a stage it passes through", () => {
    expect(requireApiKeyMock).not.toHaveBeenCalled()
  })

  it("carries the selection to the end of the chain", () => {
    const output = single.result.status === "success" ? single.result.result : undefined

    expect(output?.stages).toEqual(["outline"])
    expect(output?.stage).toBe("ready")
    expect(output?.skipped).toBe(true)
  })
})
