// @vitest-environment node
/**
 * Ledger item 4.5a: does the built-in evented engine survive the death of the
 * process executing a step?
 *
 * The durability gate (4.5) asks for a pipeline killed mid-`write` that resumes
 * from the last completed stage. That run bills a provider and takes minutes,
 * so it is a scripted procedure in 4.5b. The property it depends on, though, is
 * a property of the engine and the Redis Streams transport, not of the
 * pipeline, and it can be proven for free. That is what this suite does, and
 * being free it can stay in the suite as a regression test.
 *
 * The claim under test, stated so it can fail:
 *
 *   A step that was executing when its worker was `SIGKILL`ed is redelivered to
 *   a later worker in the same consumer group and runs again to completion,
 *   while a step that had already completed is not re-executed and its
 *   persisted result is not rewritten.
 *
 * Why it holds, read out of the installed packages rather than assumed:
 *   - `OrchestrationWorker` subscribes to the `workflows` topic with the fixed
 *     group `mastra-orchestration` (worker-BeL6789j.js), so a restarted worker
 *     joins the same group as the dead one and inherits its pending entries.
 *   - `WorkflowEventProcessor.handle` awaits `processWorkflowStepRun` and the
 *     transport acks only on `{ ok: true }`, so a `workflow.step.run` message
 *     stays pending for the whole of the step body.
 *   - `RedisStreamsPubSub` runs `XAUTOCLAIM` on a timer for grouped
 *     subscriptions, defaulting to `reclaimIdleMs` 60s and `reclaimIntervalMs`
 *     30s, which is what hands the dead consumer's pending message to a live
 *     sibling.
 *
 * The recovery is therefore not instant, and the latency is part of what this
 * suite records: with the defaults, a killed step waits between 60 and 90
 * seconds before another worker picks it up.
 *
 * Everything runs against `crash-probe.fixture.mjs`, a two-step workflow that
 * touches no provider, no post row and no media directory. The same factory
 * builds the instance on both sides, so the graph the test publishes is the
 * graph the worker executes. Redis database 11 isolates the suite from
 * `worker-process.test.ts` (9) and `web-restart.test.ts` (10), which matters
 * because all three share the `workflows` topic name and a stray worker would
 * consume this run before it could be abandoned.
 *
 * Requires `docker compose up -d db redis`.
 */
