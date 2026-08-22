// @vitest-environment node
/**
 * Item 4.4: execution moves out of `web` and into the `worker` service.
 *
 * The two Railway services import the same `src/mastra/index.ts`, but only one
 * of them executes anything. `web` calls `startAsync()`, which publishes
 * `workflow.start` onto Redis Streams and returns a run id; `worker` is a
 * process that has called `mastra.startWorkers()` and consumes that event.
 *
 * The worker here is the real deployable artifact, not a stand-in: this suite
 * runs `mastra worker build`, which bundles `src/mastra/index.ts` behind the
 * CLI's generated entry (`await mastra.startWorkers()` plus a SIGTERM/SIGINT
 * shutdown), and then boots `node .mastra/worker/index.mjs`, which is the
 * command `mastra worker start` runs. So a green run also proves the bundle
 * builds and boots, which is the part a unit test with a hand-rolled worker
 * would quietly skip.
 *
 * The proof that execution really moved rests on the ordering:
 *
 *   1. two runs are started with no worker process alive anywhere;
 *   2. seconds later neither has executed and neither post row has changed;
 *   3. the worker is spawned;
 *   4. both runs execute, and the row the worker was supposed to write is
 *      written.
 *
 * Step 2 is what a same-process test cannot show. It also proves Redis Streams
 * retains an event published before its consumer existed, which is what lets a
 * `web` deploy start a run while the `worker` service is still rolling.
 *
 * Neither run bills a provider, so the bundle can be the untouched production
 * one with no stubbing seam in it:
 *   - the *skipped* post has every stage `complete` in `stage_status`, so an
 *     unnamed run executes all six steps and each returns `skipped: true`;
 *   - the *gated* post has `research: "review"`, so the run reaches the review
 *     gate, writes the two columns the gate owns, and suspends there.
 * Between them the six steps run, a row is written, and both terminal states a
 * run can reach in the worker (success and suspended) are covered.
 *
 * Redis database 9 isolates this suite: the bundle uses the production pubsub
 * config, so `keyPrefix` (which the other workflow suites use) is not available
 * to it, and a shared `workflows` topic would let another suite's workers
 * consume these runs and break the ordering above.
 *
 * Requires `docker compose up -d db redis`.
 */
import { execFile, spawn, type ChildProcessByStdio } from "node:child_process"
import { rm } from "node:fs/promises"
import path from "node:path"
import type { Readable } from "node:stream"
import { promisify } from "node:util"

import { Mastra } from "@mastra/core"
import { PostgresStore } from "@mastra/pg"
import { RedisStreamsPubSub } from "@mastra/redis-streams"
import { eq } from "drizzle-orm"
import { afterAll, beforeAll, describe, expect, it } from "vitest"

import { closeDb, getDb, getPool, posts } from "../../db"
import { STAGES, STATUS_COMPLETE, STATUS_REVIEW } from "../state"
import { imagesWorkflow } from "./images"
import { pipelineWorkflow } from "./pipeline"

const run = promisify(execFile)

const WEB_ROOT = path.resolve(__dirname, "../../..")
const BUNDLE_DIR = path.join(WEB_ROOT, ".mastra", "worker")

/** Redis database 9, whatever host the repo `.env` points at. */
function isolatedRedisUrl(): string {
  const url = new URL(process.env.REDIS_URL!)
  url.pathname = "/9"
  return url.toString()
}

const REDIS_URL = isolatedRedisUrl()

const SKIPPED_POST_ID = "00000000-0000-4000-8000-0000000004d1"
const GATED_POST_ID = "00000000-0000-4000-8000-0000000004d2"

const db = getDb()

/**
 * The `web` side: registers the same workflows against the same Postgres and
 * the same Redis, and never calls `startWorkers()`. Everything it can observe
 * about a run it reads back out of storage.
 */
const pubsub = new RedisStreamsPubSub({ url: REDIS_URL })
const storage = new PostgresStore({ id: "worker-process-test", pool: getPool() })
const webMastra = new Mastra({
  storage,
  pubsub,
  workflows: { pipeline: pipelineWorkflow, images: imagesWorkflow },
})

/**
 * Reached through the instance rather than through the module-level export, so
 * every read below provably goes via the registration `web` would use.
 */
const workflow = webMastra.getWorkflow("pipeline")

/** `stdio: ["ignore", "pipe", "pipe"]`: no stdin, two readable pipes. */
type WorkerProcess = ChildProcessByStdio<null, Readable, Readable>

type RunState = Awaited<ReturnType<typeof workflow.getWorkflowRunById>>

