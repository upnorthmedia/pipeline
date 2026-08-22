// @vitest-environment node
/**
 * Item 5.4d-i: a permanently failed pipeline run is recorded on its post.
 *
 * The first suite is a real run of the real workflow with a real evented
 * engine, a real Redis Streams transport and the real database. Only the two
 * provider boundaries the run reaches are stubbed: `research` and `outline`
 * return text, and `write` throws, which is the shape of every real failure
 * (a provider call raising inside a stage) without spending anything.
 *
 * It runs on its own `Mastra` instance with its own Redis key prefix, for the
 * reason `pipeline.test.ts` records: vitest runs files in parallel and two
 * processes on the same topics would share the work between them.
 *
 * The second suite drives `recordRunFailure` with hand-built events against the
 * same real database, which is the only way to reach the branches a happy run
 * never produces: another workflow's failure, a non-failure event, a run whose
 * input carries no post, a thrown non-`Error`, and the repeat delivery the
 * topic is measured to produce.
 *
 * Requires `docker compose up -d db redis`.
 */
import { Mastra } from "@mastra/core"
import type { Event } from "@mastra/core/events"
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
import { recordRunFailure } from "./failure-recorder"
import { pubsub as productionPubsub, workerEvents } from "./index"
import { imagesWorkflow } from "./workflows/images"
import { pipelineWorkflow } from "./workflows/pipeline"

vi.mock("./api-keys", () => ({
  PROVIDERS: ["anthropic", "perplexity", "gemini"],
  API_KEYS_SETTING_KEY: "api_keys",
  getApiKeys: async () => ({ anthropic: "stub", perplexity: "stub", gemini: "stub" }),
  requireApiKey: async () => "test-key-not-a-real-credential",
}))

/** Text that passes `research`'s meta-response validator on the first attempt. */
const RESEARCH = [
  "## Keyword analysis",
  "primary keyword: failure recording",
  "## Pain point",
  "a dead run leaves the row parked on the stage it was executing.",
  "## Competitor coverage",
  "## Search intent: informational",
].join("\n\n")

/** What the `write` agent throws, and so what `_error.message` must carry. */
const BOOM = "provider exploded mid-draft"

const POST_ID = "00000000-0000-4000-8000-0000000005d1"
/** The row the hand-built events in the second suite write to. */
const UNIT_POST_ID = "00000000-0000-4000-8000-0000000005d2"

/** A `stage_logs` entry written before the failure, to prove the merge keeps it. */
const EXISTING_LOG = { model: "stub-research", tokens_in: 100, tokens_out: 20 }

const db = getDb()

const pubsub = new RedisStreamsPubSub({
  url: process.env.REDIS_URL!,
  keyPrefix: "mastra:test:failure-recorder",
})
const storage = new PostgresStore({ id: "failure-recorder-test", pool: getPool() })

/**
 * Every `workflow.fail` event published for the failing run, collected on an
 * independent fan-out subscription so the count is the transport's and not the
 * listener's.
 */
const failEvents: Event[] = []

const testMastra = new Mastra({
  storage,
  pubsub,
  workflows: { pipeline: pipelineWorkflow, images: imagesWorkflow },
  agents: {
    research: researchAgent,
    outline: outlineAgent,
    write: writeAgent,
    edit: editAgent,
    images: imagesAgent,
    ready: readyAgent,
  },
  // The production map, not a restatement of it: what `startWorkers()` below
  // subscribes is exactly what the `worker` service subscribes.
  events: workerEvents,
})

type PipelineResult = Awaited<
  ReturnType<Awaited<ReturnType<typeof pipelineWorkflow.createRun>>["start"]>
>

type StageLogs = { _error?: { message?: unknown; attempts?: unknown; failed_at?: unknown } } & Record<
  string,
  unknown
>

