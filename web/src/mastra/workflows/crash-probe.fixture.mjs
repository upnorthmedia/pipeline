/**
 * Ledger item 4.5a: what the built-in evented engine does when the process
 * executing a step is killed.
 *
 * This is the engine-guarantee half of the durability gate, kept deliberately
 * apart from the pipeline. Item 4.5b kills a worker mid-`write` on the real
 * bundle and bills a real provider for it; this module answers the cheaper and
 * more general question first, so the branch in the ledger (built-in engine,
 * startup sweep, or `@mastra/inngest`) is decided by evidence that costs
 * nothing and can stay in the suite as a regression test.
 *
 * The workflow is two steps:
 *   - `probe-first` records that it ran and returns,
 *   - `probe-slow` records that it started, sleeps, then records that it
 *     finished.
 *
 * `probe-slow`'s sleep is the window in which the worker is killed. Nothing
 * here touches a provider, a post row or the media directory, so the whole
 * probe is free and deterministic.
 *
 * Records go to an append-only JSONL file rather than to a table or to Redis:
 * the point of the probe is what survives a `SIGKILL`, so the record of "this
 * step body executed in this process" has to be written by the step itself,
 * outside any transaction or buffer the engine controls, and be readable by a
 * test process and by two successive worker processes without coordination.
 *
 * Run directly (`node crash-probe.fixture.mjs`) it is a worker process: it
 * builds the same instance and calls `mastra.startWorkers()`. Imported, it is
 * the `web` side, which starts runs and reads their state and never executes
 * anything. Both sides go through `createProbeMastra`, so the workflow graph
 * the test publishes is the graph the worker executes.
 *
 * Configuration comes from the environment when it runs as a worker:
 *   PROBE_REDIS_URL    Redis URL, including the isolating database number
 *   PROBE_MARKER_FILE  path of the JSONL record file
 *   PROBE_SLEEP_MS     how long `probe-slow` sleeps
 *   DATABASE_URL_SYNC / DATABASE_URL   Postgres, for run state
 */
import { appendFileSync, readFileSync } from "node:fs"
import { pathToFileURL } from "node:url"

import { Mastra } from "@mastra/core"
import { createStep, createWorkflow } from "@mastra/core/workflows/evented"
import { PostgresStore } from "@mastra/pg"
import { RedisStreamsPubSub } from "@mastra/redis-streams"
import { z } from "zod"

export const PROBE_WORKFLOW_ID = "crash-probe"

const probeInput = z.object({ label: z.string().min(1) })
const probeAfterFirst = probeInput.extend({ firstAt: z.string() })
const probeOutput = probeAfterFirst.extend({ slowAt: z.string() })

/**
 * One JSON object per line, appended with a single `O_APPEND` write so two
 * processes can record into the same file without a lock.
 */
function record(markerFile, entry) {
  appendFileSync(markerFile, `${JSON.stringify({ ...entry, pid: process.pid, at: new Date().toISOString() })}\n`)
}

/** Every record written so far. An absent file means nothing has run yet. */
export function readProbeRecords(markerFile) {
  let text
  try {
    text = readFileSync(markerFile, "utf8")
  } catch (err) {
    if (err.code === "ENOENT") return []
    throw err
  }
  return text
    .split("\n")
    .filter((line) => line.length > 0)
    .map((line) => JSON.parse(line))
}

/**
 * `pg` understands neither of the driver prefixes the repo `.env` carries; the
 * TypeScript side normalises them in `src/db/index.ts`, and this module cannot
 * import that.
 */
function toNodePostgresUrl(url) {
  return url.replace(/^postgresql\+\w+:\/\//, "postgresql://")
}

export function createProbeMastra({ redisUrl, databaseUrl, markerFile, sleepMs }) {
  if (!redisUrl) throw new Error("crash-probe: redisUrl is required")
  if (!databaseUrl) throw new Error("crash-probe: databaseUrl is required")
  if (!markerFile) throw new Error("crash-probe: markerFile is required")
  if (!Number.isFinite(sleepMs)) throw new Error("crash-probe: sleepMs is required")

  const first = createStep({
    id: "probe-first",
    inputSchema: probeInput,
    outputSchema: probeAfterFirst,
    execute: async ({ inputData }) => {
      const firstAt = new Date().toISOString()
      record(markerFile, { step: "probe-first", phase: "done", label: inputData.label })
      return { ...inputData, firstAt }
    },
  })

  const slow = createStep({
    id: "probe-slow",
    inputSchema: probeAfterFirst,
    outputSchema: probeOutput,
    execute: async ({ inputData }) => {
      record(markerFile, { step: "probe-slow", phase: "start", label: inputData.label })
      await new Promise((resolve) => setTimeout(resolve, sleepMs))
      const slowAt = new Date().toISOString()
      record(markerFile, { step: "probe-slow", phase: "done", label: inputData.label })
      return { ...inputData, slowAt }
    },
  })

  const workflow = createWorkflow({
    id: PROBE_WORKFLOW_ID,
    inputSchema: probeInput,
    outputSchema: probeOutput,
  })
    .then(first)
    .then(slow)
    .commit()

  const pubsub = new RedisStreamsPubSub({ url: redisUrl })
  const storage = new PostgresStore({
    id: "crash-probe",
    connectionString: toNodePostgresUrl(databaseUrl),
  })
  const mastra = new Mastra({
    storage,
    pubsub,
    workflows: { [PROBE_WORKFLOW_ID]: workflow },
  })

  return { mastra, workflow: mastra.getWorkflow(PROBE_WORKFLOW_ID), pubsub, storage }
}

const invokedDirectly =
  process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href

if (invokedDirectly) {
  const { mastra } = createProbeMastra({
    redisUrl: process.env.PROBE_REDIS_URL,
    databaseUrl: process.env.DATABASE_URL_SYNC ?? process.env.DATABASE_URL,
    markerFile: process.env.PROBE_MARKER_FILE,
    sleepMs: Number(process.env.PROBE_SLEEP_MS),
  })
  await mastra.startWorkers()
  // The line the test waits for before it starts a run, so "nothing consumed
  // it" can never mean "the consumer had not subscribed yet".
  console.log(`[crash-probe] workers started pid=${process.pid}`)
}
