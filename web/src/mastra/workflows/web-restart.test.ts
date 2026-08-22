// @vitest-environment node
/**
 * Item 4.4b: restarting `web` does not disturb an in-flight pipeline.
 *
 * Item 4.4a proved the negative half of the split, that `web` executes nothing.
 * This is the positive half: the process that starts a run is disposable. A
 * Railway deploy replaces the `web` container while runs are in flight, so the
 * three things below have to hold, and none of them can be shown from inside a
 * single long-lived test process.
 *
 *   1. A run started by a `web` process that has since exited still runs to
 *      completion.
 *   2. A run parked at a review gate survives a `web` restart untouched, and a
 *      freshly started `web` sees it exactly where the worker left it.
 *   3. A run started by a `web` process that is then hard-killed (SIGKILL, no
 *      graceful shutdown, which is what a container replacement looks like)
 *      still runs to completion, and the worker never restarts.
 *
 * The `web` side is a real separate process: `web-service.fixture.mjs` loads
 * the built bundle's Mastra instance, the same `src/mastra/index.ts` the worker
 * runs, and does the only three things the `web` service does with Mastra
 * (`createRun`, `startAsync`, `getWorkflowRunById`). It never calls
 * `startWorkers()`.
 *
 * Ordering for claim 1 is guaranteed by construction rather than by a sleep:
 * the runs are started while no worker process exists anywhere, so nothing can
 * have executed before `web` exited. The worker is spawned only after that exit
 * has been observed.
 *
 * No run bills a provider, so the bundle is the untouched production one:
 *   - the two *skipped* posts have every stage `complete` in `stage_status`,
 *     so all six steps run and each returns `skipped: true`;
 *   - the *gated* post has `research` complete and `outline` set to `review`,
 *     so the run skips one stage, reaches the gate, writes the two columns the
 *     gate owns, and suspends there.
 *
 * Redis database 10 isolates this suite. The bundle uses the production pubsub
 * config, so `keyPrefix` is not available to it, and database 9 belongs to
 * `worker-process.test.ts`, whose workers would otherwise consume these runs.
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

const runCommand = promisify(execFile)

const WEB_ROOT = path.resolve(__dirname, "../../..")
const BUNDLE_DIR = path.join(WEB_ROOT, ".mastra", "worker-restart")
const BUNDLE_MASTRA = path.join(BUNDLE_DIR, "mastra.mjs")
const WEB_FIXTURE = path.join(WEB_ROOT, "src", "mastra", "workflows", "web-service.fixture.mjs")

/** Redis database 10, whatever host the repo `.env` points at. */
function isolatedRedisUrl(): string {
  const url = new URL(process.env.REDIS_URL!)
  url.pathname = "/10"
  return url.toString()
}

const REDIS_URL = isolatedRedisUrl()

/** Every stage complete: six skipped steps and a `success` run. */
const SKIPPED_POST_ID = "00000000-0000-4000-8000-0000000004e1"
/** `research` complete, `outline` gated: one skipped step then a suspend. */
const GATED_POST_ID = "00000000-0000-4000-8000-0000000004e2"
/** Every stage complete, started by the restarted `web`. */
const RESTARTED_POST_ID = "00000000-0000-4000-8000-0000000004e3"

const db = getDb()

/**
 * The observer. Registers the same workflows against the same Postgres and the
 * same Redis, and never calls `startWorkers()`, so every run state it reports
 * was produced by the worker process.
 */
const pubsub = new RedisStreamsPubSub({ url: REDIS_URL })
const storage = new PostgresStore({ id: "web-restart-test", pool: getPool() })
const observer = new Mastra({
  storage,
  pubsub,
  workflows: { pipeline: pipelineWorkflow, images: imagesWorkflow },
})
const workflow = observer.getWorkflow("pipeline")

