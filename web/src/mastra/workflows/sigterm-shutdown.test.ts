// @vitest-environment node
/**
 * Ledger item P2.91: a graceful stop has to drain the work, not just the reader.
 *
 * P2.21 measured what the generated worker entry does to a step that is
 * executing when the signal lands:
 *
 *     const shutdown = async () => {
 *       console.log('[mastra] Shutting down workers...');
 *       await mastra.stopWorkers();
 *       process.exit(0);
 *     };
 *     process.on('SIGINT', shutdown);
 *     process.on('SIGTERM', shutdown);
 *
 * (`WorkerBundler.getEntry()` in `mastra/dist/index.js`, reproduced verbatim in
 * `.mastra/worker/index.mjs`, which is the `worker` service's start command in
 * both `web/Dockerfile` and `.railway/railway.ts`.)
 *
 * The answer was that it drains the reader and not the work: nothing in
 * `Mastra.stopWorkers()`, `PullTransport.stop()` or
 * `RedisStreamsPubSub.unsubscribe()` holds a handle on a running step body, so
 * `process.exit(0)` truncated the step exactly as a `SIGKILL` would and the
 * step's message stayed pending until `XAUTOCLAIM`. This app sets
 * `reclaimIdleMs` to 15 minutes (`RECLAIM_IDLE_MS` in `src/mastra/index.ts`,
 * deliberately wider than the slowest stage, see `reclaim-duplication.test.ts`),
 * so a routine redeploy parked the in-flight post for over fifteen minutes and
 * then re-ran and re-billed that stage.
 *
 * `DrainingPubSub` closes the hole at the transport seam, which is where the
 * only handle on the work exists: an unsubscribe does not resolve until the
 * deliveries that subscription is still holding have been acked or nacked, or
 * until `WORKER_DRAIN_TIMEOUT_MS` runs out. `stopWorkers()` calls unsubscribe,
 * so the generated entry drains without knowing it does.
 *
 * Two scenarios, because a drain that is not bounded is a worse defect than the
 * one it fixes: the step that finishes inside the deadline (the redeploy costs
 * the run nothing but the gap between processes), and the step that does not
 * (the worker still exits, and P2.91b hands that step's message back to the
 * group on the way out so a replacement takes it at once rather than after the
 * reclaim window).
 *
 * The probe workflow touches no provider, no post row and no media directory.
 * Redis database 7 isolates it from every other suite that starts a worker; all
 * of them share the `workflows` topic name and the `mastra-orchestration`
 * group, and a stray consumer on the same database would reclaim these events.
 *
 * Requires `docker compose up -d db redis`.
 */
