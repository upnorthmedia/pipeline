// @vitest-environment node
/**
 * Items 5.4d-i, 5.5b and 5.5c-iii-a: a permanently failed pipeline run is
 * recorded on its post, announced to the dashboard as `stage_error`, and
 * written to `execution_logs` so a browser that was not open can still read
 * that it died and why.
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
import type { Event, PubSub } from "@mastra/core/events"
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
import { createWorkerEvents, recordRunFailure } from "./failure-recorder"
import { TOPIC_PIPELINE_EVENTS } from "./pipeline-events"
import { MAX_ATTEMPTS } from "./state"
import { pubsub as productionPubsub } from "./index"
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

/**
 * Every pipeline event the run published, and `current_stage` as the row read
 * at the instant each one was delivered. The second is the commit-before-publish
 * assertion: `posts/[id]/page.tsx` refetches the post on `stage_error`.
 */
const pipelineEvents: Event[] = []
const currentStageOnDelivery: Record<string, string | undefined> = {}

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
  events: createWorkerEvents(pubsub),
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

/** A post's `execution_logs`, typed enough to read an entry's fields. */
function executionLogsOf(row: typeof posts.$inferSelect) {
  return (row.executionLogs ?? []) as Record<string, unknown>[]
}

/** Every `stage_error` the bus has delivered for a post. */
function stageErrorsFor(postId: string) {
  return pipelineEvents.filter(
    (event) => event.data?.post_id === postId && event.data?.event === "stage_error",
  )
}

/**
 * Wait for the run's `stage_error`, giving up quietly.
 *
 * Quietly on purpose: an announcement that never arrives is what these tests
 * exist to catch, and a `beforeAll` that throws reports skips rather than the
 * failures that name the missing event.
 */
async function settleStageError(postId: string, timeoutMs = 15_000) {
  const deadline = Date.now() + timeoutMs
  while (stageErrorsFor(postId).length === 0 && Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, 100))
  }
}

/**
 * Run ids for the hand-built cases below. Distinct per case because the
 * announcement is guarded by run id, so two cases sharing one would leave the
 * second silently unannounced.
 */
const RUN_NON_ERROR = "33333333-3333-4333-8333-333333333331"
const RUN_NO_STAGE = "33333333-3333-4333-8333-333333333332"
const RUN_WITH_STAGE = "33333333-3333-4333-8333-333333333333"
const RUN_REPEAT = "33333333-3333-4333-8333-333333333334"
const RUN_LOG_STAGE = "33333333-3333-4333-8333-333333333335"
const RUN_LOG_REPEAT = "33333333-3333-4333-8333-333333333336"

