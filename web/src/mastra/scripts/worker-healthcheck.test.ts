// @vitest-environment node
/**
 * Item 7.1c: the container healthcheck the compose `worker` service runs.
 *
 * The script is exercised two ways, because it makes two different kinds of
 * claim:
 *
 *   - its RESP client and liveness arithmetic are driven against a real Redis
 *     with hand-built streams, so "no group", "a consumer that just read" and
 *     "a consumer that has been idle past the limit" are exact states rather
 *     than timing luck;
 *   - the four constants it restates (topic, group, key prefix, idle limit)
 *     are pinned against `worker-health.ts`, which is where a real
 *     `mastra.startWorkers()` already proves them. Two copies of a constant
 *     only stay honest if something compares them.
 *
 * Requires `docker compose up -d redis`.
 */
import { execFile } from "node:child_process"
import { fileURLToPath } from "node:url"
import { promisify } from "node:util"

import { createClient } from "redis"
import { afterAll, beforeAll, describe, expect, it } from "vitest"

import {
  ORCHESTRATION_GROUP,
  ORCHESTRATION_TOPIC,
  STREAM_KEY_PREFIX,
  WORKER_ALIVE_IDLE_LIMIT_MS,
} from "../worker-health"
import {
  IDLE_LIMIT_MS,
  ORCHESTRATION_GROUP as SCRIPT_GROUP,
  ORCHESTRATION_TOPIC as SCRIPT_TOPIC,
  STREAM_KEY_PREFIX as SCRIPT_PREFIX,
  checkWorkerAlive,
  liveConsumerCount,
  parseRedisUrl,
  parseReply,
  streamKey,
} from "./worker-healthcheck.mjs"

const run = promisify(execFile)
const scriptPath = fileURLToPath(new URL("./worker-healthcheck.mjs", import.meta.url))
const redisUrl = process.env.REDIS_URL ?? "redis://localhost:6379"

/** Its own keys, so a real worker on the default topic cannot answer for it. */
const TEST_STREAM = `mastra:topic:worker-healthcheck-test-${process.pid}`

let redis: ReturnType<typeof createClient>

beforeAll(async () => {
  redis = createClient({ url: redisUrl })
  await redis.connect()
  await redis.del(TEST_STREAM)
})

afterAll(async () => {
  await redis.del(TEST_STREAM)
  await redis.close()
})

/** Joins the group and reads, which is what registers a live consumer. */
async function joinAsConsumer(name: string): Promise<void> {
  await redis.xReadGroup(ORCHESTRATION_GROUP, name, { key: TEST_STREAM, id: ">" }, { COUNT: 1 })
}

describe("worker-healthcheck constants", () => {
  it("restates the values worker-health.ts pins against a real Mastra worker", () => {
    expect(SCRIPT_TOPIC).toBe(ORCHESTRATION_TOPIC)
    expect(SCRIPT_GROUP).toBe(ORCHESTRATION_GROUP)
    expect(SCRIPT_PREFIX).toBe(STREAM_KEY_PREFIX)
    expect(IDLE_LIMIT_MS).toBe(WORKER_ALIVE_IDLE_LIMIT_MS)
    expect(streamKey()).toBe(`${STREAM_KEY_PREFIX}:${ORCHESTRATION_TOPIC}`)
  })
})

describe("parseRedisUrl", () => {
  it("defaults the port and database when the url omits them", () => {
    expect(parseRedisUrl("redis://redis")).toEqual({
      host: "redis",
      port: 6379,
      username: "",
      password: "",
      db: 0,
    })
  })

  it("carries the credentials and database a managed Redis url puts in the path", () => {
    expect(parseRedisUrl("redis://default:s3cr%40t@redis.internal:6380/9")).toEqual({
      host: "redis.internal",
      port: 6380,
      username: "default",
      password: "s3cr@t",
      db: 9,
    })
  })

  it("refuses a protocol it cannot actually speak rather than guessing", () => {
    expect(() => parseRedisUrl("rediss://redis:6379")).toThrow(/unsupported REDIS_URL protocol/)
  })
})

