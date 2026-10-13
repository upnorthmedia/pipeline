// @vitest-environment node
/**
 * Item 7.6: the transport's streams expire.
 *
 * Mastra gives every run its own `workflow.events.v2.<runId>` stream and drops
 * it through `clearTopic` at the end of the run's lifecycle. A run that never
 * reaches that call leaves the stream behind, and `streamIdleTtlMs` defaults to
 * 0, meaning no expiry: the dev Redis accumulated 4.2 GB of those orphans and
 * was OOM-killed replaying its own RDB, so `docker compose up` could not bring
 * the stack up at all.
 *
 * The app's own `pubsub` is the thing under test here, not the library: the
 * control suite builds a second transport without the option and shows the
 * stream it writes has no expiry, which is the state that filled Redis.
 *
 * Requires `docker compose up -d db redis`.
 */
import { RedisStreamsPubSub } from "@mastra/redis-streams"
import { createClient } from "redis"
import { afterAll, beforeAll, describe, expect, it } from "vitest"

import { closeDb } from "../db"
import { STREAM_IDLE_TTL_MS, pubsub } from "./index"

type RedisClient = ReturnType<typeof createClient>

/** Independent of anything under test, so a TTL read is not the writer's own claim. */
let client: RedisClient

/** Unique per run, so a leftover key from an earlier run cannot answer for this one. */
const suffix = `${process.pid}-${Date.now()}`
const appTopic = `retention-app-${suffix}`
const controlTopic = `retention-control-${suffix}`
const slidingTopic = `retention-sliding-${suffix}`

const SLIDING_TTL_MS = 5_000

/** The same `<keyPrefix>:<topic>` mapping `worker-health.ts` documents. */
const streamKey = (topic: string) => `mastra:topic:${topic}`

const control = new RedisStreamsPubSub({ url: process.env.REDIS_URL! })
const sliding = new RedisStreamsPubSub({
  url: process.env.REDIS_URL!,
  streamIdleTtlMs: SLIDING_TTL_MS,
})

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))

const event = { type: "retention.probe", runId: `retention-${suffix}`, data: { suffix } }

beforeAll(async () => {
  client = createClient({ url: process.env.REDIS_URL! })
  await client.connect()
}, 30_000)

afterAll(async () => {
  await control.close()
  await sliding.close()
  await pubsub.close()
  if (client.isOpen) {
    await client.del([streamKey(appTopic), streamKey(controlTopic), streamKey(slidingTopic)])
    await client.close()
  }
  await closeDb()
})

describe("the app's transport", () => {
  it("gives a stream it writes an expiry, so an abandoned run's events cannot outlive it", async () => {
    await pubsub.publish(appTopic, event)

    const ttl = await client.pTTL(streamKey(appTopic))
    // -1 is "key exists, no expiry"; -2 is "no key". Both mean the publish did
    // not set one.
    expect(ttl).toBeGreaterThan(0)
    expect(ttl).toBeLessThanOrEqual(STREAM_IDLE_TTL_MS)
    expect(ttl).toBeGreaterThan(STREAM_IDLE_TTL_MS - 60_000)
  })

  it("expires no sooner than a day, so a run's trace survives the tab that is watching it", () => {
    expect(STREAM_IDLE_TTL_MS).toBeGreaterThanOrEqual(24 * 60 * 60_000)
  })
})

describe("a transport left on the library default", () => {
  it("writes a stream with no expiry at all, which is what filled the dev Redis", async () => {
    await control.publish(controlTopic, event)

    expect(await client.pTTL(streamKey(controlTopic))).toBe(-1)
  })
})

describe("the expiry", () => {
  it("slides forward on every write, so a stream in use is never collected mid-flight", async () => {
    await sliding.publish(slidingTopic, event)
    await sleep(2_000)
    const beforeSecondWrite = await client.pTTL(streamKey(slidingTopic))

    await sliding.publish(slidingTopic, event)
    const afterSecondWrite = await client.pTTL(streamKey(slidingTopic))

    expect(beforeSecondWrite).toBeLessThan(SLIDING_TTL_MS - 1_000)
    expect(afterSecondWrite).toBeGreaterThan(beforeSecondWrite)
    expect(afterSecondWrite).toBeGreaterThan(SLIDING_TTL_MS - 1_000)
  }, 15_000)
})
