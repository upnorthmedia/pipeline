// @vitest-environment node
/**
 * Ledger item 4.7a: a step that runs longer than `reclaimIdleMs` is executed
 * twice, on one worker, with no crash involved.
 *
 * The first full end-to-end run (4.7) ended `success` with all six stages
 * complete, and the write-audit trigger on the post row showed `edit` had
 * written four different values, `research` and `outline` two each. Nothing
 * failed, nothing was killed, and one worker was alive throughout.
 *
 * The mechanism, read out of the installed package rather than inferred:
 * `RedisStreamsPubSub` starts a reclaim loop per grouped subscription which
 * every `reclaimIntervalMs` (30s) runs
 *
 *   XAUTOCLAIM <stream> <group> <consumer> <reclaimIdleMs> 0-0
 *
 * and delivers whatever it claims (`#startReclaimLoop`, `dist/index.js`).
 * `XAUTOCLAIM` claims by idle time alone: it has no way to tell a consumer that
 * died from one that is still working. `WorkflowEventProcessor.handle` awaits
 * the step body before the transport acks, so a `workflow.step.run` message is
 * pending for the whole step. At the 60s default, therefore, *any* step slower
 * than a minute is re-delivered to a live worker and runs a second time
 * concurrently with the first. Every stage in this pipeline is an LLM call
 * taking 40 to 120 seconds.
 *
 * The same loop is what makes a crashed worker's step recoverable (4.5a), so
 * this cannot be disabled: it is a window that has to be wider than a step, and
 * the fix is `RECLAIM_IDLE_MS` on the app's pubsub.
 *
 * The claims under test, stated so they can fail:
 *
 *   1. With `reclaimIdleMs` below the step's duration, the step body executes
 *      more than once for a single run.
 *   2. With `reclaimIdleMs` above it, exactly once.
 *   3. The app's own instance is configured wider than the slowest stage
 *      observed in a real run.
 *
 * The probe workflow touches no provider, no post row and no media directory,
 * so this stays in the suite as a regression test. Redis databases 14 and 15
 * isolate the two cases from each other and from the suites on 9, 10 and 11:
 * all of them share the `workflows` topic name, and a stray consumer on the
 * same database would take these runs.
 *
 * Requires `docker compose up -d db redis`.
 */
import { readFileSync } from "node:fs"
import path from "node:path"

import { Mastra } from "@mastra/core"
import { createStep, createWorkflow } from "@mastra/core/workflows/evented"
import { PostgresStore } from "@mastra/pg"
import { RedisStreamsPubSub } from "@mastra/redis-streams"
import { afterAll, beforeAll, describe, expect, it } from "vitest"
import { z } from "zod"

import { RECLAIM_IDLE_MS } from "../index"

const WORKFLOW_ID = "reclaim-probe"

/**
 * The step body's duration. Everything else is sized off it: the short window
 * has to be comfortably under it and the wide one comfortably over, while the
 * whole file stays a few seconds rather than a few minutes.
 */
const STEP_MS = 6_000

/** How long to keep watching after the run settles, for a late duplicate. */
const SETTLE_MS = 4_000

function redisUrlForDatabase(database: number): string {
  const url = new URL(process.env.REDIS_URL!)
  url.pathname = `/${database}`
  return url.toString()
}

/** `pg` understands neither of the driver prefixes the repo `.env` carries. */
function nodePostgresUrl(): string {
  return (process.env.DATABASE_URL_SYNC ?? process.env.DATABASE_URL!).replace(
    /^postgresql\+\w+:\/\//,
    "postgresql://",
  )
}

interface Probe {
  mastra: Mastra
  pubsub: RedisStreamsPubSub
  storage: PostgresStore
  /** One entry per execution of the step body, appended as it starts. */
  executions: string[]
  run: () => Promise<void>
}

/**
 * A one-step workflow whose body sleeps, on its own Redis database with its own
 * reclaim settings. The counter is a closure rather than a file or a table
 * because both executions happen in this process: the point of the probe is
 * that no second process is needed to get a second execution.
 */
