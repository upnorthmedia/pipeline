// @vitest-environment node
/**
 * Phase 2 item 2.4: a second process subscribed to the Redis Streams topic
 * receives the same workflow events.
 *
 * This is the property the whole `web` / `worker` split rests on. If workflow
 * lifecycle events do not leave the process that starts a run, then `web`
 * cannot hand execution to `worker` (item 4.4) and the SSE route cannot serve
 * a trace for a run executing elsewhere (item 5.5).
 *
 * The observer is a real child process (`scripts/redis-event-observer.mjs`)
 * that shares nothing with this one but the Redis connection string, so a
 * received event provably crossed a process boundary rather than an in-memory
 * EventEmitter.
 *
 * Requires `docker compose up -d db redis`.
 */
import { spawn, type ChildProcessByStdio } from "node:child_process"
import path from "node:path"
import { createInterface } from "node:readline"
import type { Readable } from "node:stream"

import { afterAll, beforeAll, describe, expect, it } from "vitest"

import { closeDb } from "../db"
import { mastra, pubsub } from "./index"
import { scaffoldCheckWorkflow } from "./workflows/scaffold-check"

type ObserverEvent = {
  kind: "event"
  topic: string
  type: string
  runId: string | null
  workflowId: string | null
}

const OBSERVER = path.resolve(__dirname, "scripts/redis-event-observer.mjs")
const WEB_ROOT = path.resolve(__dirname, "../..")

/** `stdio: ["ignore", "pipe", "pipe"]` means no stdin and two readable pipes. */
type ObserverProcess = ChildProcessByStdio<null, Readable, Readable>

type Observer = {
  child: ObserverProcess
  /** Everything the child reported, in arrival order. */
  events: ObserverEvent[]
  stderr: () => string
}

/** Spawns the observer and resolves once it reports every topic subscribed. */
async function startObserver(topics: string[]): Promise<Observer> {
  const child = spawn(process.execPath, [OBSERVER, process.env.REDIS_URL!, ...topics], {
    cwd: WEB_ROOT,
    stdio: ["ignore", "pipe", "pipe"],
  })
  const events: ObserverEvent[] = []
  let stderr = ""
  child.stderr.setEncoding("utf8")
  child.stderr.on("data", (chunk: string) => {
    stderr += chunk
  })

  await new Promise<void>((resolve, reject) => {
    const failed = setTimeout(() => reject(new Error(`observer never became ready: ${stderr}`)), 30_000)
    createInterface({ input: child.stdout }).on("line", (line) => {
      const message = JSON.parse(line) as { kind: string }
      if (message.kind === "ready") {
        clearTimeout(failed)
        resolve()
        return
      }
      events.push(message as ObserverEvent)
    })
    child.once("error", reject)
  })

  return { child, events, stderr: () => stderr }
}

/** Resolves once `observer` has reported an event matching `predicate`. */
function waitFor(observer: Observer, predicate: (e: ObserverEvent) => boolean, timeoutMs: number): Promise<void> {
  return new Promise((resolve, reject) => {
    const deadline = setTimeout(
      () => reject(new Error(`observer never reported a matching event within ${timeoutMs}ms`)),
      timeoutMs,
    )
    const poll = setInterval(() => {
      if (observer.events.some(predicate)) {
        clearInterval(poll)
        clearTimeout(deadline)
        resolve()
      }
    }, 25)
  })
}

let shared: Observer
let runLocal: Observer
let runId: string
let localTypes: string[]
let finalStatus: string

beforeAll(async () => {
  shared = await startObserver(["workflows", "workflows-finish"])

  // The orchestration worker is what consumes `workflows` and drives the
  // evented engine. Without it the run is published and never executed; that
  // is exactly the division of labour item 4.4 formalises across two hosts.
  await mastra.startWorkers()

  const run = await scaffoldCheckWorkflow.createRun()
  runId = run.runId
  const stream = run.stream({ inputData: { message: "phase-2 cross-process" } })
  localTypes = []
  for await (const event of stream.fullStream) {
    localTypes.push((event as { type: string }).type)
  }
  await stream.result
  finalStatus = stream.status

  await waitFor(shared, (e) => e.runId === runId && e.topic === "workflows-finish", 30_000)

  // A third process, started after the run finished. Redis Streams consumer
  // groups anchor at the head of the stream, so it would replay the run's
  // whole history if any of it had actually been written to Redis.
  runLocal = await startObserver([`workflow.events.v2.${runId}`])
  await new Promise((resolve) => setTimeout(resolve, 1_000))
}, 120_000)

afterAll(async () => {
  shared?.child.kill("SIGTERM")
  runLocal?.child.kill("SIGTERM")
  await mastra.stopWorkers()
  await pubsub.close()
  await closeDb()
})

/** Only the run this test started; the topics are shared with every other run. */
function forThisRun(): ObserverEvent[] {
  return shared.events.filter((e) => e.runId === runId)
}

describe("workflow events across a process boundary", () => {
  it("the observed run succeeded locally, so observation did not disturb it", () => {
    expect(shared.stderr()).toBe("")
    expect(finalStatus).toBe("success")
    expect(localTypes).toContain("workflow-finish")
  })

  it("delivers the run's lifecycle events to the second process", () => {
    const mine = forThisRun()
    expect(mine.length).toBeGreaterThan(0)
    expect(mine.every((e) => e.workflowId === "scaffold-check")).toBe(true)

    const onWorkflows = mine.filter((e) => e.topic === "workflows").map((e) => e.type)
    // Start, one run/end pair per step, then the terminal event.
    expect(onWorkflows[0]).toBe("workflow.start")
    expect(onWorkflows.filter((t) => t === "workflow.step.run")).toHaveLength(2)
    expect(onWorkflows.filter((t) => t === "workflow.step.end")).toHaveLength(2)
    expect(onWorkflows).toContain("workflow.end")
  })

  it("delivers the terminal event on the workflows-finish topic", () => {
    const finish = forThisRun().filter((e) => e.topic === "workflows-finish")
    expect(finish).toHaveLength(1)
    // The same `workflow.end` event lands on both topics: `workflows` drives
    // the engine, `workflows-finish` is the one a run-completion listener can
    // subscribe to without seeing every step.
    expect(finish[0].type).toBe("workflow.end")
  })

  it("keeps the per-run stream topic inside the executing process", () => {
    // `workflow.events.v2.*` is tagged `localOnly` by the `mastra.pubsub`
    // proxy, so it never reaches Redis. Phase 5's SSE route therefore cannot
    // read a worker-side run's chunks from this topic: it has to work from
    // `workflows` or from Mastra's own resumable-stream replay.
    expect(runLocal.stderr()).toBe("")
    expect(runLocal.events).toEqual([])
  })
})
