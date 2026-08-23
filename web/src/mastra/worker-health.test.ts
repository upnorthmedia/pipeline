// @vitest-environment node
/**
 * Item 5.4c-i: the Redis Streams replacements for `worker_status()`'s two ARQ
 * Redis reads.
 *
 * Two suites, because the two things being proven need opposite setups:
 *
 *   - the arithmetic (`readWorkerHealth` over consumers and lag) is exercised
 *     against a hand-built stream with no Mastra anywhere near it, so a
 *     consumer's idle time and a group's lag can be driven to exact values;
 *   - the wiring (the stream key, the group name, and the 15 s threshold) is
 *     exercised against a real `mastra.startWorkers()`, because those three
 *     are claims about what Mastra does and nothing but Mastra can settle them.
 *
 * Requires `docker compose up -d db redis`.
 */
import { Mastra } from "@mastra/core"
import { createStep, createWorkflow } from "@mastra/core/workflows/evented"
import { PostgresStore } from "@mastra/pg"
import { RedisStreamsPubSub } from "@mastra/redis-streams"
import { createClient } from "redis"
import { afterAll, beforeAll, describe, expect, it } from "vitest"
import { z } from "zod"

import { closeDb, getPool } from "../db"
import {
  ORCHESTRATION_GROUP,
  ORCHESTRATION_TOPIC,
  STREAM_KEY_PREFIX,
  WORKER_ALIVE_IDLE_LIMIT_MS,
  WORKER_LAST_COMPLETED_KEY,
  orchestrationStreamKey,
  readLastCompleted,
  readWorkerHealth,
  recordRunCompleted,
  type WorkerHealth,
} from "./worker-health"

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))

type RedisClient = ReturnType<typeof createClient>

/** One connection for the assertions, independent of anything under test. */
let client: RedisClient

beforeAll(async () => {
  client = createClient({ url: process.env.REDIS_URL! })
  await client.connect()
})

afterAll(async () => {
  if (client.isOpen) await client.close()
  await closeDb()
})

describe("orchestrationStreamKey", () => {
  it("is the transport's `<keyPrefix>:<topic>`", () => {
    expect(orchestrationStreamKey()).toBe(`${STREAM_KEY_PREFIX}:${ORCHESTRATION_TOPIC}`)
    expect(orchestrationStreamKey()).toBe("mastra:topic:workflows")
    expect(orchestrationStreamKey("mastra:test:x")).toBe("mastra:test:x:workflows")
  })
})