let worker: WorkerProcess
let workerStdout = ""
let workerStderr = ""
let workerExit: Promise<number | null>

let buildOutput: string
let startAsyncMs: number
let skippedRunId: string
let gatedRunId: string

/** Run state and post row a few seconds after `startAsync`, before any worker. */
let beforeWorker: {
  skipped: RunState
  gated: RunState
  skippedRow: typeof posts.$inferSelect
  gatedRow: typeof posts.$inferSelect
}
/** The same, once the worker has settled both runs. */
let afterWorker: {
  skipped: RunState
  gated: RunState
  skippedRow: typeof posts.$inferSelect
  gatedRow: typeof posts.$inferSelect
}

function seedValues(postId: string, stageStatus: Record<string, string>, stageSettings: Record<string, string>) {
  return {
    id: postId,
    slug: `worker-process-${postId.slice(-3)}`,
    topic: "composable pipelines",
    currentStage: "pending",
    stageSettings,
    stageStatus,
  }
}

async function readPost(postId: string) {
  const [row] = await db.select().from(posts).where(eq(posts.id, postId))
  return row
}

/** Resolves once `predicate` holds for the persisted run, or throws on timeout. */
async function waitForRun(runId: string, predicate: (state: RunState) => boolean, timeoutMs: number) {
  const deadline = Date.now() + timeoutMs
  for (;;) {
    const state = await workflow.getWorkflowRunById(runId)
    if (predicate(state)) return state
    if (Date.now() > deadline) {
      throw new Error(`run ${runId} never matched: last status ${state?.status ?? "(no run row)"}`)
    }
    await new Promise((resolve) => setTimeout(resolve, 200))
  }
}

function settled(state: RunState): boolean {
  return state !== null && state.status !== "running" && state.status !== "pending"
}

beforeAll(async () => {
  // A leftover stream would let the worker replay an interrupted earlier run of
  // this suite against the same seeded post ids.
  await pubsub.clearTopic("workflows")
  await pubsub.clearTopic("workflows-finish")

  // From scratch every time. A left-over `.mastra/worker/node_modules` from an
  // earlier build resolves modules the current config no longer installs, which
  // is enough to hide a broken bundle behind a green run.
  await rm(BUNDLE_DIR, { recursive: true, force: true })
  const build = await run("pnpm", ["exec", "mastra", "worker", "build", "-o", ".mastra/worker"], {
    cwd: WEB_ROOT,
    maxBuffer: 16 * 1024 * 1024,
  })
  buildOutput = `${build.stdout}${build.stderr}`

  for (const postId of [SKIPPED_POST_ID, GATED_POST_ID]) {
    await db.delete(posts).where(eq(posts.id, postId))
  }
  const auto = Object.fromEntries(STAGES.map((stage) => [stage, "auto"]))
  await db
    .insert(posts)
    .values(
      seedValues(SKIPPED_POST_ID, Object.fromEntries(STAGES.map((s) => [s, STATUS_COMPLETE])), auto),
    )
  await db.insert(posts).values(seedValues(GATED_POST_ID, {}, { ...auto, research: STATUS_REVIEW }))

  await storage.init()

  const startedAt = Date.now()
  const skippedRun = await workflow.createRun()
  const skipped = await skippedRun.startAsync({ inputData: { postId: SKIPPED_POST_ID } })
  const gatedRun = await workflow.createRun()
  const gated = await gatedRun.startAsync({ inputData: { postId: GATED_POST_ID } })
  startAsyncMs = Date.now() - startedAt
  skippedRunId = skipped.runId
  gatedRunId = gated.runId

  // Long enough that "nothing executed" means the absence of a consumer rather
  // than a slow one: the whole skipped run takes well under a second once a
  // worker is listening.
  await new Promise((resolve) => setTimeout(resolve, 5_000))
  beforeWorker = {
    skipped: await workflow.getWorkflowRunById(skippedRunId),
    gated: await workflow.getWorkflowRunById(gatedRunId),
    skippedRow: await readPost(SKIPPED_POST_ID),
    gatedRow: await readPost(GATED_POST_ID),
  }

  // `NODE_PATH` is deleted, not inherited. Vitest sets it to pnpm's flat
  // virtual store, which would let the bundle resolve any package installed
  // anywhere in this repo. A deploy has no such path, so inheriting it turns a
  // bundle that cannot boot on Railway into a green test: it is what hid the
  // missing `sharp` external the first time this suite was written.
  const workerEnv: NodeJS.ProcessEnv = { ...process.env, REDIS_URL, NODE_ENV: "production" }
  delete workerEnv.NODE_PATH

  worker = spawn(process.execPath, ["index.mjs"], {
    cwd: BUNDLE_DIR,
    stdio: ["ignore", "pipe", "pipe"],
    env: workerEnv,
  })
  worker.stdout.setEncoding("utf8")
  worker.stdout.on("data", (chunk: string) => {
    workerStdout += chunk
  })
  worker.stderr.setEncoding("utf8")
  worker.stderr.on("data", (chunk: string) => {
    workerStderr += chunk
  })
  workerExit = new Promise((resolve) => worker.once("exit", resolve))

  await waitForRun(skippedRunId, settled, 120_000)
  await waitForRun(gatedRunId, (state) => state?.status === "suspended", 120_000)
  afterWorker = {
    skipped: await workflow.getWorkflowRunById(skippedRunId),
    gated: await workflow.getWorkflowRunById(gatedRunId),
    skippedRow: await readPost(SKIPPED_POST_ID),
    gatedRow: await readPost(GATED_POST_ID),
  }

  worker.kill("SIGTERM")
  await workerExit
}, 300_000)