import { spawn, type ChildProcessByStdio } from "node:child_process"
import { randomUUID } from "node:crypto"
import { rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import path from "node:path"
import type { Readable } from "node:stream"

import { afterAll, beforeAll, describe, expect, it } from "vitest"

import { createProbeMastra, readProbeRecords } from "./crash-probe.fixture.mjs"

const WEB_ROOT = path.resolve(__dirname, "../../..")
const FIXTURE = path.join(WEB_ROOT, "src", "mastra", "workflows", "crash-probe.fixture.mjs")

/** Redis database 11, whatever host the repo `.env` points at. */
function isolatedRedisUrl(): string {
  const url = new URL(process.env.REDIS_URL!)
  url.pathname = "/11"
  return url.toString()
}

const REDIS_URL = isolatedRedisUrl()
const MARKER_FILE = path.join(tmpdir(), `crash-probe-${randomUUID()}.jsonl`)

/**
 * Long enough that the kill lands well inside the step body and short enough
 * that it is not what the suite spends its time on: the ~70s reclaim wait
 * dominates either way.
 */
const SLEEP_MS = 15_000

const { workflow, pubsub, storage } = createProbeMastra({
  redisUrl: REDIS_URL,
  databaseUrl: process.env.DATABASE_URL_SYNC ?? process.env.DATABASE_URL,
  markerFile: MARKER_FILE,
  sleepMs: SLEEP_MS,
})

type WorkerProcess = ChildProcessByStdio<null, Readable, Readable>
type RunState = Awaited<ReturnType<typeof workflow.getWorkflowRunById>>
type ProbeRecord = { step: string; phase: string; label: string; pid: number; at: string }
/**
 * The persisted shape of one step. `RunState["steps"]` widens to include the
 * array form a `.foreach()` step produces, which this two-step workflow has
 * none of, so narrow once here rather than at every assertion.
 */
type StepRecord = { status: string; output?: unknown; payload?: unknown }

let workerA: WorkerProcess
let workerB: WorkerProcess
let runId: string

/** Records and run state at the instant worker A was killed. */
let atKill: { records: ProbeRecord[]; state: RunState }
/** The same once worker B has settled the run. */
let afterRestart: { records: ProbeRecord[]; state: RunState }

let killedAt: number
let workerBSpawnedAt: number

function stepsOf(state: RunState): Record<string, StepRecord | undefined> {
  return (state?.steps ?? {}) as Record<string, StepRecord | undefined>
}

function records(): ProbeRecord[] {
  return readProbeRecords(MARKER_FILE) as ProbeRecord[]
}

function matching(all: ProbeRecord[], step: string, phase: string): ProbeRecord[] {
  return all.filter((entry) => entry.step === step && entry.phase === phase)
}

/** Spawns the fixture as a worker process and resolves once it has subscribed. */
async function spawnWorker(): Promise<WorkerProcess> {
  const child = spawn(process.execPath, [FIXTURE], {
    cwd: WEB_ROOT,
    stdio: ["ignore", "pipe", "pipe"],
    env: {
      ...process.env,
      PROBE_REDIS_URL: REDIS_URL,
      PROBE_MARKER_FILE: MARKER_FILE,
      PROBE_SLEEP_MS: String(SLEEP_MS),
    },
  }) as WorkerProcess
  child.stdout.setEncoding("utf8")
  child.stderr.setEncoding("utf8")
  let stderr = ""
  child.stderr.on("data", (chunk: string) => {
    stderr += chunk
  })
  await new Promise<void>((resolve, reject) => {
    child.stdout.on("data", (chunk: string) => {
      if (chunk.includes("workers started")) resolve()
    })
    child.once("exit", (code) => reject(new Error(`worker exited early (${code}): ${stderr}`)))
    setTimeout(() => reject(new Error(`worker never subscribed: ${stderr}`)), 60_000)
  })
  return child
}

async function waitFor(predicate: () => boolean | Promise<boolean>, timeoutMs: number, what: string) {
  const deadline = Date.now() + timeoutMs
  for (;;) {
    if (await predicate()) return
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${what}`)
    await new Promise((resolve) => setTimeout(resolve, 250))
  }
}

beforeAll(async () => {
  // A leftover stream would carry this suite's own pending entries from an
  // interrupted earlier run, and worker A would reclaim them.
  await pubsub.clearTopic("workflows")
  await pubsub.clearTopic("workflows-finish")
  await rm(MARKER_FILE, { force: true })
  await storage.init()

  workerA = await spawnWorker()

  const run = await workflow.createRun()
  runId = (await run.startAsync({ inputData: { label: "crash-probe" } })).runId

  await waitFor(
    () => matching(records(), "probe-slow", "start").length === 1,
    60_000,
    "probe-slow to start under worker A",
  )
  // A moment inside the sleep, so the kill is unambiguously mid-step rather
  // than racing the record write.
  await new Promise((resolve) => setTimeout(resolve, 1_000))

  killedAt = Date.now()
  workerA.kill("SIGKILL")
  atKill = { records: records(), state: await workflow.getWorkflowRunById(runId) }

  workerBSpawnedAt = Date.now()
  workerB = await spawnWorker()

  await waitFor(
    async () => {
      const state = await workflow.getWorkflowRunById(runId)
      return state !== null && state.status !== "running" && state.status !== "pending"
    },
    180_000,
    "the run to settle under worker B",
  )
  afterRestart = { records: records(), state: await workflow.getWorkflowRunById(runId) }

  workerB.kill("SIGTERM")
}, 300_000)

afterAll(async () => {
  workerA?.kill("SIGKILL")
  workerB?.kill("SIGKILL")
  await rm(MARKER_FILE, { force: true })
  await pubsub.clearTopic("workflows")
  await pubsub.clearTopic("workflows-finish")
  await pubsub.close()
  await storage.close()
})

describe("a step whose worker is killed mid-execution", () => {
  it("was genuinely in flight when the worker died", () => {
    // One `probe-slow` start and no finish: the step body was between its two
    // records, which is the only state in which the claim means anything.
    expect(matching(atKill.records, "probe-slow", "start")).toHaveLength(1)
    expect(matching(atKill.records, "probe-slow", "done")).toHaveLength(0)
    expect(atKill.records[0].pid).toBe(workerA.pid)
    expect(atKill.state?.status).toBe("running")
  })

  it("has persisted the completed step and no trace of the running one", () => {
    expect(stepsOf(atKill.state)["probe-first"]?.status).toBe("success")
    // The snapshot carries no record of a step until it finishes. So storage
    // cannot tell anyone which step died with the worker, and a startup sweep
    // over storage (the ledger's first fallback) would have nothing to resume
    // from. Recovery here is the Redis pending-entries list, not the snapshot.
    expect(stepsOf(atKill.state)).not.toHaveProperty("probe-slow")
  })

  it("is redelivered to the restarted worker and the run reaches success", () => {
    expect(afterRestart.state?.status).toBe("success")
    expect(workerB.pid).not.toBe(workerA.pid)
    const restarted = matching(afterRestart.records, "probe-slow", "start")
    expect(restarted).toHaveLength(2)
    expect(restarted[1].pid).toBe(workerB.pid)
  })

  it("runs the interrupted step body exactly once to completion", () => {
    const finished = matching(afterRestart.records, "probe-slow", "done")
    expect(finished).toHaveLength(1)
    expect(finished[0].pid).toBe(workerB.pid)
  })

  it("does not re-execute the step that had already completed", () => {
    // The heart of the gate: worker B must resume the run, not restart it.
    const first = matching(afterRestart.records, "probe-first", "done")
    expect(first).toHaveLength(1)
    expect(first[0].pid).toBe(workerA.pid)
  })

  it("does not rewrite the completed step's persisted result", () => {
    // Equality of the whole record, timestamps included, is what separates "no
    // write happened" from "an identical write happened again".
    expect(stepsOf(afterRestart.state)["probe-first"]).toEqual(stepsOf(atKill.state)["probe-first"])
  })

  it("feeds the completed step's output into the resumed step", () => {
    // Resume, not restart: worker B executed `probe-slow` against the payload
    // worker A's `probe-first` produced before it died.
    const steps = stepsOf(afterRestart.state)
    expect(steps["probe-first"]?.output).toEqual(steps["probe-slow"]?.payload)
  })

  it("recovers on the XAUTOCLAIM timer rather than immediately", () => {
    const redelivered = matching(afterRestart.records, "probe-slow", "start")[1]
    const latencyMs = Date.parse(redelivered.at) - killedAt
    // Recorded, not tuned: `reclaimIdleMs` 60s measured from the original
    // delivery plus a `reclaimIntervalMs` 30s tick. A number outside this band
    // means the defaults moved and the ledger's stated recovery window is
    // stale, which is worth failing over.
    expect(latencyMs).toBeGreaterThan(55_000)
    expect(latencyMs).toBeLessThan(120_000)
    expect(workerBSpawnedAt).toBeGreaterThanOrEqual(killedAt)
  })
})
