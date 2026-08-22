// @vitest-environment node
/**
 * Review gates (item 4.3): the human checkpoint in front of a stage.
 *
 * Python's `_run_pipeline()` read `post.stage_settings[stage]` before executing
 * a stage on a full-pipeline run and, for the modes `review` and
 * `approve_only`, wrote `stage_status[stage] = "review"`, set `current_stage`
 * to that stage and returned: the run simply stopped and something else had to
 * re-enqueue it. A single-stage rerun passed `check_gates=False` and never
 * looked.
 *
 * Here the stop becomes a `suspend()`, which is the difference worth having:
 * the parked run keeps its place in the chain, so approving it continues into
 * the remaining stages instead of starting a second run that has to work out
 * where the first one stopped.
 *
 * Three real runs, on three posts:
 *
 * 1. **Gated at the first stage.** `research: "review"`, no selection. The run
 *    must suspend before any provider call, park the row, and then complete the
 *    whole chain when it is resumed with an approval.
 * 2. **Gated inside the nested images workflow.** `images: "approve_only"`, no
 *    selection. The gate sits behind a `.foreach()` fan-out, so this is the one
 *    that proves a nested workflow suspends and resumes by step path, and that
 *    no Gemini call is billed while the run waits.
 * 3. **A named selection.** Every stage set to `review`, started with
 *    `stages: ["outline"]`. Python's `check_gates=False`: the rerun button must
 *    not park itself waiting for the approval the operator just gave by
 *    pressing it.
 *
 * Every provider boundary is stubbed and nothing else. The database, Redis and
 * the evented engine are real. Own `Mastra` instance and own Redis key prefix,
 * for the reason `pipeline.test.ts` records.
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
import { STAGES, STATUS_COMPLETE, STATUS_REVIEW } from "../state"
import { gateModeFor, stageNeedsReview } from "../steps/stage-io"
import { imagesWorkflow } from "./images"
import { pipelineWorkflow } from "./pipeline"

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

const AGENT_TEXT = {
  research: "## Keyword analysis\n\n## Pain point\n\n## Competitor\n\n## Search intent",
  outline: "# Outline\n\n1. Opening\n2. Close",
  write: "# Draft\n\nThe draft body.",
  edit: "# Edited\n\nThe edited body.",
  images: JSON.stringify(MANIFEST),
  ready: "---\ntitle: Ready\n---\n\nThe publishable article.",
} as const

const FIRST_STAGE_POST_ID = "00000000-0000-4000-8000-0000000004c1"
const IMAGES_POST_ID = "00000000-0000-4000-8000-0000000004c2"
const SELECTION_POST_ID = "00000000-0000-4000-8000-0000000004c3"

const db = getDb()
let mediaRootDir: string
/** Stage ids in the order their agent was called, reset before each run. */
let callOrder: string[]

const pubsub = new RedisStreamsPubSub({
  url: process.env.REDIS_URL!,
  keyPrefix: "mastra:test:review-gates",
})
const storage = new PostgresStore({ id: "review-gates-test", pool: getPool() })
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

/** Each run's suspended result, the agents it had called by then, and its resumed result. */
type GatedRun = {
  suspended: PipelineResult
  calledBeforeApproval: string[]
  resumed: NonNullable<Awaited<ReturnType<typeof pipelineWorkflow.getWorkflowRunById>>>
  calledAfterApproval: string[]
  rowWhileSuspended: typeof posts.$inferSelect
}

let firstStage: GatedRun
let images: GatedRun
/**
 * Gemini calls made by the time the images run suspended, snapshotted there
 * rather than asserted later: the mock keeps counting once the run is resumed.
 */
let imageCallsWhileSuspended: number
let selection: { result: PipelineResult; called: string[] }

function seedValues(postId: string, stageSettings: Record<string, string>) {
  return {
    id: postId,
    slug: `review-gates-${postId.slice(-3)}`,
    topic: "composable pipelines",
    currentStage: "pending",
    stageSettings,
    stageStatus: {},
  }
}

/** All six stages on `auto` except the ones named. */
function settings(overrides: Record<string, string>): Record<string, string> {
  return { ...Object.fromEntries(STAGES.map((stage) => [stage, "auto"])), ...overrides }
}

async function readPost(postId: string) {
  const [row] = await db.select().from(posts).where(eq(posts.id, postId))
  return row
}

/**
 * Wait for a resumed run to actually finish.
 *
 * `EventedRun.resume()` cannot be awaited for this: it resolves off the shared
 * `workflows-finish` topic, and the Redis stream still holds this run's earlier
 * `workflow.suspend` event, so the resume returns that stale snapshot the
 * moment it subscribes while the run carries on executing behind it. The
 * persisted run state is the only honest answer, so poll that.
 */
/**
 * Wait for the suspend to reach storage.
 *
 * `start()` resolves on the run's `workflow.suspend` event, which the engine
 * publishes alongside, not after, the snapshot write, so resuming immediately
 * can lose the race and be told the run was never suspended.
 */