let result: PipelineResult
/** The failing run's id, to pick its events off the shared topic. */
let runId: string
/** The row as it stood once the listener had recorded the failure. */
let failedRow: typeof posts.$inferSelect
/**
 * What the engine printed while the run failed, captured so the expected stage
 * error is asserted on rather than left on stderr.
 *
 * It has to come off `console.error` rather than off the instance logger:
 * `MastraBase` gives every primitive its own `ConsoleLogger` in its constructor
 * and only adopts the Mastra instance's logger in `__registerMastra`, which the
 * engine never calls on its `StepExecutor`. So the failing step's line is
 * written by a logger no test can reach by spying on `testMastra.getLogger()`.
 */
let logged: string[]

async function insertPost(id: string, stageLogs: Record<string, unknown>) {
  await db.delete(posts).where(eq(posts.id, id))
  await db.insert(posts).values({
    id,
    slug: `failure-recorder-${id.slice(-4)}`,
    topic: "recording a dead run",
    currentStage: "pending",
    // Explicit, for the reason `pipeline.test.ts` records: the column default
    // predates the gate removal and would park the run at the first gate.
    stageSettings: {
      research: "auto",
      outline: "auto",
      write: "auto",
      edit: "auto",
      images: "auto",
      ready: "auto",
    },
    stageStatus: {},
    stageLogs,
  })
}

async function readPost(id: string) {
  const [row] = await db.select().from(posts).where(eq(posts.id, id))
  return row
}

/** Resolves once the listener has stamped the row, which lags `run.start()`. */
async function waitForFailure(id: string, timeoutMs = 30_000) {
  const deadline = Date.now() + timeoutMs
  for (;;) {
    const row = await readPost(id)
    if (row?.currentStage === "failed") return row
    if (Date.now() > deadline) throw new Error(`post ${id} was never marked failed`)
    await new Promise((resolve) => setTimeout(resolve, 100))
  }
}

/** A `workflow.fail` event shaped exactly as the engine publishes one. */
function failEvent(overrides: {
  workflowId?: string
  type?: string
  input?: Record<string, unknown>
  error?: unknown
}): Event {
  return {
    type: overrides.type ?? "workflow.fail",
    id: "11111111-1111-4111-8111-111111111111",
    runId: "22222222-2222-4222-8222-222222222222",
    createdAt: new Date(),
    data: {
      workflowId: overrides.workflowId ?? "pipeline",
      runId: "22222222-2222-4222-8222-222222222222",
      stepResults: {
        input: overrides.input ?? { postId: UNIT_POST_ID },
        __state: {},
      },
      prevResult: {
        status: "failed",
        error: overrides.error ?? { name: "Error", message: BOOM },
      },
    },
  }
}

beforeAll(async () => {
  logged = []
  vi.spyOn(console, "error").mockImplementation((...args: unknown[]) => {
    logged.push(args.map(String).join(" "))
  })

  vi.spyOn(researchAgent, "generate").mockImplementation((async () => ({
    text: RESEARCH,
    response: { modelId: "stub-research" },
    usage: { inputTokens: 100, outputTokens: 20 },
  })) as never)
  vi.spyOn(outlineAgent, "generate").mockImplementation((async () => ({
    text: "# Outline\n\n1. Opening\n2. Body\n3. Close",
    response: { modelId: "stub-outline" },
    usage: { inputTokens: 100, outputTokens: 20 },
  })) as never)
  vi.spyOn(writeAgent, "generate").mockImplementation((async () => {
    throw new Error(BOOM)
  }) as never)

  await insertPost(POST_ID, { research: EXISTING_LOG })

  await storage.init()
  await pubsub.subscribe("workflows-finish", async (event) => {
    if (event.type === "workflow.fail") failEvents.push(event)
  })
  await testMastra.startWorkers()

  const run = await pipelineWorkflow.createRun()
  runId = run.runId
  result = await run.start({ inputData: { postId: POST_ID } })
  failedRow = await waitForFailure(POST_ID)
}, 180_000)

