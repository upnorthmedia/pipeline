// @vitest-environment node
/**
 * Ledger item P2.109a: moving a run that is parked at a review gate.
 *
 * The gate itself was ported at 4.3 and `review-gates.test.ts` proves a run
 * suspends and, resumed *from the handle that started it*, finishes the chain.
 * Nothing in the app had that handle. The web process that serves the approval
 * is not the process that started the run, is usually not even the same
 * container, and holds nothing but a post id. So the question this file
 * answers is the one the dashboard actually asks: **given a post id, which run
 * is waiting, and can this process release it?**
 *
 * Every run here is real: real Postgres, real Redis, the real evented engine,
 * the real six-step pipeline. Only the provider boundaries are stubbed, so a
 * gated run costs nothing and a released one runs the remaining five stages to
 * `complete`. The run is always started through one handle and resumed through
 * a second one built from the run id alone, because that second handle is the
 * only thing a route handler can ever have.
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
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest"

import { closeDb, getDb, getPool, posts } from "../db"
import { editAgent } from "./agents/edit"
import { imagesAgent } from "./agents/images"
import { outlineAgent } from "./agents/outline"
import { readyAgent } from "./agents/ready"
import { researchAgent } from "./agents/research"
import { writeAgent } from "./agents/write"
import { approveSuspendedGate, findSuspendedGate } from "./gate-approval"
import corpus from "./images/data/image-generation-parity.json"
import { STAGES, STATUS_COMPLETE, STATUS_REVIEW } from "./state"
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

/** Gated at `research`, released by post id. */
const FIRST_STAGE_POST_ID = "00000000-0000-4000-8000-0000000004f1"
/** Gated at `images`, whose gate sits inside the nested images workflow. */
const NESTED_POST_ID = "00000000-0000-4000-8000-0000000004f2"
/** Started twice, the way the dashboard's only forward action starts it. */
const RESTARTED_POST_ID = "00000000-0000-4000-8000-0000000004f3"
/** Never started, so nothing is waiting on it. */
const IDLE_POST_ID = "00000000-0000-4000-8000-0000000004f4"

const db = getDb()
let mediaRootDir: string

const pubsub = new RedisStreamsPubSub({
  url: process.env.REDIS_URL!,
  keyPrefix: "mastra:test:gate-approval",
})
const storage = new PostgresStore({ id: "gate-approval-test", pool: getPool() })
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

const POST_IDS = [FIRST_STAGE_POST_ID, NESTED_POST_ID, RESTARTED_POST_ID, IDLE_POST_ID]

function settings(overrides: Record<string, string>): Record<string, string> {
  return { ...Object.fromEntries(STAGES.map((stage) => [stage, "auto"])), ...overrides }
}

function seedValues(postId: string, stageSettings: Record<string, string>) {
  return {
    id: postId,
    slug: `gate-approval-${postId.slice(-3)}`,
    topic: "composable pipelines",
    currentStage: "pending",
    stageSettings,
    stageStatus: {},
  }
}

/**
 * Drop every run these posts have ever parked.
 *
 * The suite's post ids are fixed, and a suspended run outlives the row it was
 * started for: without this, a second execution counts the first execution's
 * orphans and the run-again case reads three suspended runs where it asserts
 * two. `resourceId` is the same tag the lookup under test uses, so this
 * removes exactly what it would find.
 */
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

/**
 * Wait for the suspend to reach storage.
 *
 * The engine publishes `workflow.suspend` alongside, not after, the snapshot
 * write, so looking for the parked run immediately can lose that race.
 */
async function suspendedRun(runId: string) {
  for (let attempt = 0; attempt < 300; attempt += 1) {
    const state = await pipelineWorkflow.getWorkflowRunById(runId)
    if (state?.status === "suspended") return state
    await new Promise((resolve) => setTimeout(resolve, 100))
  }
  throw new Error(`run ${runId} never suspended`)
}

/**
 * Wait for a released run to actually finish.
 *
 * Nothing returned by the resume can be awaited for this: it settles off the
 * shared `workflows-finish` topic, whose Redis stream still holds this run's
 * earlier `workflow.suspend` entry. `evented-resume.test.ts` pins that. The
 * persisted run state is the only honest answer, so poll that.
 */
async function settledRun(runId: string) {
  for (let attempt = 0; attempt < 600; attempt += 1) {
    const state = await pipelineWorkflow.getWorkflowRunById(runId)
    if (state && state.status !== "suspended" && state.status !== "running") return state
    await new Promise((resolve) => setTimeout(resolve, 100))
  }
  throw new Error(`run ${runId} never left the suspended state`)
}

/** Start a run the way `startPipeline()` does, and wait for it to park. */
async function startAndPark(postId: string) {
  const run = await pipelineWorkflow.createRun({ resourceId: postId })
  await run.startAsync({ inputData: { postId } })
  await suspendedRun(run.runId)
  return run.runId
}

