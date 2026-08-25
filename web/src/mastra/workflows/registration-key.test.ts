// @vitest-environment node
/**
 * Why every workflow has to be registered under its own `id`.
 *
 * `Mastra.workflows` is a record, so the key is free: `{ sitemapCrawl:
 * sitemapCrawlWorkflow }` registers a workflow whose `id` is `sitemap-crawl`.
 * A start works either way, and so does every read: `Mastra.getWorkflowById()`
 * scans the registry by each workflow's own `.id` before falling back to the
 * key.
 *
 * A resume does not. `EventedExecutionEngine.execute()` takes its `resume`
 * branch through `resolveWorkflow(params.workflowId)`, which is
 * `Mastra.getWorkflow(workflowId)` and nothing else, and that is a plain
 * lookup on the registration key
 * (`node_modules/@mastra/core/dist/agent-DSxJoGjY.js:6956` and
 * `mastra-Bn5mWcPE.js:2224`). `params.workflowId` is the workflow's `id`. So a
 * workflow registered under a key that is not its id starts, runs, suspends
 * and persists exactly like any other, and then throws
 * `MASTRA_GET_WORKFLOW_BY_ID_NOT_FOUND` the first time anything resumes it.
 * `restart` and `timeTravel` take the same call.
 *
 * That is invisible to `tsc`, to `lint`, and to every test that does not
 * suspend, which is why it survived the port. This file is the demonstration:
 * two probe workflows that differ only in the key they are registered under,
 * both driven to a real suspend on a real transport, both resumed.
 * `index.test.ts` carries the invariant it justifies.
 *
 * Requires `docker compose up -d db redis`.
 */
import { Mastra } from "@mastra/core"
import { createStep, createWorkflow } from "@mastra/core/workflows/evented"
import { PostgresStore } from "@mastra/pg"
import { RedisStreamsPubSub } from "@mastra/redis-streams"
import { afterAll, beforeAll, describe, expect, it } from "vitest"
import { z } from "zod"

import { closeDb, getPool } from "../../db"

const gateInput = z.object({ label: z.string() })
const gateOutput = z.object({ label: z.string(), approved: z.boolean() })

/** Suspends until it is resumed with an approval, like every stage gate does. */
function gateStep(id: string) {
  return createStep({
    id,
    inputSchema: gateInput,
    outputSchema: gateOutput,
    resumeSchema: z.object({ approved: z.literal(true) }),
    suspendSchema: z.object({ waitingFor: z.string() }),
    execute: async ({ inputData, resumeData, suspend }) => {
      if (!resumeData?.approved) return await suspend({ waitingFor: inputData.label })
      return { label: inputData.label, approved: true }
    },
  })
}

function probeWorkflow(id: string) {
  return createWorkflow({ id, inputSchema: gateInput, outputSchema: gateOutput })
    .then(gateStep(`${id}-gate`))
    .commit()
}

/** Registered under its own id, as `src/mastra/index.ts` now registers all seven. */
const matchedWorkflow = probeWorkflow("key-parity-matched")
/** Registered under a camelCase key, as five of the seven were. */
const mismatchedWorkflow = probeWorkflow("key-parity-mismatched")

const pubsub = new RedisStreamsPubSub({
  url: process.env.REDIS_URL!,
  keyPrefix: "mastra:test:registration-key",
})
const storage = new PostgresStore({ id: "registration-key-test", pool: getPool() })
const testMastra = new Mastra({
  storage,
  pubsub,
  workflows: {
    "key-parity-matched": matchedWorkflow,
    keyParityMismatched: mismatchedWorkflow,
  },
})

type Workflow = typeof matchedWorkflow
type RunState = Awaited<ReturnType<Workflow["getWorkflowRunById"]>>

/** The persisted run state, polled: `start()` resolves alongside the snapshot write. */
async function runSuspends(workflow: Workflow, runId: string) {
  for (let attempt = 0; attempt < 300; attempt += 1) {
    const state: RunState = await workflow.getWorkflowRunById(runId)
    if (state?.status === "suspended") return state
    await new Promise((resolve) => setTimeout(resolve, 100))
  }
  throw new Error(`run ${runId} never suspended`)
}