/** `stdio: ["ignore", "pipe", "pipe"]`: no stdin, two readable pipes. */
type ChildWithPipes = ChildProcessByStdio<null, Readable, Readable>
type RunState = Awaited<ReturnType<typeof workflow.getWorkflowRunById>>
type Exit = { code: number | null; signal: NodeJS.Signals | null }

type Spawned = {
  child: ChildWithPipes
  stdout: () => string
  stderr: () => string
  /** Resolves with the first complete line the child writes to stdout. */
  firstLine: Promise<string>
  exit: Promise<Exit>
}

/** What `web-service.fixture.mjs` prints. */
type WebOutput = {
  started: { postId: string; runId: string }[]
  read: { runId: string; status: string | null; suspendedPaths: unknown; steps: string[] }[]
}

/**
 * `NODE_PATH` is deleted, not inherited. Vitest sets it to pnpm's flat virtual
 * store, which would let a child resolve any package installed anywhere in this
 * repo; a deploy has no such path. Item 4.4a found a bundle that could not boot
 * hiding behind exactly that inheritance.
 */
function deployEnv(): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = { ...process.env, REDIS_URL, NODE_ENV: "production" }
  delete env.NODE_PATH
  return env
}

function watch(child: ChildWithPipes): Spawned {
  let out = ""
  let err = ""
  let resolveLine: (line: string) => void
  const firstLine = new Promise<string>((resolve) => {
    resolveLine = resolve
  })
  child.stdout.setEncoding("utf8")
  child.stdout.on("data", (chunk: string) => {
    out += chunk
    const end = out.indexOf("\n")
    if (end !== -1) resolveLine(out.slice(0, end))
  })
  child.stderr.setEncoding("utf8")
  child.stderr.on("data", (chunk: string) => {
    err += chunk
  })
  const exit = new Promise<Exit>((resolve) => {
    child.once("exit", (code, signal) => resolve({ code, signal }))
  })
  return { child, stdout: () => out, stderr: () => err, firstLine, exit }
}

/** One `web` process, running the bundled Mastra instance. */
function spawnWeb(spec: Record<string, unknown>): Spawned {
  return watch(
    spawn(process.execPath, [WEB_FIXTURE, BUNDLE_MASTRA, JSON.stringify(spec)], {
      cwd: WEB_ROOT,
      stdio: ["ignore", "pipe", "pipe"],
      env: deployEnv(),
    }) as ChildWithPipes,
  )
}

function seedValues(postId: string, stageStatus: Record<string, string>, stageSettings: Record<string, string>) {
  return {
    id: postId,
    slug: `web-restart-${postId.slice(-3)}`,
    topic: "durable pipelines",
    currentStage: "pending",
    stageSettings,
    stageStatus,
  }
}

async function readPost(postId: string) {
  const [row] = await db.select().from(posts).where(eq(posts.id, postId))
  return row
}

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

let buildOutput: string

let worker: Spawned
let workerSpawnedAt: number
/** Captured once, so a worker that died and came back is visible as a new pid. */
let workerPid: number | undefined

/** The `web` process that starts the first two runs and exits on its own. */
let webA: WebOutput
let webAExit: Exit
let webAExitedAt: number

/** The restarted `web`: reads the settled runs, starts a third, is SIGKILLed. */
let webB: WebOutput
let webBExit: Exit

let skippedRunId: string
let gatedRunId: string
let restartedRunId: string

let beforeWorker: { skipped: RunState; gated: RunState; gatedRow: typeof posts.$inferSelect }
let afterWorker: { skipped: RunState; gated: RunState; gatedRow: typeof posts.$inferSelect }
let afterRestart: { gated: RunState; restarted: RunState; gatedRow: typeof posts.$inferSelect }

