// @vitest-environment node
/**
 * Item 5.5c-iii-b-2-a: the `warning` / `retry` entry a stage writes on its way
 * out, from Python's `if job_try < MAX_ATTEMPTS:` branch
 * (`api/src/worker.py:333`).
 *
 * `failure-recorder.test.ts` covers this through a real failing run, which is
 * where the interleaving with `stage_start` and the final `stage_error` entry
 * is pinned. What a real run cannot reach is the boundary itself: a run only
 * ever fails on its last attempt, so the branch that writes nothing is invisible
 * from there. These drive `recordStageRetry` directly against the real database
 * for that boundary, for the thrown non-`Error`, and for the exact stored shape.
 *
 * Requires `docker compose up -d db`.
 */
import { eq } from "drizzle-orm"
import { afterAll, beforeEach, describe, expect, it } from "vitest"

import { closeDb, getDb, posts } from "../../db"
import { MAX_ATTEMPTS } from "../state"
import { RETRY_DELAY_MS, recordStageRetry, retryDelayMs } from "./stage-io"

const POST_ID = "00000000-0000-4000-8000-00000005c3b2"

const db = getDb()

async function readLogs(): Promise<Record<string, unknown>[]> {
  const [row] = await db
    .select({ logs: posts.executionLogs })
    .from(posts)
    .where(eq(posts.id, POST_ID))
  return (row?.logs ?? []) as Record<string, unknown>[]
}

beforeEach(async () => {
  await db.delete(posts).where(eq(posts.id, POST_ID))
  await db.insert(posts).values({ id: POST_ID, slug: "stage-retry-record", topic: "retrying" })
})

afterAll(async () => {
  await db.delete(posts).where(eq(posts.id, POST_ID))
  await closeDb()
})

describe("recordStageRetry", () => {
  it("writes Python's entry for the first failure, with retryCount read as job_try", async () => {
    await recordStageRetry("write", POST_ID, 0, new Error("provider exploded"))
    expect(await readLogs()).toEqual([
      {
        ts: expect.any(String),
        stage: "write",
        level: "warning",
        event: "retry",
        // Python's `f"Pipeline attempt {job_try} failed, retrying..."`. The
        // engine counts retries after the first execution, so `retryCount` 0 is
        // attempt 1.
        message: "Pipeline attempt 1 failed, retrying...",
        data: { attempt: 1, max_attempts: MAX_ATTEMPTS, error: "provider exploded" },
      },
    ])
  })

  it("writes nothing on the attempt that spends the last one, Python's else branch", async () => {
    // `retryCount === MAX_ATTEMPTS - 1` is the last execution the workflow's
    // `attempts` allows, so no retry follows it and the entry that promises one
    // would be a lie. `failure-recorder.ts` writes the `stage_error` entry for
    // this attempt instead.
    await recordStageRetry("write", POST_ID, MAX_ATTEMPTS - 1, new Error("provider exploded"))
    expect(await readLogs()).toEqual([])
  })

  it("writes an entry for every attempt before the last one", async () => {
    for (let retryCount = 0; retryCount < MAX_ATTEMPTS; retryCount += 1) {
      await recordStageRetry("edit", POST_ID, retryCount, new Error("boom"))
    }
    expect((await readLogs()).map((entry) => entry.data)).toEqual(
      Array.from({ length: MAX_ATTEMPTS - 1 }, (_, index) => ({
        attempt: index + 1,
        max_attempts: MAX_ATTEMPTS,
        error: "boom",
      })),
    )
  })

  it("records a thrown non-Error the way Python's str(e) would", async () => {
    await recordStageRetry("images", POST_ID, 0, "a bare string was thrown")
    const [entry] = await readLogs()
    expect((entry.data as { error: string }).error).toBe("a bare string was thrown")
  })

  it("names the stage that threw, which is what the log reader groups on", async () => {
    await recordStageRetry("ready", POST_ID, 0, new Error("boom"))
    const [entry] = await readLogs()
    expect(entry.stage).toBe("ready")
  })

  it("timestamps the entry in the offset form the analytics query sorts on", async () => {
    await recordStageRetry("outline", POST_ID, 0, new Error("boom"))
    const [entry] = await readLogs()
    expect(entry.ts).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}\+00:00$/)
  })
})

