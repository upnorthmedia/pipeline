// @vitest-environment node
/**
 * Phase 2 item 2.3: the scaffold workflow actually executes, streams the
 * lifecycle events, and leaves a run row in Postgres storage.
 *
 * Requires `docker compose up -d db redis`.
 */
import { Pool } from "pg"
import { afterAll, beforeAll, describe, expect, it } from "vitest"

import { closeDb, toNodePostgresUrl } from "../../db"
import { mastra, pubsub, storage } from "../index"
import { scaffoldCheckWorkflow } from "./scaffold-check"

/** Independent connection, so the storage assertions do not read through the pool under test. */
let probe: Pool

/** One run, shared by every assertion below: streaming it twice would be two runs. */
let runId: string
let events: { type: string; payload?: Record<string, unknown> }[]
let finalStatus: string
let result: Awaited<ReturnType<Awaited<ReturnType<typeof scaffoldCheckWorkflow.createRun>>["start"]>>

beforeAll(async () => {
  probe = new Pool({ connectionString: toNodePostgresUrl(process.env.DATABASE_URL_SYNC!) })
  await storage.init()

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
  await pubsub.close()
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
