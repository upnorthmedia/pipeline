// @vitest-environment node
/**
 * What `EventedRun.resume()` and `resumeStream()` actually resolve with.
 *
 * The port carries a standing finding: a resume does not report the resumed
 * run. `resume()` subscribes to the shared `workflows-finish` topic, and that
 * Redis stream still holds this run's earlier `workflow.suspend` entry, so the
 * promise settles on that stale entry the moment it subscribes while the
 * resumed run is still executing behind it. `review-gates.test.ts` already
 * works around it by polling `getWorkflowRunById`, and every other suite that
 * waits on a run does the same, but nothing pinned the behaviour, so the
 * workaround read as superstition and the next thing to resume a run (a gate
 * approval route) would have had to rediscover it.
 *
 * This file is that pin, and two of its cases are deliberately assertions on
 * the *wrong* answer. If Mastra starts reporting the resumed run here, they
 * fail, and the polling every suite carries can go.
 *
 * The cause is named by the third case rather than assumed: draining the
 * `workflows-finish` topic between the suspend and the resume makes the same
 * call wait for the run and answer `success`.
 *
 * A two-step probe workflow rather than the real pipeline: the property is
 * the engine's, not the pipeline's, and a probe costs no provider call and no
 * post row. The step after the gate sleeps, which is what makes the staleness
 * observable rather than a coin flip: without it the resumed run can finish
 * before the assertion reads the status, and a correct-looking result would be
 * a race rather than a fix.
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

/** How long the step after the gate takes, so a resumed run is observably in flight. */
const AFTER_GATE_MS = 3_000

const gateInput = z.object({ label: z.string() })
const gateOutput = z.object({ label: z.string(), approved: z.boolean() })
const runOutput = z.object({ label: z.string(), ran: z.string() })

/** Suspends until it is resumed with an approval, like every stage gate does. */
const gateStep = createStep({
  id: "probe-gate",
  inputSchema: gateInput,
  outputSchema: gateOutput,
  resumeSchema: z.object({ approved: z.literal(true) }),
  suspendSchema: z.object({ waitingFor: z.string() }),
  execute: async ({ inputData, resumeData, suspend }) => {
    if (!resumeData?.approved) return await suspend({ waitingFor: inputData.label })
    return { label: inputData.label, approved: true }
  },
})

/** The work a resume is supposed to be waited for. */
const afterGateStep = createStep({
  id: "probe-after-gate",
  inputSchema: gateOutput,
  outputSchema: runOutput,
  execute: async ({ inputData }) => {
    await new Promise((resolve) => setTimeout(resolve, AFTER_GATE_MS))
    return { label: inputData.label, ran: "probe-after-gate" }
  },
})

const probeWorkflow = createWorkflow({
  id: "evented-resume-probe",
  inputSchema: gateInput,
  outputSchema: runOutput,
})
  .then(gateStep)
  .then(afterGateStep)
  .commit()

const pubsub = new RedisStreamsPubSub({
  url: process.env.REDIS_URL!,
  keyPrefix: "mastra:test:evented-resume",
})
const storage = new PostgresStore({ id: "evented-resume-test", pool: getPool() })
const testMastra = new Mastra({
  storage,
  pubsub,
  // Keyed by the workflow id, for the reason `registration-key.test.ts`
  // demonstrates: `resolveWorkflow` calls `Mastra.getWorkflow(<id>)` and that
  // looks up by registration key, so a key that differs from the id starts and
  // runs fine and then 404s the moment a step suspends.
  workflows: { "evented-resume-probe": probeWorkflow },
})

type RunState = Awaited<ReturnType<typeof probeWorkflow.getWorkflowRunById>>
type ResumeResult = Awaited<ReturnType<Awaited<ReturnType<typeof probeWorkflow.createRun>>["resume"]>>

/**
 * The persisted run state, polled. `start()` resolves on the run's own
 * `workflow.suspend` event, which the engine publishes alongside rather than
 * after the snapshot write, so resuming on that alone can be told the run was
 * never suspended.
 */
async function runReaches(runId: string, done: (state: NonNullable<RunState>) => boolean) {
  for (let attempt = 0; attempt < 600; attempt += 1) {
    const state = await probeWorkflow.getWorkflowRunById(runId)
    if (state && done(state)) return state
    await new Promise((resolve) => setTimeout(resolve, 100))
  }
  throw new Error(`run ${runId} never reached the expected state`)
}

const suspended = (state: NonNullable<RunState>) => state.status === "suspended"
const settled = (state: NonNullable<RunState>) =>
  state.status !== "suspended" && state.status !== "running"