async function suspendedRun(runId: string) {
  for (let attempt = 0; attempt < 300; attempt += 1) {
    const state = await pipelineWorkflow.getWorkflowRunById(runId)
    if (state?.status === "suspended") return state
    await new Promise((resolve) => setTimeout(resolve, 100))
  }
  throw new Error(`run ${runId} never suspended`)
}

async function settledRun(runId: string) {
  for (let attempt = 0; attempt < 600; attempt += 1) {
    const state = await pipelineWorkflow.getWorkflowRunById(runId)
    if (state && state.status !== "suspended" && state.status !== "running") return state
    await new Promise((resolve) => setTimeout(resolve, 100))
  }
  throw new Error(`run ${runId} never left the suspended state`)
}

beforeAll(async () => {
  mediaRootDir = await mkdtemp(path.join(tmpdir(), "review-gates-"))
  process.env.MEDIA_DIR = mediaRootDir

  // `edit`'s readability and SEO checks all fail on the stubbed three-line
  // draft. Captured rather than printed, so a real warning from a later change
  // is not buried in this file's stderr.
  vi.spyOn(testMastra.getLogger(), "warn").mockImplementation((() => {}) as never)

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

  for (const postId of [FIRST_STAGE_POST_ID, IMAGES_POST_ID, SELECTION_POST_ID]) {
    await db.delete(posts).where(eq(posts.id, postId))
  }
  await db.insert(posts).values(seedValues(FIRST_STAGE_POST_ID, settings({ research: "review" })))
  await db.insert(posts).values(seedValues(IMAGES_POST_ID, settings({ images: "approve_only" })))
  await db
    .insert(posts)
    .values(seedValues(SELECTION_POST_ID, settings(Object.fromEntries(STAGES.map((s) => [s, "review"])))))

  await storage.init()
  await testMastra.startWorkers()

  callOrder = []
  const firstStageRun = await pipelineWorkflow.createRun()
  const firstStageSuspended = await firstStageRun.start({
    inputData: { postId: FIRST_STAGE_POST_ID },
  })
  const firstStageCalled = callOrder
  const firstStageRow = await readPost(FIRST_STAGE_POST_ID)
  callOrder = []
  await suspendedRun(firstStageRun.runId)
  await firstStageRun.resume({ step: "research", resumeData: { approved: true } })
  firstStage = {
    suspended: firstStageSuspended,
    calledBeforeApproval: firstStageCalled,
    resumed: await settledRun(firstStageRun.runId),
    calledAfterApproval: [],
    rowWhileSuspended: firstStageRow,
  }
  firstStage.calledAfterApproval = callOrder

  callOrder = []
  generateImageMock.mockClear()
  const imagesRun = await pipelineWorkflow.createRun()
  const imagesSuspended = await imagesRun.start({ inputData: { postId: IMAGES_POST_ID } })
  const imagesCalled = callOrder
  imageCallsWhileSuspended = generateImageMock.mock.calls.length
  const imagesRow = await readPost(IMAGES_POST_ID)
  callOrder = []
  await suspendedRun(imagesRun.runId)
  await imagesRun.resume({
    step: ["images", "images-manifest"],
    resumeData: { approved: true },
  })
  images = {
    suspended: imagesSuspended,
    calledBeforeApproval: imagesCalled,
    resumed: await settledRun(imagesRun.runId),
    calledAfterApproval: [],
    rowWhileSuspended: imagesRow,
  }
  images.calledAfterApproval = callOrder

  callOrder = []
  const selectionRun = await pipelineWorkflow.createRun()
  selection = {
    result: await selectionRun.start({
      inputData: { postId: SELECTION_POST_ID, stages: ["outline"] },
    }),
    called: [],
  }
  selection.called = callOrder
}, 180_000)

afterAll(async () => {
  await testMastra.stopWorkers()
  await pubsub.close()
  for (const postId of [FIRST_STAGE_POST_ID, IMAGES_POST_ID, SELECTION_POST_ID]) {
    await db.delete(posts).where(eq(posts.id, postId))
  }
  await closeDb()
  await rm(mediaRootDir, { recursive: true, force: true })
  delete process.env.MEDIA_DIR
  vi.restoreAllMocks()
})

describe("the gate decision", () => {
  it("pauses on both of Python's pausing modes and on nothing else", () => {
    const input = { postId: FIRST_STAGE_POST_ID }

    expect(stageNeedsReview("write", input, settings({ write: "review" }))).toBe(true)
    expect(stageNeedsReview("write", input, settings({ write: "approve_only" }))).toBe(true)
    expect(stageNeedsReview("write", input, settings({}))).toBe(false)
  })

  /**
   * Python read the raw column with `.get(stage, "review")`, so a stage the
   * settings map does not mention fails safe towards the human rather than
   * towards the provider's bill.
   */
  it("treats an unmentioned stage as needing review", () => {
    expect(gateModeFor("edit", { research: "auto" })).toBe("review")
    expect(stageNeedsReview("edit", { postId: FIRST_STAGE_POST_ID }, { research: "auto" })).toBe(
      true,
    )
  })

  /** Python's `check_gates=False`: a named selection is the operator's approval. */
  it("never pauses a run that names its stages", () => {
    const input = { postId: FIRST_STAGE_POST_ID, stages: ["write"] as const }

    expect(stageNeedsReview("write", { ...input, stages: ["write"] }, settings({ write: "review" }))).toBe(
      false,
    )
  })
})

