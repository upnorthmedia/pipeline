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
import { recordStageRetry } from "./stage-io"

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