import { spawn, type ChildProcessByStdio } from "node:child_process"
import { randomUUID } from "node:crypto"
import { rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import path from "node:path"
import type { Readable } from "node:stream"

import { createClient } from "redis"
import { afterAll, beforeAll, describe, expect, it } from "vitest"

import { isolatedRedisUrl } from "../../test/redis-databases"
import { ORCHESTRATION_GROUP, orchestrationStreamKey } from "../worker-health"
import { createProbeMastra, readProbeRecords } from "./crash-probe.fixture.mjs"

const WEB_ROOT = path.resolve(__dirname, "../../..")
const FIXTURE = path.join(WEB_ROOT, "src", "mastra", "workflows", "crash-probe.fixture.mjs")

const REDIS_URL = isolatedRedisUrl("src/mastra/workflows/sigterm-shutdown.test.ts")
const MARKER_FILE = path.join(tmpdir(), `sigterm-shutdown-${randomUUID()}.jsonl`)
const STREAM_KEY = orchestrationStreamKey()

/**
 * The step body of the scenario that finishes inside the drain: long enough
 * that the signal lands unambiguously in the middle of it, short enough that
 * the suite is not paying for the wait twice.
 */
const DRAINABLE_SLEEP_MS = 5_000

/**
 * The step body of the scenario that outlives the drain. Thirty seconds against
 * a one second deadline, so "the worker gave up and exited" cannot be confused
 * with "the step happened to finish".
 */
const UNDRAINABLE_SLEEP_MS = 30_000
const SHORT_DRAIN_TIMEOUT_MS = 1_000

/**
 * The drain the first scenario runs under: well past `DRAINABLE_SLEEP_MS`, so a
 * drain that ends on the deadline rather than on the step is a failure and not
 * a tight race. Kept under the suite-wide `testTimeout` as well, which is what
 * `src/test/wait-budgets.test.ts` reads it as.
 */
const LONG_DRAIN_TIMEOUT_MS = 30_000

const { workflow, pubsub, storage } = createProbeMastra({
  redisUrl: REDIS_URL,
  databaseUrl: process.env.DATABASE_URL_SYNC ?? process.env.DATABASE_URL,
  markerFile: MARKER_FILE,
  sleepMs: DRAINABLE_SLEEP_MS,
})

type WorkerProcess = ChildProcessByStdio<null, Readable, Readable>
type RunState = Awaited<ReturnType<typeof workflow.getWorkflowRunById>>
type ProbeRecord = { step: string; phase: string; label: string; pid: number; at: string }

/** One entry of the group's pending-entries list, plus the event it carries. */
type PendingEntry = {
  id: string
  consumer: string
  deliveriesCounter: number
  event: { type?: string; runId?: string }
}
type StreamEvent = { id: string; event: { type?: string; runId?: string; deliveryAttempt?: number } }
type TransportState = {
  pending: PendingEntry[]
  consumers: { name: string; pending: number }[]
  streamLength: number
  events: StreamEvent[]
}

const redis = createClient({ url: REDIS_URL })

const workers: WorkerProcess[] = []

/** The drained scenario, measured at four points. */
let drained: {
  runId: string
  workerPid: number
  inFlight: { transport: TransportState; records: ProbeRecord[] }
  exit: { code: number | null; signal: NodeJS.Signals | null }
  exitAfterMs: number
  stdout: string
  afterExit: { transport: TransportState; records: ProbeRecord[]; state: RunState }
  afterReplacement: { records: ProbeRecord[]; state: RunState }
}

/** The scenario whose step outlives the drain deadline. */
let expired: {
  runId: string
  workerPid: number
  inFlight: { transport: TransportState; records: ProbeRecord[] }
  exit: { code: number | null; signal: NodeJS.Signals | null }
  exitAfterMs: number
  afterExit: { transport: TransportState; records: ProbeRecord[]; state: RunState }
  afterReplacement: { records: ProbeRecord[]; state: RunState; recoveredAfterMs: number }
}

function records(label: string): ProbeRecord[] {
  return (readProbeRecords(MARKER_FILE) as ProbeRecord[]).filter((entry) => entry.label === label)
}

function matching(all: ProbeRecord[], step: string, phase: string): ProbeRecord[] {
  return all.filter((entry) => entry.step === step && entry.phase === phase)
}

/**
 * The group's pending-entries list with each entry's event body, the group's
 * consumers, and the stream's length. The length is what separates "left
 * pending" from "nacked": a nack republishes the event as a new entry and acks
 * the original, so it would both empty the list and grow the stream.
 */
async function readTransport(): Promise<TransportState> {
  const range = await redis.xPendingRange(STREAM_KEY, ORCHESTRATION_GROUP, "-", "+", 50)
  const pending: PendingEntry[] = []
  for (const entry of range) {
    const [message] = await redis.xRange(STREAM_KEY, entry.id, entry.id)
    pending.push({
      id: entry.id,
      consumer: String(entry.consumer),
      deliveriesCounter: Number(entry.deliveriesCounter),
      event: JSON.parse(message?.message?.event ?? "{}"),
    })
  }
  const consumers = (await redis.xInfoConsumers(STREAM_KEY, ORCHESTRATION_GROUP)).map((consumer) => ({
    name: String(consumer.name),
    pending: Number(consumer.pending),
  }))
  const events = (await redis.xRange(STREAM_KEY, "-", "+")).map((entry) => ({
    id: String(entry.id),
    event: JSON.parse(entry.message?.event ?? "{}"),
  }))
  return { pending, consumers, streamLength: await redis.xLen(STREAM_KEY), events }
}

/** Spawns the fixture as a worker process and resolves once it has subscribed. */
async function spawnWorker(env: Record<string, string>): Promise<WorkerProcess> {
  const child = spawn(process.execPath, [FIXTURE], {
    cwd: WEB_ROOT,
    stdio: ["ignore", "pipe", "pipe"],
    env: {
      ...process.env,
      PROBE_REDIS_URL: REDIS_URL,
      PROBE_MARKER_FILE: MARKER_FILE,
      // The whole point of this suite: handle SIGTERM the way the deployed
      // worker entry does, rather than letting the default action stop the
      // process outright.
      PROBE_GRACEFUL_SIGTERM: "1",
      ...env,
    },
  }) as WorkerProcess
  workers.push(child)
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

/** SIGKILL a worker the suite is finished with, and wait for it to be gone. */
async function stop(worker: WorkerProcess): Promise<void> {
  if (worker.exitCode !== null || worker.signalCode !== null) return
  const exited = new Promise<void>((resolve) => worker.once("exit", () => resolve()))
  worker.kill("SIGKILL")
  await exited
}

/** SIGTERM, and how long the handler took to reach its own `process.exit(0)`. */
async function terminate(worker: WorkerProcess) {
  const exited = new Promise<{ code: number | null; signal: NodeJS.Signals | null }>((resolve) => {
    worker.once("exit", (code, signal) => resolve({ code, signal }))
  })
  const startedAt = Date.now()
  worker.kill("SIGTERM")
  const exit = await exited
  return { exit, exitAfterMs: Date.now() - startedAt }
}

/** Starts a run and returns its id once its second step is executing. */
async function runToSlowStep(label: string): Promise<string> {
  const run = await workflow.createRun()
  const runId = (await run.startAsync({ inputData: { label } })).runId
  await waitFor(
    () => matching(records(label), "probe-slow", "start").length === 1,
    60_000,
    `probe-slow to start for ${label}`,
  )
  // A moment inside the sleep, so the signal is unambiguously mid-step rather
  // than racing the record write.
  await new Promise((resolve) => setTimeout(resolve, 500))
  return runId
}

beforeAll(async () => {
  await redis.connect()
  // A leftover stream would carry this suite's own pending entries from an
  // interrupted earlier run, and every assertion below counts them.
  await pubsub.clearTopic("workflows")
  await pubsub.clearTopic("workflows-finish")
  await redis.del(STREAM_KEY)
  await rm(MARKER_FILE, { force: true })
  await storage.init()

  // Scenario one: the step finishes inside the drain.
  const workerA = await spawnWorker({
    PROBE_SLEEP_MS: String(DRAINABLE_SLEEP_MS),
    WORKER_DRAIN_TIMEOUT_MS: String(LONG_DRAIN_TIMEOUT_MS),
  })
  let stdout = ""
  workerA.stdout.on("data", (chunk: string) => {
    stdout += chunk
  })
  const runId = await runToSlowStep("drain-completes")
  const inFlight = { transport: await readTransport(), records: records("drain-completes") }
  const { exit, exitAfterMs } = await terminate(workerA)
  const afterExit = {
    transport: await readTransport(),
    records: records("drain-completes"),
    state: await workflow.getWorkflowRunById(runId),
  }

  // The events the dying worker published on its way out have no consumer
  // until a replacement joins, which is the shape of a redeploy.
  const workerB = await spawnWorker({
    PROBE_SLEEP_MS: String(DRAINABLE_SLEEP_MS),
    WORKER_DRAIN_TIMEOUT_MS: String(LONG_DRAIN_TIMEOUT_MS),
  })
  await waitFor(
    async () => {
      const state = await workflow.getWorkflowRunById(runId)
      return state !== null && state.status !== "running" && state.status !== "pending"
    },
    60_000,
    "the run to finish under the replacement worker",
  )
  const afterReplacement = {
    records: records("drain-completes"),
    state: await workflow.getWorkflowRunById(runId),
  }
  await stop(workerB)
  // Scenario two counts the group's pending entries, and a worker killed while
  // it was mid-event would leave one of its own behind. Deleting the stream
  // takes the group with it, so the second scenario starts from nothing; the
  // replacement subscribes before its run is started, exactly as above.
  await pubsub.clearTopic("workflows")

  drained = {
    runId,
    workerPid: workerA.pid!,
    inFlight,
    exit,
    exitAfterMs,
    stdout,
    afterExit,
    afterReplacement,
  }

  // Scenario two: the step outlives the drain deadline.
  const workerC = await spawnWorker({
    PROBE_SLEEP_MS: String(UNDRAINABLE_SLEEP_MS),
    WORKER_DRAIN_TIMEOUT_MS: String(SHORT_DRAIN_TIMEOUT_MS),
  })
  const expiredRunId = await runToSlowStep("drain-expires")
  const expiredInFlight = { transport: await readTransport(), records: records("drain-expires") }
  const expiredTermination = await terminate(workerC)
  const expiredAfterExit = {
    transport: await readTransport(),
    records: records("drain-expires"),
    state: await workflow.getWorkflowRunById(expiredRunId),
  }

  // The replacement's own `probe-slow` is short: the question this scenario
  // asks is how long the run waits to be picked up again, not how long the
  // step takes once it is.
  const recoveryStartedAt = Date.now()
  const workerD = await spawnWorker({
    PROBE_SLEEP_MS: "500",
    WORKER_DRAIN_TIMEOUT_MS: String(LONG_DRAIN_TIMEOUT_MS),
  })
  await waitFor(
    async () => {
      const state = await workflow.getWorkflowRunById(expiredRunId)
      return state !== null && state.status !== "running" && state.status !== "pending"
    },
    60_000,
    "the run to be picked up again after the abandoned step",
  )
  expired = {
    runId: expiredRunId,
    workerPid: workerC.pid!,
    inFlight: expiredInFlight,
    exit: expiredTermination.exit,
    exitAfterMs: expiredTermination.exitAfterMs,
    afterExit: expiredAfterExit,
    afterReplacement: {
      records: records("drain-expires"),
      state: await workflow.getWorkflowRunById(expiredRunId),
      recoveredAfterMs: Date.now() - recoveryStartedAt,
    },
  }
  await stop(workerD)
}, 240_000)

afterAll(async () => {
  for (const worker of workers) worker.kill("SIGKILL")
  await rm(MARKER_FILE, { force: true })
  await pubsub.clearTopic("workflows")
  await pubsub.clearTopic("workflows-finish")
  await pubsub.close()
  await storage.close()
  await redis.close()
})

describe("a worker sent SIGTERM while a step is executing", () => {
  it("was genuinely mid-step, with the message delivered and unacked", () => {
    expect(matching(drained.inFlight.records, "probe-slow", "start")).toHaveLength(1)
    expect(matching(drained.inFlight.records, "probe-slow", "done")).toHaveLength(0)
    expect(drained.inFlight.records[0].pid).toBe(drained.workerPid)
    expect(drained.inFlight.transport.pending).toHaveLength(1)
    expect(drained.inFlight.transport.pending[0].event.type).toBe("workflow.step.run")
    expect(drained.inFlight.transport.pending[0].event.runId).toBe(drained.runId)
    expect(drained.inFlight.transport.pending[0].deliveriesCounter).toBe(1)
  })

  it("runs the generated entry's shutdown handler and exits cleanly", () => {
    // Exit code 0 with no signal is the handler's own `process.exit(0)`. A
    // `signal: "SIGTERM"` here would mean the default action took the process
    // and none of the rest of this file would be about a graceful stop.
    expect(drained.stdout).toContain("shutting down workers")
    expect(drained.exit).toEqual({ code: 0, signal: null })
  })

  it("waits for the in-flight step to finish before it exits", () => {
    // The step body had about 4.5 of its 5 seconds left when the signal
    // landed, and it ran them in the dying process: same pid, and the exit
    // came after them rather than a few milliseconds later.
    const done = matching(drained.afterExit.records, "probe-slow", "done")
    expect(done).toHaveLength(1)
    expect(done[0].pid).toBe(drained.workerPid)
    expect(drained.exitAfterMs).toBeGreaterThan(DRAINABLE_SLEEP_MS / 2)
    expect(drained.exitAfterMs).toBeLessThan(LONG_DRAIN_TIMEOUT_MS)
  })

  it("acks the drained step's message instead of leaving it for reclaim", () => {
    // An entry still pending here is a post parked until `RECLAIM_IDLE_MS`,
    // which this app sets to fifteen minutes. The stream is longer than it was
    // because the finished step published what comes next.
    expect(drained.afterExit.transport.pending).toEqual([])
    expect(drained.afterExit.transport.streamLength).toBeGreaterThan(drained.inFlight.transport.streamLength)
  })

  it("leaves the run for the replacement worker to finish, with no stage run twice", () => {
    // The whole point: a redeploy costs the run the gap between the two
    // processes and nothing else. `probe-slow` executed once, in the worker
    // that was killed, and was never re-delivered to the replacement.
    expect(drained.afterReplacement.state?.status).toBe("success")
    expect(matching(drained.afterReplacement.records, "probe-slow", "start")).toHaveLength(1)
    expect(matching(drained.afterReplacement.records, "probe-slow", "done")).toHaveLength(1)
    expect(matching(drained.afterReplacement.records, "probe-first", "done")).toHaveLength(1)
  })
})

describe("a step that outlives the drain deadline", () => {
  it("still lets the worker exit, on the deadline rather than on the step", () => {
    expect(expired.exit).toEqual({ code: 0, signal: null })
    expect(expired.exitAfterMs).toBeGreaterThanOrEqual(SHORT_DRAIN_TIMEOUT_MS)
    expect(expired.exitAfterMs).toBeLessThan(UNDRAINABLE_SLEEP_MS / 2)
    expect(matching(expired.afterExit.records, "probe-slow", "done")).toHaveLength(0)
    expect(expired.afterExit.state?.status).toBe("running")
  })

  it("hands that step's message back instead of leaving it for the fifteen minute reclaim", () => {
    // P2.91b. Abandoning a delivery on the deadline used to mean leaving it
    // pending under a consumer that no longer exists, recoverable only by
    // `XAUTOCLAIM` at `RECLAIM_IDLE_MS`. The drain nacks it on the way out
    // instead, which is the transport's own handback: it acks the original
    // (so the pending list empties) and republishes the event as a new entry
    // (so the stream is one longer) carrying the next delivery attempt.
    expect(expired.afterExit.transport.pending).toEqual([])
    expect(expired.afterExit.transport.streamLength).toBe(expired.inFlight.transport.streamLength + 1)

    const abandoned = expired.inFlight.transport.pending[0]
    const requeued = expired.afterExit.transport.events.at(-1)!
    expect(requeued.id).not.toBe(abandoned.id)
    expect(requeued.event.type).toBe(abandoned.event.type)
    expect(requeued.event.runId).toBe(expired.runId)
    expect(requeued.event.deliveryAttempt).toBe(2)
  })

  it("leaves the dead worker's consumer holding nothing, so nothing waits on the reclaim", () => {
    // Nothing in the transport runs XGROUP DELCONSUMER, so the dead consumer
    // is still listed. What matters is that it owns no entry: an entry owned
    // by a consumer that will never read again is exactly the fifteen minute
    // park this item is about.
    const owner = expired.afterExit.transport.consumers.find(
      (consumer) => consumer.name === expired.inFlight.transport.pending[0].consumer,
    )
    expect(owner?.pending).toBe(0)
  })

  it("lets a replacement finish the run in seconds rather than after the reclaim window", () => {
    // The abandoned step does run a second time, which is unavoidable: it was
    // truncated mid-body. The cost of the redeploy is that one re-run and the
    // gap between processes, not fifteen minutes of nothing.
    expect(expired.afterReplacement.state?.status).toBe("success")
    expect(matching(expired.afterReplacement.records, "probe-slow", "start")).toHaveLength(2)
    expect(matching(expired.afterReplacement.records, "probe-slow", "done")).toHaveLength(1)
    expect(expired.afterReplacement.recoveredAfterMs).toBeLessThan(60_000)
  })
})