describe("a full run gated at its first stage", () => {
  it("suspends at that stage instead of running it", () => {
    expect(firstStage.suspended.status).toBe("suspended")
    // The engine appends the step's own path inside its workflow to the step
    // id, so a top-level step reads as `[id, id]` while a nested one carries
    // the path the resume call has to name. Both are the engine's spelling,
    // not this port's.
    expect(
      firstStage.suspended.status === "suspended" ? firstStage.suspended.suspended : undefined,
    ).toEqual([["research", "research"]])
  })

  it("calls no provider while it waits", () => {
    expect(firstStage.calledBeforeApproval).toEqual([])
  })

  /** Python's pause wrote exactly these two columns before returning. */
  it("parks the row where the dashboard can see it", () => {
    expect(firstStage.rowWhileSuspended.currentStage).toBe("research")
    expect(firstStage.rowWhileSuspended.stageStatus).toEqual({ research: STATUS_REVIEW })
    expect(firstStage.rowWhileSuspended.researchContent).toBeNull()
  })

  it("reports the stage and the mode that paused it", () => {
    const steps = firstStage.suspended.steps as Record<
      string,
      { status: string; suspendPayload?: { stage?: string; mode?: string; message?: string } }
    >

    expect(steps.research?.status).toBe("suspended")
    // `toMatchObject`, because the engine adds its own `__workflow_meta` to
    // whatever a step suspends with.
    expect(steps.research?.suspendPayload).toMatchObject({
      stage: "research",
      mode: "review",
      message: "Stage research paused for review",
    })
  })

  it("runs the gated stage and every stage after it once approved", async () => {
    expect(firstStage.resumed.status).toBe("success")
    expect(firstStage.calledAfterApproval).toEqual([
      "research",
      "outline",
      "write",
      "edit",
      "images",
      "ready",
    ])

    const row = await readPost(FIRST_STAGE_POST_ID)
    expect(row.researchContent).toBe(AGENT_TEXT.research)
    expect(row.readyContent).toBe(AGENT_TEXT.ready)
    expect(row.stageStatus).toEqual(Object.fromEntries(STAGES.map((s) => [s, STATUS_COMPLETE])))
  })
})

describe("a full run gated inside the nested images workflow", () => {
  it("suspends on the manifest step, by its path through the nested workflow", () => {
    expect(images.suspended.status).toBe("suspended")
    expect(images.suspended.status === "suspended" ? images.suspended.suspended : undefined).toEqual(
      [["images", "images-manifest"]],
    )
  })

  /**
   * The gate has to sit in front of the manifest call, because everything the
   * stage spends is downstream of it: the manifest is what the fan-out bills
   * Gemini for, one call per image.
   */
  it("bills nothing for the gated stage while it waits", () => {
    expect(images.calledBeforeApproval).toEqual(["research", "outline", "write", "edit"])
    expect(imageCallsWhileSuspended).toBe(0)
  })

  it("parks the row at the gated stage, not at the one that just finished", () => {
    expect(images.rowWhileSuspended.currentStage).toBe("images")
    expect((images.rowWhileSuspended.stageStatus as Record<string, string>).images).toBe(
      STATUS_REVIEW,
    )
    expect(images.rowWhileSuspended.imageManifest).toBeNull()
  })

  it("generates the images and finishes the chain once approved", async () => {
    expect(images.resumed.status).toBe("success")
    expect(images.calledAfterApproval).toEqual(["images", "ready"])
    expect(generateImageMock).toHaveBeenCalledTimes(MANIFEST.images.length)

    const row = await readPost(IMAGES_POST_ID)
    expect((row.imageManifest as Record<string, unknown>).total_generated).toBe(1)
    expect(row.readyContent).toBe(AGENT_TEXT.ready)
    expect(row.stageStatus).toEqual(Object.fromEntries(STAGES.map((s) => [s, STATUS_COMPLETE])))
  })
})

describe("a run that names its stages", () => {
  it("runs the named stage without pausing, even with every gate set to review", async () => {
    expect(selection.result.status).toBe("success")
    expect(selection.called).toEqual(["outline"])

    const row = await readPost(SELECTION_POST_ID)
    expect(row.outlineContent).toBe(AGENT_TEXT.outline)
    expect((row.stageStatus as Record<string, string>).outline).toBe(STATUS_COMPLETE)
  })
})