describe("readWorkerHealth arithmetic", () => {
  const streamKey = "mastra:test:worker-health:workflows"
  const group = "mastra-orchestration"

  let neverPublished: WorkerHealth
  let backlogWithNoGroup: WorkerHealth
  let afterGroupCreated: WorkerHealth
  let afterOneRead: WorkerHealth
  let freshConsumer: WorkerHealth
  let staleConsumer: WorkerHealth
  let afterMiddleDelete: WorkerHealth

  beforeAll(async () => {
    await client.del(streamKey)

    neverPublished = await readWorkerHealth({ client, streamKey, group })

    await client.xAdd(streamKey, "*", { event: "one" })
    const second = await client.xAdd(streamKey, "*", { event: "two" })
    await client.xAdd(streamKey, "*", { event: "three" })
    backlogWithNoGroup = await readWorkerHealth({ client, streamKey, group })

    // A group anchored at 0 has read nothing, so all three entries are lag.
    await client.xGroupCreate(streamKey, group, "0")
    afterGroupCreated = await readWorkerHealth({ client, streamKey, group })

    await client.xReadGroup(group, "consumer-a", [{ key: streamKey, id: ">" }], { COUNT: 1 })
    afterOneRead = await readWorkerHealth({ client, streamKey, group })

    // The read above registered `consumer-a` moments ago, so any sane
    // threshold calls it live; a 1 ms threshold after a 60 ms pause calls the
    // same consumer dead without deleting it, which is the distinction the
    // production threshold rests on.
    freshConsumer = await readWorkerHealth({ client, streamKey, group })
    await sleep(60)
    staleConsumer = await readWorkerHealth({ client, streamKey, group, idleLimitMs: 1 })

    await client.xDel(streamKey, second)
    afterMiddleDelete = await readWorkerHealth({ client, streamKey, group })
  }, 30_000)

  afterAll(async () => {
    await client.del(streamKey)
  })

  it("reports a cold system rather than throwing when the stream does not exist", () => {
    expect(neverPublished).toEqual({ workerAlive: false, liveWorkers: 0, queuedEvents: 0 })
  })

  it("counts every entry as queued when no worker has ever created the group", () => {
    expect(backlogWithNoGroup).toEqual({ workerAlive: false, liveWorkers: 0, queuedEvents: 3 })
  })

  it("reports the group's lag once the group exists but has consumed nothing", () => {
    expect(afterGroupCreated).toEqual({ workerAlive: false, liveWorkers: 0, queuedEvents: 3 })
  })

  it("drops the delivered entry out of the backlog and counts its consumer", () => {
    expect(afterOneRead).toEqual({ workerAlive: true, liveWorkers: 1, queuedEvents: 2 })
  })

  it("separates live from stale consumers by idle time, not by existence", async () => {
    expect(freshConsumer.workerAlive).toBe(true)
    expect(staleConsumer).toEqual({ workerAlive: false, liveWorkers: 0, queuedEvents: 2 })
    // The consumer Redis still lists is the one just called dead: nothing in
    // the transport runs XGROUP DELCONSUMER, so counting entries would have
    // reported it alive forever.
    const consumers = await client.xInfoConsumers(streamKey, group)
    expect(consumers.map((c) => String(c.name))).toEqual(["consumer-a"])
  })

  it("reports an unknown backlog as null rather than as zero", () => {
    expect(afterMiddleDelete.queuedEvents).toBeNull()
  })
})

describe("against a real Mastra worker", () => {
  const keyPrefix = "mastra:test:worker-health-live"
  const streamKey = orchestrationStreamKey(keyPrefix)

  const slowStep = createStep({
    id: "slow",
    inputSchema: z.object({ ms: z.number() }),
    outputSchema: z.object({ ok: z.boolean() }),
    execute: async ({ inputData }) => {
      await sleep(inputData.ms)
      return { ok: true }
    },
  })
  const slowWorkflow = createWorkflow({
    id: "worker-health-slow",
    inputSchema: z.object({ ms: z.number() }),
    outputSchema: z.object({ ok: z.boolean() }),
  })
    .then(slowStep)
    .commit()

  const pubsub = new RedisStreamsPubSub({ url: process.env.REDIS_URL!, keyPrefix })
  const storage = new PostgresStore({ id: "worker-health-live", pool: getPool() })
  const testMastra = new Mastra({ storage, pubsub, workflows: { slow: slowWorkflow } })

  /** The step outlives the threshold, so "busy" and "dead" cannot be confused. */
  const STEP_MS = WORKER_ALIVE_IDLE_LIMIT_MS + 5_000

  let groupNames: string[]
  let idleWorker: WorkerHealth
  let busyWorker: WorkerHealth
  let stoppedWorker: WorkerHealth
  let consumersAfterStop: string[]

  beforeAll(async () => {
    await client.del(streamKey)
    await storage.init()
    await testMastra.startWorkers()

    const groups = await client.xInfoGroups(streamKey)
    groupNames = groups.map((g) => String(g.name))

    idleWorker = await readWorkerHealth({ client, streamKey })

    const run = await slowWorkflow.createRun()
    const started = run.start({ inputData: { ms: STEP_MS } })
    await sleep(STEP_MS - 2_000)
    busyWorker = await readWorkerHealth({ client, streamKey })
    await started

    await testMastra.stopWorkers()
    await sleep(WORKER_ALIVE_IDLE_LIMIT_MS + 1_000)
    stoppedWorker = await readWorkerHealth({ client, streamKey })
    // Tolerant so that a wrong group constant surfaces as a failed assertion
    // below rather than as a thrown `beforeAll` that skips the whole suite.
    consumersAfterStop = await client
      .xInfoConsumers(streamKey, ORCHESTRATION_GROUP)
      .then((cs) => cs.map((c) => String(c.name)))
      .catch(() => [])
  }, 180_000)

  afterAll(async () => {
    await pubsub.close()
    await client.del(streamKey)
  })

  it("finds the orchestration group under the name and stream key this module assumes", () => {
    // Both halves are needed: the first pins what Mastra actually creates, the
    // second pins this module's copy of the name to that literal. Asserting
    // only `toContain(ORCHESTRATION_GROUP)` would pass for any constant Mastra
    // happens to use and for none it does not, which is the same tautology as
    // comparing a value to itself.
    expect(groupNames).toContain("mastra-orchestration")
    expect(ORCHESTRATION_GROUP).toBe("mastra-orchestration")
    expect(streamKey).toBe(`${keyPrefix}:workflows`)
    expect(ORCHESTRATION_TOPIC).toBe("workflows")
  })

  it("reports a worker that is subscribed and waiting as alive", () => {
    expect(idleWorker.workerAlive).toBe(true)
    expect(idleWorker.liveWorkers).toBe(1)
  })

  it(`reports a worker ${STEP_MS / 1000}s into a step as alive, not as dead`, () => {
    expect(busyWorker.workerAlive).toBe(true)
    expect(busyWorker.liveWorkers).toBe(1)
  })

  it("reports a stopped worker as dead even though Redis still lists its consumer", () => {
    expect(stoppedWorker.workerAlive).toBe(false)
    expect(stoppedWorker.liveWorkers).toBe(0)
    expect(consumersAfterStop).toHaveLength(1)
  })
})

