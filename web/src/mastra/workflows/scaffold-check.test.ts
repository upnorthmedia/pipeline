// @vitest-environment node
/**
 * Phase 2 item 2.3: the scaffold workflow actually executes, streams the
 * lifecycle events, and leaves a run row in Postgres storage.
 *
 * Runs on its own transport. Mastra's orchestration topic is a Redis Streams
 * consumer group, so every event on it goes to exactly one consumer: a real
 * worker (or a stray `mastra dev`) sharing the topic claims this run's
 * `workflow.step.*` events and the assertion on the step lifecycle fails, while
 * the run itself still reaches `success` through storage. The `keyPrefix` here
 * is what every other workflow suite already uses; the three process-level
 * suites that cannot use it (`worker-process`, `web-restart`, `crash-probe`)
 * take Redis databases 9, 10 and 11 instead.
 *
 * The isolation also cuts the other way. Sharing the default topic meant this
 * suite's workers picked up whatever `pipeline` events an abandoned run had
 * left in the stream and executed them against posts that no longer exist,
 * printing "post <id> not found" step failures that belonged to nobody.
 *
 * Requires `docker compose up -d db redis`.
 */
import { Mastra } from "@mastra/core"
import { PostgresStore } from "@mastra/pg"
import { RedisStreamsPubSub } from "@mastra/redis-streams"
import { Pool } from "pg"
import { afterAll, beforeAll, describe, expect, it } from "vitest"

import { closeDb, getPool, toNodePostgresUrl } from "../../db"
import { mastra, pubsub as appPubsub } from "../index"
import { scaffoldCheckWorkflow } from "./scaffold-check"

/** Independent connection, so the storage assertions do not read through the pool under test. */
let probe: Pool

/** One run, shared by every assertion below: streaming it twice would be two runs. */
let runId: string
let events: { type: string; payload?: Record<string, unknown> }[]
let finalStatus: string
let result: Awaited<ReturnType<Awaited<ReturnType<typeof scaffoldCheckWorkflow.createRun>>["start"]>>

const pubsub = new RedisStreamsPubSub({
  url: process.env.REDIS_URL!,
  keyPrefix: "mastra:test:scaffold-check",
})
const storage = new PostgresStore({ id: "scaffold-check-test", pool: getPool() })

/**
 * Constructed after the `../index` import has evaluated, so this is the last
 * instance to register `scaffoldCheckWorkflow` and the one the run below is
 * published through. The app instance is still imported, because the
 * registration assertion is about the app instance and nothing else.
 */
const testMastra = new Mastra({
  storage,
  pubsub,
  workflows: { scaffoldCheck: scaffoldCheckWorkflow },
})

beforeAll(async () => {
  probe = new Pool({ connectionString: toNodePostgresUrl(process.env.DATABASE_URL_SYNC!) })
  await storage.init()

  // A previous run of this suite that died mid-stream leaves its events behind
  // on the prefixed streams, where these workers would consume them.
  await pubsub.clearTopic("workflows")
  await pubsub.clearTopic("workflows-finish")

  // The evented engine executes steps in the orchestration worker, which is
  // what consumes the `workflows` topic. Without `startWorkers()` the run is
  // published and nothing ever picks it up, so the stream never ends.
  await testMastra.startWorkers()

  const run = await scaffoldCheckWorkflow.createRun()
  runId = run.runId
  const stream = run.stream({ inputData: { message: "phase-2 scaffold" } })

  // `stream.status` is a synchronous getter that reports the in-flight status,
  // so the stream has to be drained before it means anything.
  events = []
  for await (const event of stream.fullStream) {
    events.push(event as (typeof events)[number])
  }
  result = (await stream.result) as typeof result
  finalStatus = stream.status
}, 60_000)

afterAll(async () => {
  await testMastra.stopWorkers()
  await pubsub.clearTopic("workflows")
  await pubsub.clearTopic("workflows-finish")
  await pubsub.close()
  await appPubsub.close()
  await probe.end()
  await closeDb()
})

describe("scaffold-check workflow", () => {
  it("is registered on the Mastra instance under its id", () => {
    expect(mastra.getWorkflow("scaffoldCheck")).toBe(scaffoldCheckWorkflow)
    expect(Object.keys(mastra.listWorkflows())).toContain("scaffoldCheck")
    expect(scaffoldCheckWorkflow.id).toBe("scaffold-check")
  })

  it("runs both steps in order and threads the first step's output into the second", () => {
    expect(finalStatus).toBe("success")
    expect(result.status).toBe("success")
    expect(result.status === "success" && result.result).toEqual({
      message: "phase-2 scaffold",
      seenBy: ["scaffold-first", "scaffold-second"],
    })
  })

  it("emits the workflow lifecycle events the trace view will read", () => {
    const types = events.map((e) => e.type)
    expect(types[0]).toBe("workflow-start")
    expect(types.at(-1)).toBe("workflow-finish")
    expect(types).toContain("workflow-step-start")
    expect(types).toContain("workflow-step-result")

    const started = events
      .filter((e) => e.type === "workflow-step-start")
      .map((e) => e.payload?.id)
    expect(started).toEqual(["scaffold-first", "scaffold-second"])

    const results = events.filter((e) => e.type === "workflow-step-result")
    expect(results.map((e) => e.payload?.id)).toEqual(["scaffold-first", "scaffold-second"])
    expect(results.map((e) => e.payload?.status)).toEqual(["success", "success"])
    expect(results.at(-1)?.payload?.output).toEqual({
      message: "phase-2 scaffold",
      seenBy: ["scaffold-first", "scaffold-second"],
    })

    const finish = events.at(-1)
    expect(finish?.payload?.workflowStatus).toBe("success")
  })

  it("persists the run into the Postgres storage adapter", async () => {
    const { rows } = await probe.query<{ workflow_name: string; snapshot: Record<string, unknown> }>(
      `select workflow_name, snapshot from mastra_workflow_snapshot where run_id = $1`,
      [runId],
    )
    expect(rows).toHaveLength(1)
    expect(rows[0].workflow_name).toBe("scaffold-check")
    expect(rows[0].snapshot.status).toBe("success")
    expect(Object.keys(rows[0].snapshot.context as Record<string, unknown>)).toEqual(
      expect.arrayContaining(["scaffold-first", "scaffold-second"]),
    )
  })

  it("reads the same run back through the workflow API", async () => {
    const state = await scaffoldCheckWorkflow.getWorkflowRunById(runId)
    expect(state).not.toBeNull()
    expect(state?.runId).toBe(runId)
    expect(state?.status).toBe("success")
  })
})