afterAll(async () => {
  worker?.kill("SIGKILL")
  for (const postId of [SKIPPED_POST_ID, GATED_POST_ID]) {
    await db.delete(posts).where(eq(posts.id, postId))
  }
  await pubsub.clearTopic("workflows")
  await pubsub.clearTopic("workflows-finish")
  await pubsub.close()
  await closeDb()
})

describe("the worker service executes runs that web starts", () => {
  it("builds the deployable worker bundle from the shared Mastra entry point", () => {
    expect(buildOutput).toContain("Worker build complete.")
    expect(buildOutput).toContain("mastra worker start")
  })

  it("boots the bundle and shuts it down on SIGTERM", async () => {
    // The CLI's generated entry prints these around `startWorkers()` and
    // `stopWorkers()`, so together they say the worker came up and went down
    // deliberately rather than being killed mid-flight.
    expect(workerStdout).toContain("[mastra] Workers started")
    expect(workerStdout).toContain("[mastra] Shutting down workers...")
    expect(await workerExit).toBe(0)
  })

  it("returns from startAsync without waiting for the run", () => {
    expect(skippedRunId).toMatch(/^[0-9a-f-]{36}$/)
    expect(gatedRunId).toMatch(/^[0-9a-f-]{36}$/)
    // Two publishes and two run rows. Generous, because it only has to exclude
    // "waited for the pipeline", and the pipeline cannot finish in a second.
    expect(startAsyncMs).toBeLessThan(5_000)
  })

  it("executes nothing while no worker is running", () => {
    expect(settled(beforeWorker.skipped)).toBe(false)
    expect(settled(beforeWorker.gated)).toBe(false)
    // The gate's two columns are the only thing either run writes, so an
    // untouched pair of rows is the whole "nothing happened" assertion.
    expect(beforeWorker.gatedRow.stageStatus).toEqual({})
    expect(beforeWorker.gatedRow.currentStage).toBe("pending")
    expect(beforeWorker.skippedRow.currentStage).toBe("pending")
  })

  it("runs the six steps to completion once the worker consumes the event", () => {
    expect(afterWorker.skipped?.status).toBe("success")
    const steps = Object.keys(afterWorker.skipped?.steps ?? {})
    for (const stage of STAGES) {
      expect(steps).toContain(stage)
    }
  })

  it("writes the gate's columns from the worker process, then suspends there", () => {
    expect(afterWorker.gated?.status).toBe("suspended")
    expect(afterWorker.gated?.suspendedPaths).toMatchObject({ research: expect.anything() })
    // Written by the worker: this process never executed a step.
    expect(afterWorker.gatedRow.stageStatus).toEqual({ research: STATUS_REVIEW })
    expect(afterWorker.gatedRow.currentStage).toBe("research")
  })

  /**
   * No stage ran, so no content column moved. `current_stage` and
   * `completed_at` do move, because the `pipeline-complete` step at the tail of
   * the chain (item 4.7b) stamps a finished full run whether or not that run
   * had anything left to do, the way Python's `_post_completion_hook` sat
   * outside the stage loop.
   */
  it("writes no content for the skipped post, because every stage was already complete", () => {
    expect(afterWorker.skippedRow.researchContent).toBeNull()
    expect(afterWorker.skippedRow.readyContent).toBeNull()
    expect(afterWorker.skippedRow.currentStage).toBe("complete")
    expect(afterWorker.skippedRow.completedAt).toBeInstanceOf(Date)
  })

  it("reports nothing on the worker's stderr", () => {
    expect(workerStderr).toBe("")
  })
})