beforeAll(async () => {
  // A leftover stream would let the worker replay an interrupted earlier run of
  // this suite against the same seeded post ids.
  await pubsub.clearTopic("workflows")
  await pubsub.clearTopic("workflows-finish")

  // From scratch every time: a left-over `node_modules` from an earlier build
  // resolves modules the current config no longer installs, which is enough to
  // hide a broken bundle behind a green run.
  await rm(BUNDLE_DIR, { recursive: true, force: true })
  const build = await runCommand("pnpm", ["exec", "mastra", "worker", "build", "-o", ".mastra/worker-restart"], {
    cwd: WEB_ROOT,
    maxBuffer: 16 * 1024 * 1024,
  })
  buildOutput = `${build.stdout}${build.stderr}`

  const allComplete = Object.fromEntries(STAGES.map((stage) => [stage, STATUS_COMPLETE]))
  const auto = Object.fromEntries(STAGES.map((stage) => [stage, "auto"]))
  for (const postId of [SKIPPED_POST_ID, GATED_POST_ID, RESTARTED_POST_ID]) {
    await db.delete(posts).where(eq(posts.id, postId))
  }
  await db.insert(posts).values(seedValues(SKIPPED_POST_ID, allComplete, auto))
  await db
    .insert(posts)
    .values(seedValues(GATED_POST_ID, { research: STATUS_COMPLETE }, { ...auto, outline: STATUS_REVIEW }))
  await db.insert(posts).values(seedValues(RESTARTED_POST_ID, allComplete, auto))

  await storage.init()

  // Phase 1: a `web` process starts two runs and exits. No worker exists yet,
  // so its exit provably precedes any execution.
  const first = spawnWeb({ start: [SKIPPED_POST_ID, GATED_POST_ID] })
  webAExit = await first.exit
  webAExitedAt = Date.now()
  webA = JSON.parse(first.stdout()) as WebOutput
  skippedRunId = webA.started[0].runId
  gatedRunId = webA.started[1].runId

  // Long enough that "nothing executed" means the absence of a consumer rather
  // than a slow one: both runs settle in well under a second once a worker is
  // listening.
  await new Promise((resolve) => setTimeout(resolve, 3_000))
  beforeWorker = {
    skipped: await workflow.getWorkflowRunById(skippedRunId),
    gated: await workflow.getWorkflowRunById(gatedRunId),
    gatedRow: await readPost(GATED_POST_ID),
  }

  worker = watch(
    spawn(process.execPath, ["index.mjs"], {
      cwd: BUNDLE_DIR,
      stdio: ["ignore", "pipe", "pipe"],
      env: deployEnv(),
    }) as ChildWithPipes,
  )
  workerSpawnedAt = Date.now()
  workerPid = worker.child.pid

  await waitForRun(skippedRunId, settled, 120_000)
  await waitForRun(gatedRunId, (state) => state?.status === "suspended", 120_000)
  afterWorker = {
    skipped: await workflow.getWorkflowRunById(skippedRunId),
    gated: await workflow.getWorkflowRunById(gatedRunId),
    gatedRow: await readPost(GATED_POST_ID),
  }

  // Phase 2: the deploy. A fresh `web` process reads the in-flight run, starts
  // one of its own, and is then killed without a chance to shut down.
  const second = spawnWeb({
    start: [RESTARTED_POST_ID],
    read: [skippedRunId, gatedRunId],
    hold: true,
  })
  await second.firstLine
  webB = JSON.parse(second.stdout()) as WebOutput
  restartedRunId = webB.started[0].runId
  second.child.kill("SIGKILL")
  webBExit = await second.exit

  await waitForRun(restartedRunId, settled, 120_000)
  afterRestart = {
    gated: await workflow.getWorkflowRunById(gatedRunId),
    restarted: await workflow.getWorkflowRunById(restartedRunId),
    gatedRow: await readPost(GATED_POST_ID),
  }
}, 300_000)