beforeAll(async () => {
  mediaRootDir = await mkdtemp(path.join(tmpdir(), "gate-approval-"))
  process.env.MEDIA_DIR = mediaRootDir

  // `edit`'s readability and SEO checks all fail on the stubbed three-line
  // draft. Captured rather than printed, so a real warning from a later change
  // is not buried in this file's stderr.
  vi.spyOn(testMastra.getLogger(), "warn").mockImplementation((() => {}) as never)

  for (const [stage, agent] of Object.entries(agents)) {
    vi.spyOn(agent, "generate").mockImplementation((async () => ({
      text: AGENT_TEXT[stage as keyof typeof AGENT_TEXT],
      response: { modelId: `stub-${stage}` },
      usage: { inputTokens: 100, outputTokens: 20 },
    })) as never)
  }
  generateImageMock.mockResolvedValue({
    imageBytes: PNG,
    model: "gemini-3.1-flash-image-preview",
    tokensIn: 7,
    tokensOut: 11,
  })

  for (const postId of POST_IDS) await db.delete(posts).where(eq(posts.id, postId))
  await deleteRunsFor(POST_IDS)
  await db.insert(posts).values(seedValues(FIRST_STAGE_POST_ID, settings({ research: "review" })))
  await db.insert(posts).values(seedValues(NESTED_POST_ID, settings({ images: "approve_only" })))
  await db.insert(posts).values(seedValues(RESTARTED_POST_ID, settings({ research: "review" })))
  await db.insert(posts).values(seedValues(IDLE_POST_ID, settings({})))

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

describe("finding the run a post is parked on", () => {
  it("names the waiting run, its stage and the mode that paused it", async () => {
    const runId = await startAndPark(FIRST_STAGE_POST_ID)

    const gate = await findSuspendedGate(pipelineWorkflow, FIRST_STAGE_POST_ID)

    expect(gate).toEqual({ runId, stage: "research", mode: "review" })
    // The row the dashboard reads agrees with the snapshot the engine wrote.
    expect((await readPost(FIRST_STAGE_POST_ID)).stageStatus?.research).toBe(STATUS_REVIEW)
  }, 120_000)

  it("answers nothing for a post with no run behind it", async () => {
    expect(await findSuspendedGate(pipelineWorkflow, IDLE_POST_ID)).toBeNull()
  })

  /**
   * The nested gate is the one that cannot be resumed by naming the step id:
   * `images-manifest` suspends inside the `images` workflow, so the path the
   * engine needs is `["images", "images-manifest"]`. The lookup has to report
   * the *stage* either way, since that is what the reviewer is being asked
   * about, and the release has to find the path without being told it.
   */
  it("reports the stage for a gate inside the nested images workflow", async () => {
    const runId = await startAndPark(NESTED_POST_ID)

    expect(await findSuspendedGate(pipelineWorkflow, NESTED_POST_ID)).toEqual({
      runId,
      stage: "images",
      mode: "approve_only",
    })
  }, 120_000)
})

describe("releasing a parked run", () => {
  it("continues the chain the run was already in", async () => {
    const before = await pipelineWorkflow.listWorkflowRuns({ resourceId: FIRST_STAGE_POST_ID })

    const released = await approveSuspendedGate(pipelineWorkflow, FIRST_STAGE_POST_ID)
    const settled = await settledRun(released!.runId)
    const row = await readPost(FIRST_STAGE_POST_ID)

    expect(settled.status).toBe("success")
    // The five stages after the gate all committed their column, which is the
    // difference from the dashboard's only other forward action: the run that
    // was waiting is the run that finished.
    for (const stage of STAGES) expect(row.stageStatus?.[stage]).toBe(STATUS_COMPLETE)
    // No second run was created to do it.
    const after = await pipelineWorkflow.listWorkflowRuns({ resourceId: FIRST_STAGE_POST_ID })
    expect(after.total).toBe(before.total)
    expect(await findSuspendedGate(pipelineWorkflow, FIRST_STAGE_POST_ID)).toBeNull()
  }, 180_000)

  it("releases a gate nested inside the images workflow without being told its path", async () => {
    const released = await approveSuspendedGate(pipelineWorkflow, NESTED_POST_ID)
    const settled = await settledRun(released!.runId)

    expect(released).toMatchObject({ stage: "images", mode: "approve_only" })
    expect(settled.status).toBe("success")
    expect((await readPost(NESTED_POST_ID)).stageStatus?.ready).toBe(STATUS_COMPLETE)
  }, 180_000)

  it("answers nothing, rather than throwing, when nothing is waiting", async () => {
    expect(await approveSuspendedGate(pipelineWorkflow, IDLE_POST_ID)).toBeNull()
    expect(await approveSuspendedGate(pipelineWorkflow, FIRST_STAGE_POST_ID)).toBeNull()
  }, 60_000)
})

/**
 * What the dashboard's only forward action does today, measured rather than
 * asserted from the code: `POST /api/posts/{id}/run` calls `startPipeline()`,
 * which creates a *new* run. The parked one is not touched by that, so a post
 * can accumulate suspended runs, and the release has to pick one.
 */
describe("a post started again while it was parked", () => {
  it("leaves the first run suspended and parks the second at the same gate", async () => {
    const firstRunId = await startAndPark(RESTARTED_POST_ID)
    const secondRunId = await startAndPark(RESTARTED_POST_ID)

    expect(secondRunId).not.toBe(firstRunId)
    const suspended = await pipelineWorkflow.listWorkflowRuns({
      status: "suspended",
      resourceId: RESTARTED_POST_ID,
    })
    expect(suspended.total).toBe(2)

    // The newest is the one the reviewer is looking at, so that is the one
    // released. The older run stays parked: releasing cannot un-orphan runs
    // the restart path left behind.
    const released = await approveSuspendedGate(pipelineWorkflow, RESTARTED_POST_ID)
    expect(released?.runId).toBe(secondRunId)
    expect((await settledRun(secondRunId)).status).toBe("success")
    expect((await pipelineWorkflow.getWorkflowRunById(firstRunId))?.status).toBe("suspended")
  }, 240_000)
})