describe("parseReply", () => {
  it("reads the nested arrays XINFO CONSUMERS returns under RESP2", () => {
    const reply = "*1\r\n*4\r\n$4\r\nname\r\n$3\r\nw-1\r\n$4\r\nidle\r\n:42\r\n"
    expect(parseReply(reply)).toEqual({
      value: [["name", "w-1", "idle", 42]],
      next: reply.length,
    })
  })

  it("returns null for a reply the socket has not finished delivering", () => {
    expect(parseReply("*1\r\n*4\r\n$4\r\nname\r\n$3\r\nw-")).toBeNull()
  })

  it("returns null for a bulk string whose declared length has not arrived", () => {
    // The trailing item is the case an array's own item count cannot catch:
    // without a length check the short value parses as if it were complete.
    expect(parseReply("$4\r\nab")).toBeNull()
  })

  it("surfaces a Redis error reply as an Error rather than a value", () => {
    const parsed = parseReply("-NOGROUP No such consumer group\r\n")
    expect(parsed?.value).toBeInstanceOf(Error)
    expect((parsed?.value as Error).message).toMatch(/^NOGROUP/)
  })
})

describe("liveConsumerCount", () => {
  it("counts only consumers under the idle limit", () => {
    const consumers = [
      ["name", "alive", "pending", 0, "idle", 900, "inactive", 900],
      ["name", "dead", "pending", 0, "idle", 60_000, "inactive", 60_000],
    ]
    expect(liveConsumerCount(consumers)).toBe(1)
  })

  it("reads idle by field name, not by position", () => {
    expect(liveConsumerCount([["idle", 5, "name", "w-1"]])).toBe(1)
  })
})

describe("checkWorkerAlive against a real Redis", () => {
  it("reports no worker when the group does not exist yet", async () => {
    await expect(checkWorkerAlive(redisUrl, { streamKey: TEST_STREAM })).resolves.toBe(0)
  })

  it("reports a worker once one has joined the group and read", async () => {
    await redis.xGroupCreate(TEST_STREAM, ORCHESTRATION_GROUP, "$", { MKSTREAM: true })
    await joinAsConsumer("worker-alive")
    await expect(checkWorkerAlive(redisUrl, { streamKey: TEST_STREAM })).resolves.toBe(1)
  })

  it("sends AUTH when the url carries a password", async () => {
    // Local Redis has no `requirepass`, so it answers a password with
    // "ERR Client sent AUTH, but no password is set". That error is only
    // reachable if the AUTH command was actually written, which is the claim.
    const withPassword = new URL(redisUrl)
    withPassword.password = "not-the-password"
    await expect(
      checkWorkerAlive(withPassword.href, { streamKey: TEST_STREAM }),
    ).rejects.toThrow(/AUTH/i)
  })

  it("stops counting a consumer whose idle time passed the limit", async () => {
    // The consumer from the previous case is still registered: the transport
    // never runs XGROUP DELCONSUMER, so an idle limit is the only thing that
    // distinguishes a running worker from one that exited weeks ago.
    await expect(
      checkWorkerAlive(redisUrl, { streamKey: TEST_STREAM, idleLimitMs: 1 }),
    ).resolves.toBe(0)
  })
})

describe("worker-healthcheck.mjs as a container healthcheck", () => {
  it("exits non-zero, naming the group, when no worker is consuming", async () => {
    // The script reads the default stream key, so this points it at a Redis
    // database no worker uses rather than deleting the real orchestration
    // stream out from under one.
    const emptyDb = new URL(redisUrl)
    emptyDb.pathname = "/14"
    const failure = await run("node", [scriptPath], {
      env: { ...process.env, REDIS_URL: emptyDb.href },
    }).catch((error: { code?: number; stderr?: string }) => error)

    expect((failure as { code?: number }).code).toBe(1)
    expect((failure as { stderr?: string }).stderr).toContain(ORCHESTRATION_GROUP)
  })

  it("exits non-zero when REDIS_URL is unset", async () => {
    const env = { ...process.env }
    delete env.REDIS_URL
    const failure = await run("node", [scriptPath], { env }).catch(
      (error: { code?: number; stderr?: string }) => error,
    )

    expect((failure as { code?: number }).code).toBe(1)
    expect((failure as { stderr?: string }).stderr).toContain("REDIS_URL must be set")
  })
})
