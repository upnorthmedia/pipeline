// @vitest-environment node
/**
 * Item 5.5c-i: the `posts.execution_logs` writer.
 *
 * Against the real database, because everything worth pinning here is a
 * property of the statement rather than of the object it builds: the append is
 * atomic under concurrency, it does not disturb `updated_at`, and the entry it
 * stores has to be readable by the two route handlers that already parse this
 * column.
 *
 * Requires `docker compose up -d db`.
 */
import { eq, sql } from "drizzle-orm"
import { afterAll, beforeEach, describe, expect, it } from "vitest"

import { closeDb, getDb, posts } from "../db"
import { appendExecutionLog, stageCostUsd } from "./execution-log"

const POST_ID = "00000000-0000-4000-8000-0000000055c1"

const db = getDb()

async function readLogs(id = POST_ID): Promise<Record<string, unknown>[]> {
  const [row] = await db.select({ logs: posts.executionLogs }).from(posts).where(eq(posts.id, id))
  return (row?.logs ?? []) as Record<string, unknown>[]
}

async function readUpdatedAt(id = POST_ID): Promise<Date | null> {
  const [row] = await db.select({ updatedAt: posts.updatedAt }).from(posts).where(eq(posts.id, id))
  return row?.updatedAt ?? null
}

beforeEach(async () => {
  await db.delete(posts).where(eq(posts.id, POST_ID))
  await db.insert(posts).values({ id: POST_ID, slug: "execution-log-writer", topic: "logging" })
})

afterAll(async () => {
  await db.delete(posts).where(eq(posts.id, POST_ID))
  await closeDb()
})

describe("appendExecutionLog", () => {
  it("stores Python's five keys and stamps the timestamp itself", async () => {
    await appendExecutionLog(POST_ID, {
      stage: "research",
      level: "info",
      event: "stage_start",
      message: "Starting research...",
    })
    const [entry] = await readLogs()
    expect(Object.keys(entry).sort()).toEqual(["event", "level", "message", "stage", "ts"])
    expect(entry).toMatchObject({
      stage: "research",
      level: "info",
      event: "stage_start",
      message: "Starting research...",
    })
    expect(Number.isNaN(Date.parse(entry.ts as string))).toBe(false)
  })

  it("writes the timestamp in the offset form Python's isoformat() produced", async () => {
    await appendExecutionLog(POST_ID, {
      stage: "",
      level: "info",
      event: "pipeline_complete",
      message: "Pipeline finished",
    })
    const [entry] = await readLogs()
    // Not `...Z`: `api/src/api/analytics.py` orders and bounds these entries by
    // string comparison on `ts` in SQL, and `Z` sorts above `+`, so a `Z` entry
    // would sort after every `+00:00` entry recorded in the same second.
    expect(entry.ts).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}\+00:00$/)
  })

  it("stores `data` when there is any and omits the key when there is not", async () => {
    await appendExecutionLog(POST_ID, {
      stage: "edit",
      level: "info",
      event: "stage_complete",
      message: "Stage edit complete",
      data: { model: "claude", tokens_in: 100, tokens_out: 20, duration_s: 1.5, cost_usd: 0.0033 },
    })
    // Python's `if data:` is false for an empty dict as well as for None, which
    // is the branch a stage with no `_stage_meta` took.
    await appendExecutionLog(POST_ID, {
      stage: "edit",
      level: "info",
      event: "stage_complete",
      message: "Stage edit complete",
      data: {},
    })
    const [withData, withoutData] = await readLogs()
    expect(withData.data).toEqual({
      model: "claude",
      tokens_in: 100,
      tokens_out: 20,
      duration_s: 1.5,
      cost_usd: 0.0033,
    })
    expect("data" in withoutData).toBe(false)
  })

  it("appends in call order rather than replacing", async () => {
    for (const event of ["pipeline_start", "stage_start", "stage_complete"]) {
      await appendExecutionLog(POST_ID, { stage: "", level: "info", event, message: event })
    }
    expect((await readLogs()).map((entry) => entry.event)).toEqual([
      "pipeline_start",
      "stage_start",
      "stage_complete",
    ])
  })

  it("keeps every entry when six stages append at once", async () => {
    // The reason Python issued this as `execution_logs || ...` rather than
    // reading the array and writing it back: a read-modify-write here loses
    // whatever another stage appended in between, and the concurrency item
    // already proved two runs share a row.
    await Promise.all(
      Array.from({ length: 6 }, (_, index) =>
        appendExecutionLog(POST_ID, {
          stage: "",
          level: "info",
          event: "log",
          message: `entry ${index}`,
        }),
      ),
    )
    const messages = (await readLogs()).map((entry) => entry.message)
    expect(messages).toHaveLength(6)
    expect([...messages].sort()).toEqual([
      "entry 0",
      "entry 1",
      "entry 2",
      "entry 3",
      "entry 4",
      "entry 5",
    ])
  })

  it("leaves `updated_at` where it was, as Python's raw SQL did", async () => {
    // SQLAlchemy's `onupdate` never fired for this statement, so a log line was
    // not a change to the post. Stamping it would reorder the posts list six
    // times per stage.
    await db
      .update(posts)
      .set({ updatedAt: new Date("2020-01-01T00:00:00Z") })
      .where(eq(posts.id, POST_ID))
    await appendExecutionLog(POST_ID, {
      stage: "write",
      level: "info",
      event: "stage_start",
      message: "Starting write...",
    })
    expect((await readUpdatedAt())?.toISOString()).toBe("2020-01-01T00:00:00.000Z")
  })

  it("writes nothing and raises nothing for a post that does not exist", async () => {
    await expect(
      appendExecutionLog("00000000-0000-4000-8000-0000000055ff", {
        stage: "",
        level: "error",
        event: "stage_error",
        message: "gone",
      }),
    ).resolves.toBeUndefined()
  })

  it("stores an entry the logs route's filters can read back", async () => {
    await appendExecutionLog(POST_ID, {
      stage: "images",
      level: "warning",
      event: "log",
      message: "image 2 failed",
    })
    // The three expressions `GET /api/analytics/logs` applies in SQL, run here
    // so the stored shape is checked by the reader rather than by its author.
    const result = await db.execute(sql`
      SELECT entry->>'level' AS level, entry->>'stage' AS stage, entry->>'ts' AS ts
      FROM posts p, jsonb_array_elements(p.execution_logs) AS entry
      WHERE p.id = ${POST_ID}
    `)
    const [row] = result.rows
    expect(row).toMatchObject({ level: "warning", stage: "images" })
    expect(typeof row.ts).toBe("string")
  })
})

describe("stageCostUsd", () => {
  it("prices both token counts at Python's hardcoded Opus rates", () => {
    // `round((100/1e6 * 15.0) + (20/1e6 * 75.0), 6)` = 0.0015 + 0.0015.
    expect(stageCostUsd(100, 20)).toBe(0.003)
    expect(stageCostUsd(0, 0)).toBe(0)
  })

  it("rounds to six places the way Python's round() does", () => {
    // 1 input token is 1.5e-5, so the sixth place is where a stage's cost stops
    // being distinguishable at all.
    expect(stageCostUsd(1, 0)).toBe(0.000015)
    expect(stageCostUsd(1, 1)).toBe(0.00009)
  })
})