async function createProbe(database: number, reclaimIdleMs: number): Promise<Probe> {
  const executions: string[] = []

  const slowStep = createStep({
    id: "reclaim-probe-slow",
    inputSchema: z.object({ label: z.string().min(1) }),
    outputSchema: z.object({ label: z.string().min(1), finishedAt: z.string() }),
    execute: async ({ inputData }) => {
      executions.push(new Date().toISOString())
      await new Promise((resolve) => setTimeout(resolve, STEP_MS))
      return { label: inputData.label, finishedAt: new Date().toISOString() }
    },
  })

  const workflow = createWorkflow({
    id: WORKFLOW_ID,
    inputSchema: z.object({ label: z.string().min(1) }),
    outputSchema: z.object({ label: z.string().min(1), finishedAt: z.string() }),
  })
    .then(slowStep)
    .commit()

  const pubsub = new RedisStreamsPubSub({
    url: redisUrlForDatabase(database),
    reclaimIdleMs,
    // The default 30s tick would outlast the whole probe. This only decides how
    // often the claim is attempted, not what is eligible for it.
    reclaimIntervalMs: 1_000,
  })
  const storage = new PostgresStore({ id: WORKFLOW_ID, connectionString: nodePostgresUrl() })
  const mastra = new Mastra({
    storage,
    pubsub,
    workflows: { [WORKFLOW_ID]: workflow },
  })

  // A leftover stream from an earlier run of this file would be replayed into
  // the consumer the moment it subscribes.
  await pubsub.clearTopic("workflows")
  await pubsub.clearTopic("workflows-finish")
  await mastra.startWorkers()

  return {
    mastra,
    pubsub,
    storage,
    executions,
    run: async () => {
      const started = await mastra.getWorkflow(WORKFLOW_ID).createRun()
      await started.start({ inputData: { label: `db-${database}` } })
      await new Promise((resolve) => setTimeout(resolve, SETTLE_MS))
    },
  }
}

async function closeProbe(probe: Probe): Promise<void> {
  await probe.mastra.stopWorkers()
  await probe.pubsub.clearTopic("workflows")
  await probe.pubsub.clearTopic("workflows-finish")
  await probe.pubsub.close()
  await probe.storage.close?.()
}

describe("a step that outlives reclaimIdleMs", () => {
  let probe: Probe

  beforeAll(async () => {
    // 2s window against a 6s step: the entry is eligible for reclaim while the
    // first execution is still inside the body.
    probe = await createProbe(14, 2_000)
    await probe.run()
  }, 60_000)

  afterAll(async () => {
    if (probe) await closeProbe(probe)
  })

  it("is executed more than once for a single run, with one worker and no crash", () => {
    expect(probe.executions.length).toBeGreaterThan(1)
  })

  it("starts the duplicate before the first execution has finished", () => {
    const [first, second] = probe.executions
    expect(second).toBeDefined()
    expect(Date.parse(second) - Date.parse(first)).toBeLessThan(STEP_MS)
  })
})

describe("a step that finishes inside reclaimIdleMs", () => {
  let probe: Probe

  beforeAll(async () => {
    // 60s window against the same 6s step: the shape of the run is identical,
    // only the window differs.
    probe = await createProbe(15, 60_000)
    await probe.run()
  }, 60_000)

  afterAll(async () => {
    if (probe) await closeProbe(probe)
  })

  it("is executed exactly once", () => {
    expect(probe.executions).toHaveLength(1)
  })
})

describe("the app's own pubsub", () => {
  it("reclaims no sooner than 10 minutes, well past the slowest stage measured", () => {
    // `edit` took 75s and `images` 57s on the 4.7 end-to-end run; the incumbent
    // 60s default sat underneath both.
    expect(RECLAIM_IDLE_MS).toBeGreaterThanOrEqual(10 * 60_000)
  })

  it("passes that window to the RedisStreamsPubSub it constructs", () => {
    // `#reclaimIdleMs` is a private field, so the wiring cannot be read off the
    // instance. Checked at the source instead, because a constant nobody passes
    // leaves the 60s default in place while the assertion above still passes.
    const source = readFileSync(path.join(__dirname, "..", "index.ts"), "utf8")
    expect(source).toMatch(/new RedisStreamsPubSub\(\{[\s\S]{0,400}?reclaimIdleMs: RECLAIM_IDLE_MS/)
  })
})
