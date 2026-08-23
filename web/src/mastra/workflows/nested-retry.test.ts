// @vitest-environment node
/**
 * Item 5.5c-iii-b-2-b-i: what a nested workflow entry does under its parent's
 * `retryConfig`, measured rather than read.
 *
 * `imagesWorkflow` is the one stage that is a nested workflow rather than a
 * step, so the `warning` / `retry` execution_logs entry item 5.5c-iii-b-2-a
 * wrote into the other five stages cannot be written for `images` until the
 * attempt number it would carry has a definition. Two questions decide that,
 * and the ledger required them settled by measurement:
 *
 *   1. does the parent retry a nested workflow entry at all under
 *      `pipelineWorkflow.retryConfig`?
 *   2. do a nested run's steps restart at `retryCount === 0` on each parent
 *      attempt?
 *
 * These are three synthetic workflows on a real evented engine, a real Redis
 * Streams transport and real Postgres storage. Synthetic on purpose: the
 * subject is the engine's retry semantics across the nesting boundary, and a
 * failing step that only counts its executions isolates that from anything the
 * `images` stage does. `images-retry.test.ts` then asserts the same shape on
 * the real workflow.
 *
 * The control matters as much as the measurement here. Without the plain-step
 * workflow, "the nested step ran once" is equally consistent with the parent's
 * policy being inert for every entry, which would mean the five stages ported
 * in 5.5c-iii-b-1 do not retry either.
 *
 * Requires `docker compose up -d db redis`.
 */
import { Mastra } from "@mastra/core"
import { PostgresStore } from "@mastra/pg"
import { RedisStreamsPubSub } from "@mastra/redis-streams"
import { createStep, createWorkflow } from "@mastra/core/workflows/evented"
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest"
import { z } from "zod"

import { closeDb, getPool } from "../../db"

/** Retries after the first execution, so three executions in total. */
const ATTEMPTS = 2

const io = z.object({ marker: z.string() })

/**
 * Every execution any of the failing steps below performed, in order, as
 * `<step id>:<retryCount>`. One shared array because the three runs are
 * sequential and each step id belongs to exactly one of them.
 */
const executions: string[] = []

function failingStep(id: string) {
  return createStep({
    id,
    inputSchema: io,
    outputSchema: io,
    execute: async ({ retryCount }) => {
      executions.push(`${id}:${retryCount}`)
      throw new Error(`${id} always fails`)
    },
  })
}

function executionsOf(id: string) {
  return executions.filter((entry) => entry.startsWith(`${id}:`))
}

/** The control: a plain step under a parent that declares the policy. */
const plainParentWorkflow = createWorkflow({
  id: "nested-retry-plain-parent",
  inputSchema: io,
  outputSchema: io,
  retryConfig: { attempts: ATTEMPTS },
})
  .then(failingStep("plain-leaf"))
  .commit()

/** The measurement: a nested workflow that declares no policy of its own. */
const innerNoPolicyWorkflow = createWorkflow({
  id: "nested-retry-inner-no-policy",
  inputSchema: io,
  outputSchema: io,
})
  .then(failingStep("inner-no-policy-leaf"))
  .commit()

const nestedNoPolicyParentWorkflow = createWorkflow({
  id: "nested-retry-nested-parent",
  inputSchema: io,
  outputSchema: io,
  retryConfig: { attempts: ATTEMPTS },
})
  .then(innerNoPolicyWorkflow)
  .commit()

/** The fix under test: the same nesting, with the policy on the inner workflow. */
const innerOwnPolicyWorkflow = createWorkflow({
  id: "nested-retry-inner-own-policy",
  inputSchema: io,
  outputSchema: io,
  retryConfig: { attempts: ATTEMPTS },
})
  .then(failingStep("inner-own-policy-leaf"))
  .commit()

const nestedOwnPolicyParentWorkflow = createWorkflow({
  id: "nested-retry-own-policy-parent",
  inputSchema: io,
  outputSchema: io,
  retryConfig: { attempts: ATTEMPTS },
})
  .then(innerOwnPolicyWorkflow)
  .commit()

const pubsub = new RedisStreamsPubSub({
  url: process.env.REDIS_URL!,
  keyPrefix: "mastra:test:nested-retry",
})
const storage = new PostgresStore({ id: "nested-retry-test", pool: getPool() })