/**
 * Runs `fn` with this process's `unhandledRejection` listeners replaced by a
 * collector, and hands back what it collected.
 *
 * Needed because the engine signals a failed `execute()` twice: its `catch`
 * calls `rejectResult(err)` and then `throw err`, and the `await resultPromise`
 * that would have handled the rejection is on the line after the throw
 * (`agent-DSxJoGjY.js:7087`). So a caller that catches a resume error, which is
 * the only thing a caller can do, still leaves one rejected promise with no
 * handler. Vitest reports that as an unhandled error and exits 1 even when
 * every assertion passed.
 *
 * The collected errors are asserted on below rather than dropped, so this
 * captures the second signal instead of hiding it.
 */
async function collectingUnhandledRejections<T>(fn: () => Promise<T>) {
  const installed = process.listeners("unhandledRejection")
  const collected: unknown[] = []
  process.removeAllListeners("unhandledRejection")
  process.on("unhandledRejection", (reason) => collected.push(reason))
  try {
    const value = await fn()
    // One macrotask so a rejection settled during `fn` reaches the collector
    // before the real listeners are back.
    await new Promise((resolve) => setTimeout(resolve, 50))
    return { value, collected }
  } finally {
    process.removeAllListeners("unhandledRejection")
    for (const listener of installed) process.on("unhandledRejection", listener)
  }
}

/** What a resume of a real suspended run of `workflow` does: settle, or throw. */
async function resumeSuspended(workflow: Workflow, gateId: string) {
  const run = await workflow.createRun()
  await run.start({ inputData: { label: workflow.id } })
  const suspended = await runSuspends(workflow, run.runId)
  const { value, collected } = await collectingUnhandledRejections(async () => {
    try {
      await run.resume({ step: gateId, resumeData: { approved: true } })
      return null as Error | null
    } catch (error) {
      return error as Error
    }
  })
  return { suspended, threw: value, unhandled: collected }
}

let matched: Awaited<ReturnType<typeof resumeSuspended>>
let mismatched: Awaited<ReturnType<typeof resumeSuspended>>

beforeAll(async () => {
  await storage.init()
  await pubsub.clearTopic("workflows")
  await pubsub.clearTopic("workflows-finish")
  await testMastra.startWorkers()

  matched = await resumeSuspended(matchedWorkflow, "key-parity-matched-gate")
  mismatched = await resumeSuspended(mismatchedWorkflow, "key-parity-mismatched-gate")
}, 120_000)

afterAll(async () => {
  await testMastra.stopWorkers()
  await pubsub.clearTopic("workflows")
  await pubsub.clearTopic("workflows-finish")
  await pubsub.close()
  await closeDb()
})

describe("a workflow registered under a key that is not its id", () => {
  it("starts, runs and suspends with no sign of the problem", () => {
    expect(mismatched.suspended.status).toBe("suspended")
  })

  it("is still readable by id, because that lookup scans by `.id` first", () => {
    expect(testMastra.getWorkflowById("key-parity-mismatched")).toBe(mismatchedWorkflow)
  })

  it("throws MASTRA_GET_WORKFLOW_BY_ID_NOT_FOUND when the suspended run is resumed", () => {
    expect(mismatched.threw).toBeInstanceOf(Error)
    expect((mismatched.threw as { id?: string }).id).toBe("MASTRA_GET_WORKFLOW_BY_ID_NOT_FOUND")
    // The message names the id the resume asked for, which is the workflow's
    // own id and not the key it is filed under.
    expect(mismatched.threw?.message).toContain("key-parity-mismatched")
  })

  it("is unreachable by the key-only lookup the resume branch uses", () => {
    // The argument is cast because `getWorkflow`'s parameter is typed as the
    // registration keys. That type is the one place the mismatch is visible to
    // `tsc`, and it is not visible where the engine passes an id in through
    // `resolveWorkflow`, which is untyped `string` by then.
    const notAKey = "key-parity-mismatched" as "key-parity-matched"
    expect(() => testMastra.getWorkflow(notAKey)).toThrow(/key-parity-mismatched/)
  })

  it("also leaves the same error as an unhandled rejection", () => {
    expect(mismatched.unhandled).toHaveLength(1)
    expect((mismatched.unhandled[0] as { id?: string }).id).toBe(
      "MASTRA_GET_WORKFLOW_BY_ID_NOT_FOUND",
    )
  })
})

describe("the same workflow registered under its id", () => {
  it("suspends the same way", () => {
    expect(matched.suspended.status).toBe("suspended")
  })

  it("resumes without throwing", () => {
    expect(matched.threw).toBeNull()
    expect(matched.unhandled).toEqual([])
  })
})