/**
 * Item 5.4c-ii: the replacement for the job runner's last-completed key,
 * written by `pipelineCompleteStep` at the end of every run that reaches it.
 *
 * Driven against an isolated key rather than the one the worker writes, so
 * "nothing has finished yet" is a state this suite can create. A real run
 * writing the real key is asserted in `workflows/pipeline-completion.test.ts`,
 * where four runs already exist to hang it off.
 */
describe("last completed", () => {
  const key = "mastra:test:worker-health:last_completed"

  beforeAll(async () => {
    await client.del(key)
  })

  afterAll(async () => {
    await client.del(key)
  })

  it("does not collide with the ARQ key it replaces", () => {
    expect(WORKER_LAST_COMPLETED_KEY).toBe("mastra:worker:last_completed")
  })

  it("reads null until a run has finished", async () => {
    expect(await readLastCompleted({ client, key })).toBeNull()
  })

  it("writes the instant it returns, as an ISO 8601 timestamp", async () => {
    const before = Date.now()
    const written = await recordRunCompleted({ client, key })
    const after = Date.now()

    expect(written).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/)
    expect(Date.parse(written)).toBeGreaterThanOrEqual(before)
    expect(Date.parse(written)).toBeLessThanOrEqual(after)
    expect(await readLastCompleted({ client, key })).toBe(written)
  })

  it("keeps only the latest run's timestamp", async () => {
    const first = await recordRunCompleted({ client, key })
    await sleep(5)
    const second = await recordRunCompleted({ client, key })

    expect(second).not.toBe(first)
    expect(await readLastCompleted({ client, key })).toBe(second)
  })

  /**
   * The step calls this with no client, from a worker that holds no
   * long-lived health connection, so the write has to land anyway. That the
   * connection is closed again is not asserted here: `CLIENT LIST` on the
   * shared dev Redis counts every other suite's connections too, so the check
   * would measure the rest of the suite rather than this call.
   */
  it("opens its own connection when given no client", async () => {
    await client.del(key)

    const written = await recordRunCompleted({ key })

    expect(await client.get(key)).toBe(written)
    expect(await readLastCompleted({ key })).toBe(written)
  })
})