/**
 * `resume()`'s resolved value, the run's persisted status at the instant it
 * resolved, and the persisted truth once the run actually finished.
 */
let awaited: {
  resolved: ResumeResult
  atResume: NonNullable<RunState>
  persisted: NonNullable<RunState>
}
/** `resume()`'s resolved value once the retained suspend entry is drained first. */
let cleared: ResumeResult
/** `resumeStream()`'s `.result`, and the persisted truth for its run. */
let streamed: { resolved: ResumeResult; replayed: string[]; persisted: NonNullable<RunState> }

beforeAll(async () => {
  await storage.init()

  // A previous run of this suite that died mid-resume leaves its events on the
  // prefixed streams, where these workers would consume them.
  await pubsub.clearTopic("workflows")
  await pubsub.clearTopic("workflows-finish")
  await testMastra.startWorkers()

  const awaitedRun = await probeWorkflow.createRun()
  await awaitedRun.start({ inputData: { label: "awaited" } })
  await runReaches(awaitedRun.runId, suspended)
  const resolved = await awaitedRun.resume({
    step: "probe-gate",
    resumeData: { approved: true },
  })
  // Read before anything else awaits: this is what makes "resolved early" an
  // assertion rather than an inference.
  const atResume = await probeWorkflow.getWorkflowRunById(awaitedRun.runId)
  if (!atResume) throw new Error("resumed run has no persisted state")
  awaited = {
    resolved,
    atResume,
    persisted: await runReaches(awaitedRun.runId, settled),
  }

  // Same run, with the retained entry taken away first. This is the
  // discriminating case: if the stale answer were the resume API simply not
  // waiting, draining the topic would change nothing.
  const clearedRun = await probeWorkflow.createRun()
  await clearedRun.start({ inputData: { label: "cleared" } })
  await runReaches(clearedRun.runId, suspended)
  await pubsub.clearTopic("workflows-finish")
  cleared = await clearedRun.resume({ step: "probe-gate", resumeData: { approved: true } })

  const streamedRun = await probeWorkflow.createRun()
  await streamedRun.start({ inputData: { label: "streamed" } })
  await runReaches(streamedRun.runId, suspended)
  const stream = streamedRun.resumeStream({
    step: "probe-gate",
    resumeData: { approved: true },
  })
  const streamResolved = await stream.result
  const replayed: string[] = []
  for await (const event of stream.fullStream) {
    replayed.push(event.type)
  }
  streamed = {
    resolved: streamResolved as ResumeResult,
    replayed,
    persisted: await runReaches(streamedRun.runId, settled),
  }
}, 120_000)

afterAll(async () => {
  await testMastra.stopWorkers()
  await pubsub.clearTopic("workflows")
  await pubsub.clearTopic("workflows-finish")
  await pubsub.close()
  await closeDb()
})

describe("EventedRun.resume()", () => {
  it("does not report the resumed run: it resolves off the run's own earlier suspend", () => {
    expect(awaited.resolved.status).toBe("suspended")
  })

  it("resolved while the run was still executing", () => {
    expect(settled(awaited.atResume)).toBe(false)
  })

  it("finished the run it was resolved as still waiting on", () => {
    expect(awaited.persisted.status).toBe("success")
    // The persisted `result` is the last step's record, not its bare output.
    expect((awaited.persisted as { result?: { output?: unknown } }).result?.output).toEqual({
      label: "awaited",
      ran: "probe-after-gate",
    })
  })
})

describe("why the resume resolves early", () => {
  /**
   * Draining `workflows-finish` is not a fix: it is one shared topic for every
   * run on this transport, so a real caller clearing it would throw away
   * another run's completion. It is here to name the cause.
   */
  it("waits for the run once its retained suspend entry is gone", () => {
    expect(cleared.status).toBe("success")
    // A resume resolves with the workflow's own output, where the persisted
    // run state's `result` is the last step's record.
    expect((cleared as { result?: unknown }).result).toEqual({
      label: "cleared",
      ran: "probe-after-gate",
    })
  })
})

describe("EventedRun.resumeStream()", () => {
  it("resolves `.result` with the same stale suspend", () => {
    expect(streamed.resolved.status).toBe("suspended")
  })

  it("finished the run its `.result` was resolved as still waiting on", () => {
    expect(streamed.persisted.status).toBe("success")
    expect((streamed.persisted as { result?: { output?: unknown } }).result?.output).toEqual({
      label: "streamed",
      ran: "probe-after-gate",
    })
  })

  it("replays the pre-suspend events rather than only what the resume produced", () => {
    expect(streamed.replayed).toContain("workflow-step-start")
  })
})