/** A `workflow.fail` event shaped exactly as the engine publishes one. */
function failEvent(overrides: {
  workflowId?: string
  type?: string
  input?: Record<string, unknown>
  error?: unknown
  /** Distinct per case, because the announcement is guarded by run id. */
  runId?: string
  /** Per-step results, which is where the failing stage is read from. */
  steps?: Record<string, unknown>
}): Event {
  const runId = overrides.runId ?? "22222222-2222-4222-8222-222222222222"
  return {
    type: overrides.type ?? "workflow.fail",
    id: "11111111-1111-4111-8111-111111111111",
    runId,
    createdAt: new Date(),
    data: {
      workflowId: overrides.workflowId ?? "pipeline",
      runId,
      stepResults: {
        input: overrides.input ?? { postId: UNIT_POST_ID },
        __state: {},
        ...overrides.steps,
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
  // Both topics below are retained Redis streams, and an ungrouped subscription
  // reads one from its first entry. Without these, every previous execution of
  // this file replays: measured at 27 historical runs, 54 `workflow.fail`
  // deliveries and 26 `stage_error` announcements for a single failing run.
  // Item 5.5a found the same trap on the pipeline topic.
  await pubsub.clearTopic("workflows-finish")
  await pubsub.subscribe("workflows-finish", async (event) => {
    if (event.type === "workflow.fail") failEvents.push(event)
  })
  await pubsub.clearTopic(TOPIC_PIPELINE_EVENTS)
  await pubsub.subscribe(TOPIC_PIPELINE_EVENTS, async (event) => {
    const postId = event.data?.post_id
    if (typeof postId === "string") {
      currentStageOnDelivery[`${postId}/${event.data?.event}`] =
        (await readPost(postId))?.currentStage ?? undefined
    }
    // Pushed last: `settleStageError` counts this array, so recording the event
    // before its row snapshot lets `beforeAll` return while the read is still
    // in flight. Measured as a flake under full-suite load.
    pipelineEvents.push(event)
  })
  await testMastra.startWorkers()

  const run = await pipelineWorkflow.createRun()
  runId = run.runId
  result = await run.start({ inputData: { postId: POST_ID } })
  failedRow = await waitForFailure(POST_ID)
  await settleStageError(POST_ID)
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
    // `pipelineWorkflow.retryConfig` is `{attempts: MAX_ATTEMPTS - 1}`, so the
    // failing step ran `MAX_ATTEMPTS` times before the run was given up on,
    // which is the number Python reached the dead-letter queue carrying.
    expect(logs._error?.attempts).toBe(MAX_ATTEMPTS)
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

  it("re-executes the failing stage MAX_ATTEMPTS times, Python's max_tries", () => {
    // ARQ re-ran the whole job up to `MAX_ATTEMPTS` times
    // (`api/src/worker.py:609`). The engine retries the failing step instead,
    // which lands on the same number of provider calls because Python's rerun
    // skipped every stage already marked complete.
    expect(vi.mocked(writeAgent.generate)).toHaveBeenCalledTimes(MAX_ATTEMPTS)
  })

  it("does not re-run the stages that already completed", () => {
    // Python's skip check (`stage_status[stage] == "complete"`, worker.py:151)
    // is what kept a retry from re-billing finished stages. Here the retry is
    // scoped to the step that threw, so the same property holds for free.
    expect(vi.mocked(researchAgent.generate)).toHaveBeenCalledTimes(1)
    expect(vi.mocked(outlineAgent.generate)).toHaveBeenCalledTimes(1)
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

  it("announces stage_error on the pipeline bus, in Python's payload shape", () => {
    const [announced] = stageErrorsFor(POST_ID)
    expect(announced?.data).toEqual({
      event: "stage_error",
      post_id: POST_ID,
      // Python sent "" for a full run; the run results name the step that
      // threw, so the dashboard's toast reads "write failed" rather than
      // "Pipeline failed".
      stage: "write",
      error: BOOM,
      message: `Pipeline failed: ${BOOM}`,
    })
  })

  it("announces it once, though the engine published the failure more than once", () => {
    expect(stageErrorsFor(POST_ID)).toHaveLength(1)
  })

  it("stamps the row failed before it announces", () => {
    expect(currentStageOnDelivery[`${POST_ID}/stage_error`]).toBe("failed")
  })

  it("announces no stage_complete for the stage that threw", () => {
    const completed = pipelineEvents
      .filter((event) => event.data?.post_id === POST_ID && event.data?.event === "stage_complete")
      .map((event) => event.data.stage)
    // `research` and `outline` committed and reported; `write` threw before its
    // own `saveStageOutput`, so it has nothing to report.
    expect(completed).toEqual(["research", "outline"])
  })

  it("writes Python's error entry to execution_logs, once", () => {
    const entries = executionLogsOf(failedRow).filter((entry) => entry.event === "stage_error")
    expect(entries).toHaveLength(1)
    expect(entries[0]).toEqual({
      ts: expect.any(String),
      stage: "write",
      level: "error",
      event: "stage_error",
      // Python's `f"Pipeline failed after {job_try} attempts: {e}"`, with the
      // attempt count the engine's retry policy makes true here.
      message: `Pipeline failed after ${MAX_ATTEMPTS} attempts: ${BOOM}`,
      data: { error: BOOM, attempts: MAX_ATTEMPTS, moved_to_dlq: true },
    })
  })

  it("timestamps the error entry in the offset form the analytics query sorts on", () => {
    const [entry] = executionLogsOf(failedRow).filter((e) => e.event === "stage_error")
    expect(String(entry.ts)).toMatch(/\+00:00$/)
  })

  it("closes the log with the failure, after the stages that did complete", () => {
    // The failing run's whole trail, which is what `GET /posts/{id}/logs`
    // serves to an operator who was not watching: it started, two stages ran,
    // and it died in the third.
    // `stage_start/write` appears once per attempt. Python's retry re-entered
    // `_run_pipeline()` and re-announced the stage it resumed on for the same
    // reason, so the trail an operator reads is the one it always was.
    expect(executionLogsOf(failedRow).map((entry) => `${entry.event}/${entry.stage}`)).toEqual([
      "pipeline_start/",
      "stage_start/research",
      "stage_complete/research",
      "stage_start/outline",
      "stage_complete/outline",
      ...Array(MAX_ATTEMPTS).fill("stage_start/write"),
      "stage_error/write",
    ])
  })

  it("writes no pipeline_complete entry for a run that died", () => {
    expect(executionLogsOf(failedRow).some((entry) => entry.event === "pipeline_complete")).toBe(
      false,
    )
  })

  it("never says the pipeline finished", () => {
    const finished = pipelineEvents.filter(
      (event) => event.data?.post_id === POST_ID && event.data?.event === "pipeline_complete",
    )
    expect(finished).toEqual([])
  })
})

describe("recordRunFailure", () => {
  /**
   * A recording transport rather than the file's own: these cases are about
   * what the function publishes, and a fan-out subscription would interleave
   * them with the real run's events above.
   */
  let announced: Record<string, unknown>[]
  const recorder = {
    publish: async (_topic: string, event: { data: Record<string, unknown> }) => {
      announced.push(event.data)
    },
  } as unknown as PubSub

  beforeAll(async () => {
    await insertPost(UNIT_POST_ID, { research: EXISTING_LOG })
  })

  beforeEach(() => {
    announced = []
  })

  it("ignores a failure from another workflow", async () => {
    await recordRunFailure(failEvent({ workflowId: "sitemapCrawl" }), recorder)
    expect((await readPost(UNIT_POST_ID)).currentStage).toBe("pending")
    expect(announced).toEqual([])
  })

  it("ignores a terminal event that is not a failure", async () => {
    await recordRunFailure(failEvent({ type: "workflow.end" }), recorder)
    expect((await readPost(UNIT_POST_ID)).currentStage).toBe("pending")
    expect(announced).toEqual([])
  })

  it("ignores a run whose input carries no post id", async () => {
    await recordRunFailure(failEvent({ input: {} }), recorder)
    expect((await readPost(UNIT_POST_ID)).currentStage).toBe("pending")
    expect(announced).toEqual([])
  })

  it("records a thrown non-Error, which the engine passes through as it was", async () => {
    await recordRunFailure(
      failEvent({ error: "raw string failure", runId: RUN_NON_ERROR }),
      recorder,
    )
    const logs = (await readPost(UNIT_POST_ID)).stageLogs as StageLogs
    expect(logs._error?.message).toBe("raw string failure")
    expect(announced[0].error).toBe("raw string failure")
    expect(announced[0].message).toBe("Pipeline failed: raw string failure")
  })

  it("reports no stage when no step result says which one failed", async () => {
    await recordRunFailure(failEvent({ runId: RUN_NO_STAGE }), recorder)
    // Python's own answer for a full-pipeline failure, and what the dashboard
    // renders as "Pipeline failed".
    expect(announced[0].stage).toBe("")
  })

  it("names the stage whose own step result failed", async () => {
    await recordRunFailure(
      failEvent({ runId: RUN_WITH_STAGE, steps: { edit: { status: "failed" } } }),
      recorder,
    )
    expect(announced[0].stage).toBe("edit")
  })

  it("is safe to repeat: a second delivery rewrites the same values", async () => {
    await recordRunFailure(failEvent({}), recorder)
    const first = (await readPost(UNIT_POST_ID)).stageLogs as StageLogs
    await recordRunFailure(failEvent({}), recorder)
    const second = (await readPost(UNIT_POST_ID)).stageLogs as StageLogs

    expect(second.research).toEqual(EXISTING_LOG)
    expect(second._error?.message).toBe(first._error?.message)
    expect(second._error?.attempts).toBe(first._error?.attempts)
  })

  it("announces the repeat delivery only once, though it writes both times", async () => {
    await recordRunFailure(failEvent({ runId: RUN_REPEAT }), recorder)
    await recordRunFailure(failEvent({ runId: RUN_REPEAT }), recorder)

    // The write is idempotent so a repeat is free; a toast is not.
    expect(announced).toHaveLength(1)
  })

  it("appends the error entry naming the stage it announced, with Python's data keys", async () => {
    await recordRunFailure(
      failEvent({ runId: RUN_LOG_STAGE, steps: { edit: { status: "failed" } } }),
      recorder,
    )
    const entries = executionLogsOf(await readPost(UNIT_POST_ID))
    expect(entries.at(-1)).toEqual({
      ts: expect.any(String),
      stage: "edit",
      level: "error",
      event: "stage_error",
      message: `Pipeline failed after ${MAX_ATTEMPTS} attempts: ${BOOM}`,
      data: { error: BOOM, attempts: MAX_ATTEMPTS, moved_to_dlq: true },
    })
  })

  it("appends nothing for a repeat delivery, because an append is not idempotent", async () => {
    await recordRunFailure(failEvent({ runId: RUN_LOG_REPEAT }), recorder)
    const afterFirst = executionLogsOf(await readPost(UNIT_POST_ID)).length
    await recordRunFailure(failEvent({ runId: RUN_LOG_REPEAT }), recorder)
    expect(executionLogsOf(await readPost(UNIT_POST_ID))).toHaveLength(afterFirst)
  })

  it("appends nothing for an event it ignores", async () => {
    const before = executionLogsOf(await readPost(UNIT_POST_ID)).length
    await recordRunFailure(failEvent({ workflowId: "sitemapCrawl" }), recorder)
    await recordRunFailure(failEvent({ type: "workflow.end" }), recorder)
    await recordRunFailure(failEvent({ input: {} }), recorder)
    expect(executionLogsOf(await readPost(UNIT_POST_ID))).toHaveLength(before)
  })
})
