// @vitest-environment node
/**
 * Item 5.5c-iii-b-2-b-i: the `images` stage retries like the other five.
 *
 * `nested-retry.test.ts` measures the engine rule this rests on: a parent does
 * not retry a nested workflow entry, so `pipelineWorkflow.retryConfig` never
 * reached `imagesWorkflow` and the one stage that is a nested workflow got a
 * single attempt where Python's `max_tries = MAX_ATTEMPTS` gave it three. This
 * asserts the fix on the real workflow: `imagesWorkflow` carries the same
 * policy, so a failing Claude call is retried inside the nested run.
 *
 * The harness is `imagesWorkflow` nested under a synthetic parent that declares
 * `pipelineWorkflow`'s policy, which is the nesting relationship the pipeline
 * has without the four stages ahead of it. Running `imagesWorkflow` on its own
 * would prove nothing about the boundary, since a top-level run has no parent
 * policy to be shadowed by.
 *
 * One boundary is stubbed and nothing else: the Claude call, which throws. The
 * database, the transport and the engine are real.
 *
 * It runs on its own `Mastra` instance with its own Redis key prefix, for the
 * reason `images.test.ts` records: vitest runs files in parallel and two
 * processes on the same evented topics would share the work between them.
 *
 * Requires `docker compose up -d db redis`.
 */
import { Mastra } from "@mastra/core"
import { createWorkflow } from "@mastra/core/workflows/evented"
import { PostgresStore } from "@mastra/pg"
import { RedisStreamsPubSub } from "@mastra/redis-streams"
import { eq } from "drizzle-orm"
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest"

import { closeDb, getDb, getPool, posts } from "../../db"
import { imagesAgent } from "../agents/images"
import { MAX_ATTEMPTS } from "../state"
import { imagesStageOutputSchema } from "../steps/images-assemble"
import { stageStepInputSchema } from "../steps/stage-io"
import { imagesWorkflow } from "./images"
import { pipelineWorkflow } from "./pipeline"

vi.mock("../api-keys", () => ({
  PROVIDERS: ["anthropic", "perplexity", "gemini"],
  API_KEYS_SETTING_KEY: "api_keys",
  getApiKeys: async () => ({ anthropic: "stub", perplexity: "stub", gemini: "stub" }),
  requireApiKey: async () => "test-key-not-a-real-credential",
}))

const POST_ID = "00000000-0000-4000-8000-00000005c3bb"

/** What the stubbed Claude call throws, and so what the engine has to retry. */
const BOOM = "manifest provider exploded"

const db = getDb()

/**
 * The pipeline's nesting relationship, minus the stages ahead of `images`.
 * Its policy is `pipelineWorkflow`'s, read off it rather than restated, so a
 * change to the pipeline's policy cannot leave this harness asserting against
 * a number the pipeline no longer uses.
 */
const parentWorkflow = createWorkflow({
  id: "images-retry-parent",
  inputSchema: stageStepInputSchema,
  outputSchema: imagesStageOutputSchema,
  retryConfig: { attempts: pipelineWorkflow.retryConfig?.attempts ?? 0 },
})
  .then(imagesWorkflow)
  .commit()

const pubsub = new RedisStreamsPubSub({
  url: process.env.REDIS_URL!,
  keyPrefix: "mastra:test:images-retry",
})
const storage = new PostgresStore({ id: "images-retry-test", pool: getPool() })

const testMastra = new Mastra({
  storage,
  pubsub,
  workflows: { "images-retry-parent": parentWorkflow, images: imagesWorkflow },
  agents: { images: imagesAgent },
})

async function readLogs(): Promise<Record<string, unknown>[]> {
  const [row] = await db
    .select({ logs: posts.executionLogs })
    .from(posts)
    .where(eq(posts.id, POST_ID))
  return (row?.logs ?? []) as Record<string, unknown>[]
}

let result: { status: string }
let agentGenerate: ReturnType<typeof vi.spyOn>
/** The engine's stderr, captured so the expected step errors are asserted on. */
let logged: string[]

