// @vitest-environment node
/**
 * Ledger item P2.21: what a *graceful* stop does to a step that is executing.
 *
 * `crash-probe.test.ts` answers the `SIGKILL` half of the durability question:
 * a worker that dies without warning leaves its step's message pending, and a
 * later worker in the same group reclaims and re-runs it. A Railway redeploy is
 * not a `SIGKILL`. The platform sends `SIGTERM`, and the entry `mastra worker
 * build` generates handles it:
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
 * The open question the entry filed was whether that handler leaves the
 * in-flight step's message pending for reclaim, acks it, or nacks it, because
 * the three answers mean "a redeploy stalls the run", "a redeploy loses a
 * stage" and "a redeploy re-queues a stage immediately" respectively. It is
 * answered here against the real transport rather than reasoned about, and the
 * answer is the first one.
 *
 * Why it comes out that way, read out of the installed packages:
 *   - `RedisStreamsPubSub.#deliverMessage` calls `sub.cb(event, ack, nack)` and
 *     does *not* await it, and `PullTransport`'s callback likewise fires
 *     `router.route(...)` without awaiting. So no part of the transport holds a
 *     handle on a running step body.
 *   - `Mastra.stopWorkers()` stops each worker, and `PullTransport.stop()` just
 *     unsubscribes. `RedisStreamsPubSub.unsubscribe` sets `stopped`, quits the
 *     read client and awaits the *read loop*, which is not the step.
 *   - Nothing anywhere runs `XGROUP DELCONSUMER`, so the dead consumer keeps
 *     its pending-entries list and `XAUTOCLAIM` can still find it.
 *
 * The consequence is not cosmetic. `stopWorkers()` is a drain of the reader,
 * not of the work, so `process.exit(0)` truncates the step exactly as a
 * `SIGKILL` would, and recovery is the same `XAUTOCLAIM` timer. The app sets
 * `reclaimIdleMs` to 15 minutes (`RECLAIM_IDLE_MS` in `src/mastra/index.ts`,
 * deliberately wider than the slowest stage, see `reclaim-duplication.test.ts`),
 * so a redeploy that lands while a stage is running parks that post for over
 * fifteen minutes and then re-runs the stage from the beginning, re-billing the
 * provider call the dead worker had already partly paid for.
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
 * Long enough that the signal lands well inside the step body, and long enough
 * that the step would still be running at every assertion below if the
 * shutdown had waited for it.
 */
const SLEEP_MS = 30_000

/**
 * How long the suite watches a freshly joined worker do nothing with the dead
 * one's pending entry. Not a tuned sleep: the fixture's transport keeps the
 * library defaults, so its reclaim loop first ticks at `reclaimIntervalMs` 30s
 * and only claims entries idle for `reclaimIdleMs` 60s. Any value comfortably
 * under 30s asks the same question.
 */
const REPLACEMENT_IDLE_WATCH_MS = 6_000