const testMastra = new Mastra({
  storage,
  pubsub,
  // Keyed by workflow id, not by a friendly name: the engine resolves a
  // nested entry with `mastra.getWorkflow(<its id>)`, so a key that differs
  // from the id makes the nested run fail to start with a 404.
  workflows: {
    "nested-retry-plain-parent": plainParentWorkflow,
    "nested-retry-inner-no-policy": innerNoPolicyWorkflow,
    "nested-retry-nested-parent": nestedNoPolicyParentWorkflow,
    "nested-retry-inner-own-policy": innerOwnPolicyWorkflow,
    "nested-retry-own-policy-parent": nestedOwnPolicyParentWorkflow,
  },
})

type RunResult = { status: string }

/**
 * What the engine printed while the three runs failed, captured so the expected
 * step errors are asserted on rather than left on stderr.
 *
 * It has to come off `console.error` rather than off the instance logger, for
 * the reason `failure-recorder.test.ts` records: the engine's `StepExecutor`
 * never adopts the Mastra instance's logger, so its line is written by a logger
 * no spy on `testMastra.getLogger()` can reach.
 */
let logged: string[]

let plainResult: RunResult
let nestedNoPolicyResult: RunResult
let nestedOwnPolicyResult: RunResult

async function runToCompletion(workflow: {
  createRun: () => Promise<{ start: (args: { inputData: { marker: string } }) => Promise<unknown> }>
}) {
  const run = await workflow.createRun()
  return (await run.start({ inputData: { marker: "x" } })) as RunResult
}

beforeAll(async () => {
  logged = []
  vi.spyOn(console, "error").mockImplementation((...args: unknown[]) => {
    logged.push(args.map(String).join(" "))
  })

  await storage.init()
  await testMastra.startWorkers()

  // Sequential, not parallel: `executions` is ordered and each run's slice is
  // read back below by step id.
  plainResult = await runToCompletion(plainParentWorkflow)
  nestedNoPolicyResult = await runToCompletion(nestedNoPolicyParentWorkflow)
  nestedOwnPolicyResult = await runToCompletion(nestedOwnPolicyParentWorkflow)
}, 120_000)

afterAll(async () => {
  await testMastra.stopWorkers()
  await pubsub.close()
  await closeDb()
  vi.restoreAllMocks()
})

/** Lines the engine printed naming a given step's thrown error. */
function loggedFailuresOf(id: string) {
  return logged.filter((line) => line.startsWith(`Error executing step ${id}:`))
}

describe("the engine's retry policy on a plain step (control)", () => {
  it("executes the failing step once per attempt the parent allows", () => {
    expect(executionsOf("plain-leaf")).toEqual([
      "plain-leaf:0",
      "plain-leaf:1",
      "plain-leaf:2",
    ])
  })

  it("fails the run once the attempts are spent", () => {
    expect(plainResult.status).toBe("failed")
    // The three executions are three thrown errors, and this is the only place
    // they are accounted for: an unasserted one would just be stderr noise.
    expect(loggedFailuresOf("plain-leaf")).toHaveLength(3)
  })
})

describe("the engine's retry policy across a nested workflow boundary", () => {
  // Question 1, answered: no. `runLeafStep` returns immediately after
  // publishing `workflow.start` for a nested entry
  // (`workflow-event-processor-Dp87-e6z.js:3310`), so the failing-status retry
  // branch 40 lines below it is unreachable for that entry, and the nested
  // run reports back to the parent through `processWorkflowEnd` publishing
  // `workflow.step.end` directly.
  it("does not retry a nested workflow entry under the parent's policy", () => {
    expect(executionsOf("inner-no-policy-leaf")).toEqual(["inner-no-policy-leaf:0"])
  })

  it("still fails the parent run when the nested run fails", () => {
    expect(nestedNoPolicyResult.status).toBe("failed")
    expect(loggedFailuresOf("inner-no-policy-leaf")).toHaveLength(1)
  })

  // Question 2, answered: the question does not arise. There is only ever one
  // parent attempt at a nested entry, so the inner `retryCount` is a single
  // ascending sequence owned by the inner workflow's own policy and never
  // restarts.
  it("retries the nested workflow's own steps under the nested workflow's policy", () => {
    expect(executionsOf("inner-own-policy-leaf")).toEqual([
      "inner-own-policy-leaf:0",
      "inner-own-policy-leaf:1",
      "inner-own-policy-leaf:2",
    ])
  })

  it("fails the parent run once the nested workflow's attempts are spent", () => {
    expect(nestedOwnPolicyResult.status).toBe("failed")
    expect(loggedFailuresOf("inner-own-policy-leaf")).toHaveLength(3)
  })
})