beforeAll(async () => {
  logged = []
  vi.spyOn(console, "error").mockImplementation((...args: unknown[]) => {
    logged.push(args.map(String).join(" "))
  })

  agentGenerate = vi.spyOn(imagesAgent, "generate").mockImplementation((async () => {
    throw new Error(BOOM)
  }) as never)

  await db.delete(posts).where(eq(posts.id, POST_ID))
  await db.insert(posts).values({
    id: POST_ID,
    slug: "images-retry-run",
    topic: "images retry",
    currentStage: "edit",
    stageStatus: { research: "complete", outline: "complete", write: "complete", edit: "complete" },
    // Explicit, because the column default predates the gate removal and would
    // park the run at the `images` review gate instead of running it.
    stageSettings: {
      research: "auto",
      outline: "auto",
      write: "auto",
      edit: "auto",
      images: "auto",
      ready: "auto",
    },
  })

  await storage.init()
  await testMastra.startWorkers()

  const run = await parentWorkflow.createRun()
  result = (await run.start({ inputData: { postId: POST_ID } })) as typeof result
}, 120_000)

afterAll(async () => {
  await testMastra.stopWorkers()
  await pubsub.close()
  await db.delete(posts).where(eq(posts.id, POST_ID))
  await closeDb()
  vi.restoreAllMocks()
})

describe("the images stage under the pipeline's retry policy", () => {
  it("declares the pipeline's policy on the nested workflow itself", () => {
    // Not a restatement of the constant for its own sake: this is the only
    // thing standing between the stage and the single attempt the measurement
    // in `nested-retry.test.ts` showed it used to get.
    expect(imagesWorkflow.retryConfig?.attempts).toBe(MAX_ATTEMPTS - 1)
    expect(imagesWorkflow.retryConfig?.attempts).toBe(pipelineWorkflow.retryConfig?.attempts)
  })

  it("calls the manifest provider once per attempt Python's max_tries allowed", () => {
    expect(agentGenerate).toHaveBeenCalledTimes(MAX_ATTEMPTS)
    expect(logged.filter((line) => line.startsWith("Error executing step images-manifest:"))).toHaveLength(
      MAX_ATTEMPTS,
    )
  })

  it("fails the parent run once those attempts are spent", () => {
    expect(result.status).toBe("failed")
  })

  it("announces the stage once per attempt, as a retried step re-runs its whole body", async () => {
    // Python's job retry re-entered `_run_pipeline()` and re-announced the
    // stage it resumed on, so a `stage_start` per attempt is parity rather
    // than an artefact.
    const entries = await readLogs()
    expect(entries.filter((entry) => entry.event === "stage_start")).toHaveLength(MAX_ATTEMPTS)
    expect(entries.every((entry) => entry.stage === "images")).toBe(true)
  })

  // Item 5.5c-iii-b-2-b-ii: the `warning` / `retry` entry, written from inside
  // the sub-step. The five single-step stages got theirs in 5.5c-iii-b-2-a;
  // this is the same entry from the one stage that is a nested workflow, and
  // this run is the only place its interleaving can be observed for real.
  it("records a retry for every attempt but the last, under the stage's own name", async () => {
    const retries = (await readLogs()).filter((entry) => entry.event === "retry")
    expect(retries).toEqual([
      {
        ts: expect.any(String),
        stage: "images",
        level: "warning",
        event: "retry",
        message: "Pipeline attempt 1 failed, retrying...",
        data: { attempt: 1, max_attempts: MAX_ATTEMPTS, error: BOOM },
      },
      {
        ts: expect.any(String),
        stage: "images",
        level: "warning",
        event: "retry",
        message: "Pipeline attempt 2 failed, retrying...",
        data: { attempt: 2, max_attempts: MAX_ATTEMPTS, error: BOOM },
      },
    ])
    expect(retries).toHaveLength(MAX_ATTEMPTS - 1)
  })

  it("interleaves the retry after every attempt that is followed by another", async () => {
    // The whole trail, in order. The sub-step's `retryCount` against
    // `imagesWorkflow`'s own policy is a single ascending sequence, so the
    // entries read exactly like a single-step stage's do.
    expect((await readLogs()).map((entry) => `${entry.level}/${entry.event}`)).toEqual([
      "info/stage_start",
      "warning/retry",
      "info/stage_start",
      "warning/retry",
      "info/stage_start",
    ])
  })
})