afterAll(async () => {
  await testMastra.stopWorkers()
  await pubsub.close()
  // Importing `index.ts` for `workerEvents` constructs the production
  // transport; close it so the suite leaves no Redis client open.
  await productionPubsub.close()
  await db.delete(posts).where(eq(posts.id, POST_ID))
  await db.delete(posts).where(eq(posts.id, UNIT_POST_ID))
  await closeDb()
  vi.restoreAllMocks()
})

describe("a pipeline run that fails", () => {
  it("fails the run rather than swallowing the stage error", () => {
    expect(result.status).toBe("failed")
  })

  it("stamps current_stage failed, which is the queue route's failed bucket", () => {
    expect(failedRow.currentStage).toBe("failed")
  })

  it("records the stage's error text as _error.message, Python's str(e)", () => {
    const logs = failedRow.stageLogs as StageLogs
    expect(logs._error?.message).toBe(BOOM)
  })

  it("records how many times the run was executed, Python's job_try", () => {
    const logs = failedRow.stageLogs as StageLogs
    // `pipelineWorkflow.retryConfig` is `{attempts: 0}`, so the failing step ran once.
    expect(logs._error?.attempts).toBe(1)
  })

  it("records failed_at as a timestamp, close to the run", () => {
    const logs = failedRow.stageLogs as StageLogs
    const failedAt = Date.parse(String(logs._error?.failed_at))
    expect(Number.isNaN(failedAt)).toBe(false)
    expect(Math.abs(Date.now() - failedAt)).toBeLessThan(180_000)
  })

  it("merges _error in rather than replacing stage_logs", () => {
    const logs = failedRow.stageLogs as StageLogs
    expect(logs.research).toEqual(EXISTING_LOG)
  })

  it("leaves the stages before the failure committed", () => {
    expect(failedRow.researchContent).toBe(RESEARCH)
    expect(failedRow.outlineContent).toContain("# Outline")
  })

  it("leaves the failing stage's column unwritten", () => {
    expect(failedRow.draftContent ?? "").toBe("")
  })

  it("is published a terminal failure event more than once for one run", () => {
    // Measured, not assumed: the evented engine publishes `workflow.fail` twice
    // for one failed run. It is why the write has to be safe to repeat.
    const forThisRun = failEvents.filter((event) => event.runId === runId)
    expect(forThisRun.length).toBeGreaterThan(1)
  })

  it("reports the failing step and its error", () => {
    expect(
      logged.some((line) => line.includes("Error executing step write") && line.includes(BOOM)),
    ).toBe(true)
  })
})

describe("recordRunFailure", () => {
  beforeAll(async () => {
    await insertPost(UNIT_POST_ID, { research: EXISTING_LOG })
  })

  it("ignores a failure from another workflow", async () => {
    await recordRunFailure(failEvent({ workflowId: "sitemapCrawl" }))
    expect((await readPost(UNIT_POST_ID)).currentStage).toBe("pending")
  })

  it("ignores a terminal event that is not a failure", async () => {
    await recordRunFailure(failEvent({ type: "workflow.end" }))
    expect((await readPost(UNIT_POST_ID)).currentStage).toBe("pending")
  })

  it("ignores a run whose input carries no post id", async () => {
    await recordRunFailure(failEvent({ input: {} }))
    expect((await readPost(UNIT_POST_ID)).currentStage).toBe("pending")
  })

  it("records a thrown non-Error, which the engine passes through as it was", async () => {
    await recordRunFailure(failEvent({ error: "raw string failure" }))
    const logs = (await readPost(UNIT_POST_ID)).stageLogs as StageLogs
    expect(logs._error?.message).toBe("raw string failure")
  })

  it("is safe to repeat: a second delivery rewrites the same values", async () => {
    await recordRunFailure(failEvent({}))
    const first = (await readPost(UNIT_POST_ID)).stageLogs as StageLogs
    await recordRunFailure(failEvent({}))
    const second = (await readPost(UNIT_POST_ID)).stageLogs as StageLogs

    expect(second.research).toEqual(EXISTING_LOG)
    expect(second._error?.message).toBe(first._error?.message)
    expect(second._error?.attempts).toBe(first._error?.attempts)
  })
})