/**
 * Item P2.39: the pause between attempts, Python's `WorkerSettings.retry_delay
 * = 10` (`api/src/worker.py:610`).
 *
 * ARQ spent it in the queue, so the delay cost the worker nothing. Mastra's
 * evented processor has no counterpart: its only `retryConfig` reference reads
 * `attempts` and republishes `workflow.step.run` straight away. The only place
 * the spacing can live is therefore inside the step, on the way out, which is
 * where the attempt number already is.
 *
 * These drive it with a short delay rather than the real ten seconds. The suite
 * runs with the delay switched off entirely, which the last test pins.
 */
describe("the pause before the retry", () => {
  async function withDelay<T>(ms: string, body: () => Promise<T>): Promise<T> {
    const previous = process.env.STAGE_RETRY_DELAY_MS
    process.env.STAGE_RETRY_DELAY_MS = ms
    try {
      return await body()
    } finally {
      if (previous === undefined) delete process.env.STAGE_RETRY_DELAY_MS
      else process.env.STAGE_RETRY_DELAY_MS = previous
    }
  }

  async function elapsed(body: () => Promise<unknown>): Promise<number> {
    const started = performance.now()
    await body()
    return performance.now() - started
  }

  it("holds for the configured delay before the stage rethrows", async () => {
    const took = await withDelay("300", () =>
      elapsed(() => recordStageRetry("write", POST_ID, 0, new Error("429 rate limited"))),
    )
    expect(took).toBeGreaterThanOrEqual(290)
  })

  it("writes the retry entry before it waits, so the pause is visible as a gap", async () => {
    // The user-facing point of the delay is that the log says "retrying..." and
    // then nothing happens for ten seconds. Writing the entry after the wait
    // would make the run look hung instead.
    await withDelay("300", async () => {
      const record = recordStageRetry("write", POST_ID, 0, new Error("429 rate limited"))
      await new Promise((resolve) => setTimeout(resolve, 100))
      expect(await readLogs()).toHaveLength(1)
      await record
    })
  })

  it("does not wait on the attempt that spends the last one", async () => {
    // Python re-queued with the delay only when a retry followed. The last
    // failure goes straight to the run's failure, so a pause here would be ten
    // seconds added to every failed run for nothing.
    const took = await withDelay("3000", () =>
      elapsed(() =>
        recordStageRetry("write", POST_ID, MAX_ATTEMPTS - 1, new Error("429 rate limited")),
      ),
    )
    expect(took).toBeLessThan(1000)
  })

  it("returns straight away when the run has been aborted", async () => {
    // A cancelled run should not sit in a pause waiting to retry work nobody
    // wants any more, and neither should a worker being shut down.
    const controller = new AbortController()
    controller.abort()
    const took = await withDelay("3000", () =>
      elapsed(() =>
        recordStageRetry("write", POST_ID, 0, new Error("429 rate limited"), controller.signal),
      ),
    )
    expect(took).toBeLessThan(1000)
  })

  it("stops waiting when the run is aborted mid-pause", async () => {
    const controller = new AbortController()
    setTimeout(() => controller.abort(), 100)
    const took = await withDelay("3000", () =>
      elapsed(() =>
        recordStageRetry("write", POST_ID, 0, new Error("429 rate limited"), controller.signal),
      ),
    )
    expect(took).toBeLessThan(1000)
  })

  it("is ten seconds when nothing overrides it, which is Python's value", () => {
    expect(retryDelayMs({})).toBe(RETRY_DELAY_MS)
    expect(RETRY_DELAY_MS).toBe(10_000)
  })

  it("falls back to Python's value for an override that is not a number", () => {
    expect(retryDelayMs({ STAGE_RETRY_DELAY_MS: "" })).toBe(RETRY_DELAY_MS)
    expect(retryDelayMs({ STAGE_RETRY_DELAY_MS: "soon" })).toBe(RETRY_DELAY_MS)
    expect(retryDelayMs({ STAGE_RETRY_DELAY_MS: "-1" })).toBe(RETRY_DELAY_MS)
  })

  it("is switched off for the suite, which is what keeps the retry suites fast", () => {
    // `vitest.config.ts` sets this. Five suites drive real failing runs through
    // the engine's retry branch, and every one of them would gain
    // `(MAX_ATTEMPTS - 1) * 10s` per run without it, which is past the 45s
    // harness timeout. This fails if that line is ever removed.
    expect(retryDelayMs()).toBe(0)
  })
})
