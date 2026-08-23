// @vitest-environment node
/**
 * Item 5.5c-iv: `publishStageLog()`, the progress line a stage writes about its
 * own internals.
 *
 * Driven directly rather than through a step, because the two properties that
 * matter most here are ones no stage can be made to show. The publish has to
 * happen before the append (a stage only ever does both, in order, and both
 * succeed), and the append has to be allowed to fail without taking the stage
 * with it (a stage whose post row exists never sees that branch). Both are
 * asserted against the real database and a transport stub that can observe the
 * row at the instant the event goes out.
 *
 * The call sites themselves are asserted in `outline.test.ts`, `write.test.ts`,
 * `ready.test.ts` and, on a real Redis Streams topic, in
 * `pipeline-events.test.ts`.
 *
 * Requires `docker compose up -d db`.
 */
import { eq } from "drizzle-orm"
import { afterAll, beforeEach, describe, expect, it } from "vitest"

import { closeDb, getDb, posts } from "../../db"
import { publishStageLog } from "./stage-io"
import type { StageLogContext } from "./stage-io"

const POST_ID = "00000000-0000-4000-8000-0000000055d1"
/** Not a uuid, so the append's `WHERE id = ...` fails in postgres rather than matching nothing. */
const BROKEN_POST_ID = "not-a-uuid"

const db = getDb()

async function readLogs(id = POST_ID): Promise<Record<string, unknown>[]> {
  const [row] = await db.select({ logs: posts.executionLogs }).from(posts).where(eq(posts.id, id))
  return (row?.logs ?? []) as Record<string, unknown>[]
}

/**
 * A `mastra` carrying only what the helper reads: the transport, and a logger
 * whose `debug` calls are collected instead of printed.
 *
 * `onPublish` runs inside `publish`, which `publishStageLog` awaits, so a test
 * can read the row at the instant the event is delivered. That is the only
 * deterministic way to order a publish against a database write from outside:
 * a subscriber's own `SELECT` is a slower round trip than the `UPDATE` it is
 * racing, so a swapped order still passes.
 */
function harness(onPublish?: () => Promise<void>) {
  const published: Record<string, unknown>[] = []
  const debugged: { message: string; args: unknown[] }[] = []
  const mastra = {
    pubsub: {
      publish: async (_topic: string, event: { data: Record<string, unknown> }) => {
        published.push(event.data)
        if (onPublish) await onPublish()
      },
    },
    getLogger: () => ({
      debug: (message: string, ...args: unknown[]) => {
        debugged.push({ message, args })
      },
    }),
  }
  return { mastra: mastra as unknown as StageLogContext, published, debugged }
}

beforeEach(async () => {
  await db.delete(posts).where(eq(posts.id, POST_ID))
  await db.insert(posts).values({ id: POST_ID, slug: "stage-log-writer", topic: "logging" })
})

afterAll(async () => {
  await db.delete(posts).where(eq(posts.id, POST_ID))
  await closeDb()
})

describe("publishStageLog", () => {
  it("publishes Python's payload under the default `log` event name", async () => {
    const { mastra, published } = harness()

    await publishStageLog(mastra, POST_ID, "outline", "Rules loaded...")

    expect(published).toHaveLength(1)
    expect(Object.keys(published[0]).sort()).toEqual([
      "event",
      "level",
      "message",
      "post_id",
      "stage",
      "timestamp",
    ])
    expect(published[0]).toMatchObject({
      event: "log",
      post_id: POST_ID,
      stage: "outline",
      message: "Rules loaded...",
      level: "info",
    })
  })

  it("stamps the timestamp in the offset form the stored entries use", async () => {
    const { mastra, published } = harness()

    await publishStageLog(mastra, POST_ID, "outline", "Rules loaded...")

    expect(published[0].timestamp).toMatch(/^\d{4}-\d{2}-\d{2}T[\d:.]+\+00:00$/)
  })

  it("writes the same line to execution_logs", async () => {
    const { mastra } = harness()

    await publishStageLog(mastra, POST_ID, "write", "Calling Claude...")

    const logs = await readLogs()
    expect(logs).toHaveLength(1)
    expect(Object.keys(logs[0]).sort()).toEqual(["event", "level", "message", "stage", "ts"])
    expect(logs[0]).toMatchObject({
      stage: "write",
      level: "info",
      event: "log",
      message: "Calling Claude...",
    })
  })

  it("carries a call site's own level and event name to both", async () => {
    const { mastra, published } = harness()

    await publishStageLog(mastra, POST_ID, "edit", "Retrying...", {
      level: "warning",
      event: "stage_warning",
    })

    expect(published[0]).toMatchObject({ event: "stage_warning", level: "warning" })
    const [entry] = await readLogs()
    expect(entry).toMatchObject({ event: "stage_warning", level: "warning" })
  })

  it("carries `data` onto both the event and the entry", async () => {
    const { mastra, published } = harness()

    await publishStageLog(mastra, POST_ID, "images", "Generated", {
      data: { count: 3 },
    })

    expect(published[0].data).toEqual({ count: 3 })
    const [entry] = await readLogs()
    expect(entry.data).toEqual({ count: 3 })
  })

  it("omits `data` from both when it is an empty object, per Python's `if data:`", async () => {
    const { mastra, published } = harness()

    await publishStageLog(mastra, POST_ID, "images", "Nothing to add", {
      data: {},
    })

    expect(published[0]).not.toHaveProperty("data")
    const [entry] = await readLogs()
    expect(entry).not.toHaveProperty("data")
  })

  it("publishes before it appends, which is the reverse of the stage announcements", async () => {
    let logsAtPublish: Record<string, unknown>[] | undefined
    const { mastra } = harness(async () => {
      logsAtPublish = await readLogs()
    })

    await publishStageLog(mastra, POST_ID, "ready", "Assembly done")

    expect(logsAtPublish).toEqual([])
    expect(await readLogs()).toHaveLength(1)
  })

  it("swallows an append failure, reports it at debug, and still published", async () => {
    const { mastra, published, debugged } = harness()

    await expect(
      publishStageLog(mastra, BROKEN_POST_ID, "ready", "Assembly done"),
    ).resolves.toBeUndefined()

    expect(published).toHaveLength(1)
    expect(debugged).toHaveLength(1)
    expect(debugged[0].message).toBe("failed to persist execution log entry")
    expect(String((debugged[0].args[0] as { error: unknown }).error)).toMatch(/uuid/i)
  })

  it("swallows an append failure with no logger configured at all", async () => {
    const { published } = harness()
    const noLogger = {
      pubsub: {
        publish: async (_topic: string, event: { data: Record<string, unknown> }) => {
          published.push(event.data)
        },
      },
    } as unknown as StageLogContext

    await expect(
      publishStageLog(noLogger, BROKEN_POST_ID, "ready", "Assembly done"),
    ).resolves.toBeUndefined()

    expect(published).toHaveLength(1)
  })
})