const { workflow, pubsub, storage } = createProbeMastra({
  redisUrl: REDIS_URL,
  databaseUrl: process.env.DATABASE_URL_SYNC ?? process.env.DATABASE_URL,
  markerFile: MARKER_FILE,
  sleepMs: SLEEP_MS,
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
type TransportState = { pending: PendingEntry[]; consumers: { name: string; pending: number }[]; streamLength: number }

const redis = createClient({ url: REDIS_URL })

let workerA: WorkerProcess
let workerB: WorkerProcess
let runId: string

/** The transport and the records at three points in the shutdown. */
let inFlight: { transport: TransportState; records: ProbeRecord[] }
let afterExit: { transport: TransportState; records: ProbeRecord[]; state: RunState }
let afterReplacement: { transport: TransportState; records: ProbeRecord[] }

let workerAExit: { code: number | null; signal: NodeJS.Signals | null }
let workerAStdout = ""

function records(): ProbeRecord[] {
  return readProbeRecords(MARKER_FILE) as ProbeRecord[]
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
  return { pending, consumers, streamLength: await redis.xLen(STREAM_KEY) }
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
      // The whole point of this suite: handle SIGTERM the way the deployed
      // worker entry does, rather than letting the default action stop the
      // process outright.
      PROBE_GRACEFUL_SIGTERM: "1",
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
  await redis.connect()
  // A leftover stream would carry this suite's own pending entries from an
  // interrupted earlier run, and every assertion below counts them.
  await pubsub.clearTopic("workflows")
  await pubsub.clearTopic("workflows-finish")
  await redis.del(STREAM_KEY)
  await rm(MARKER_FILE, { force: true })
  await storage.init()

  workerA = await spawnWorker()
  workerA.stdout.on("data", (chunk: string) => {
    workerAStdout += chunk
  })

  const run = await workflow.createRun()
  runId = (await run.startAsync({ inputData: { label: "sigterm-shutdown" } })).runId

  await waitFor(
    () => matching(records(), "probe-slow", "start").length === 1,
    60_000,
    "probe-slow to start under worker A",
  )
  // A moment inside the sleep, so the signal is unambiguously mid-step rather
  // than racing the record write.
  await new Promise((resolve) => setTimeout(resolve, 1_000))
  inFlight = { transport: await readTransport(), records: records() }

  const exited = new Promise<{ code: number | null; signal: NodeJS.Signals | null }>((resolve) => {
    workerA.once("exit", (code, signal) => resolve({ code, signal }))
  })
  workerA.kill("SIGTERM")
  workerAExit = await exited
  afterExit = {
    transport: await readTransport(),
    records: records(),
    state: await workflow.getWorkflowRunById(runId),
  }

  workerB = await spawnWorker()
  await new Promise((resolve) => setTimeout(resolve, REPLACEMENT_IDLE_WATCH_MS))
  afterReplacement = { transport: await readTransport(), records: records() }

  workerB.kill("SIGKILL")
}, 180_000)

afterAll(async () => {
  workerA?.kill("SIGKILL")
  workerB?.kill("SIGKILL")
  await rm(MARKER_FILE, { force: true })
  await pubsub.clearTopic("workflows")
  await pubsub.clearTopic("workflows-finish")
  await pubsub.close()
  await storage.close()
  await redis.close()
})

describe("a worker sent SIGTERM while a step is executing", () => {
  it("was genuinely mid-step, with the message delivered and unacked", () => {
    expect(matching(inFlight.records, "probe-slow", "start")).toHaveLength(1)
    expect(matching(inFlight.records, "probe-slow", "done")).toHaveLength(0)
    expect(inFlight.records[0].pid).toBe(workerA.pid)
    expect(inFlight.transport.pending).toHaveLength(1)
    expect(inFlight.transport.pending[0].event.type).toBe("workflow.step.run")
    expect(inFlight.transport.pending[0].event.runId).toBe(runId)
    expect(inFlight.transport.pending[0].deliveriesCounter).toBe(1)
  })

  it("runs the generated entry's shutdown handler and exits cleanly", () => {
    // Exit code 0 with no signal is the handler's own `process.exit(0)`. A
    // `signal: "SIGTERM"` here would mean the default action took the process
    // and none of the rest of this file would be about a graceful stop.
    expect(workerAStdout).toContain("shutting down workers")
    expect(workerAExit).toEqual({ code: 0, signal: null })
  })

  it("does not wait for the in-flight step, which never reaches its end", () => {
    // `stopWorkers()` drains the reader, not the work. The step body was 30s
    // long and had run for about one of them.
    expect(matching(afterExit.records, "probe-slow", "done")).toHaveLength(0)
    expect(afterExit.state?.status).toBe("running")
    expect(Object.keys(afterExit.state?.steps ?? {})).toEqual(["probe-first"])
  })

  it("leaves the step's message pending: not acked, not nacked", () => {
    // The three answers the ledger item asked between. An ack would empty the
    // pending list; a nack would empty it *and* add a redelivery to the stream.
    // Neither happened: byte for byte the same entry, same delivery count.
    expect(afterExit.transport.pending).toHaveLength(1)
    expect(afterExit.transport.pending).toEqual(inFlight.transport.pending)
    expect(afterExit.transport.streamLength).toBe(inFlight.transport.streamLength)
  })

  it("keeps the dead worker's consumer in the group, which is what XAUTOCLAIM claims from", () => {
    // Nothing in the transport ever runs XGROUP DELCONSUMER, so the pending
    // entry still has an owner to be claimed away from. Were the consumer
    // dropped on unsubscribe, the entry would be unreachable and the run
    // unrecoverable rather than merely late.
    const owner = afterExit.transport.consumers.find(
      (consumer) => consumer.name === afterExit.transport.pending[0].consumer,
    )
    expect(owner?.pending).toBe(1)
  })
})

describe("the worker that replaces it", () => {
  it("does not inherit the pending entry by joining the group", () => {
    // XREADGROUP with `>` delivers only entries no consumer has taken, so a
    // fresh worker subscribing to a group with a dead sibling's backlog sees
    // nothing. It is idle while the run is stalled.
    expect(afterReplacement.transport.pending).toHaveLength(1)
    expect(afterReplacement.transport.pending).toEqual(inFlight.transport.pending)
    expect(matching(afterReplacement.records, "probe-slow", "start")).toHaveLength(1)
  })

  it("is running, so the stall is the reclaim timer and nothing else", () => {
    // Two consumers in the group, one dead holding the entry and one alive
    // holding nothing. That is the shape of a redeploy: recovery waits out
    // `reclaimIdleMs`, which this app sets to 15 minutes.
    expect(afterReplacement.transport.consumers).toHaveLength(2)
    expect(afterReplacement.transport.consumers.filter((c) => c.pending === 1)).toHaveLength(1)
  })
})