afterAll(async () => {
  worker?.child.kill("SIGTERM")
  await worker?.exit
  for (const postId of [SKIPPED_POST_ID, GATED_POST_ID, RESTARTED_POST_ID]) {
    await db.delete(posts).where(eq(posts.id, postId))
  }
  await pubsub.clearTopic("workflows")
  await pubsub.clearTopic("workflows-finish")
  await pubsub.close()
  await closeDb()
})

describe("restarting web does not disturb an in-flight pipeline", () => {
  it("builds the deployable worker bundle from the shared Mastra entry point", () => {
    expect(buildOutput).toContain("Worker build complete.")
    expect(buildOutput).toContain("--dir .mastra/worker-restart")
  })

  it("starts the runs from a web process that then exits, before anything executes", () => {
    expect(webAExit).toEqual({ code: 0, signal: null })
    expect(webAExitedAt).toBeLessThan(workerSpawnedAt)
    expect(settled(beforeWorker.skipped)).toBe(false)
    expect(settled(beforeWorker.gated)).toBe(false)
    // The gate's two columns are all either run writes, so untouched columns
    // are the whole "nothing happened yet" assertion.
    expect(beforeWorker.gatedRow.stageStatus).toEqual({ research: STATUS_COMPLETE })
    expect(beforeWorker.gatedRow.currentStage).toBe("pending")
  })

  it("runs the pipeline to completion in the worker although its starter is gone", () => {
    expect(afterWorker.skipped?.status).toBe("success")
    const steps = Object.keys(afterWorker.skipped?.steps ?? {})
    for (const stage of STAGES) {
      expect(steps).toContain(stage)
    }
  })

  it("parks the gated run in flight, written by the worker", () => {
    expect(afterWorker.gated?.status).toBe("suspended")
    expect(afterWorker.gated?.suspendedPaths).toMatchObject({ outline: expect.anything() })
    expect(afterWorker.gatedRow.stageStatus).toEqual({
      research: STATUS_COMPLETE,
      outline: STATUS_REVIEW,
    })
    expect(afterWorker.gatedRow.currentStage).toBe("outline")
  })

  it("lets a restarted web read the in-flight run exactly where the worker left it", () => {
    const gated = webB.read.find((entry) => entry.runId === gatedRunId)
    expect(gated?.status).toBe("suspended")
    expect(gated?.suspendedPaths).toEqual(afterWorker.gated?.suspendedPaths)
    const skipped = webB.read.find((entry) => entry.runId === skippedRunId)
    expect(skipped?.status).toBe("success")
  })

  it("completes a run whose web process was killed without a shutdown", () => {
    expect(webBExit).toEqual({ code: null, signal: "SIGKILL" })
    expect(afterRestart.restarted?.status).toBe("success")
    const steps = Object.keys(afterRestart.restarted?.steps ?? {})
    for (const stage of STAGES) {
      expect(steps).toContain(stage)
    }
  })

  it("leaves the parked run untouched across the restart", () => {
    expect(afterRestart.gated?.status).toBe("suspended")
    expect(afterRestart.gated?.suspendedPaths).toEqual(afterWorker.gated?.suspendedPaths)
    expect(afterRestart.gatedRow.stageStatus).toEqual(afterWorker.gatedRow.stageStatus)
    expect(afterRestart.gatedRow.currentStage).toBe(afterWorker.gatedRow.currentStage)
    // A rewritten row would move `updated_at`, so an equal timestamp says the
    // restart caused no write at all rather than an idempotent one.
    expect(afterRestart.gatedRow.updatedAt?.toISOString()).toBe(afterWorker.gatedRow.updatedAt?.toISOString())
  })

  it("never restarts the worker and reports nothing on its stderr", () => {
    expect(worker.child.exitCode).toBeNull()
    // Same process throughout: the worker that finished the last run is the one
    // that was already executing before `web` was replaced.
    expect(worker.child.pid).toBe(workerPid)
    expect(worker.stdout().match(/\[mastra\] Workers started/g)).toHaveLength(1)
    expect(worker.stderr()).toBe("")
  })
})
