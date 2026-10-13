// @vitest-environment node
/**
 * Item P0.3b: where the ordering gap in `pipeline-events.test.ts` actually is.
 *
 * That file's `carries Python's log payload and nothing else` reads the first
 * `log` event the `outline` stage sent and about one run in four got a later
 * one instead. Two places could reorder events between the step that publishes
 * them and the array the assertion reads: the Redis Streams fan-out, which
 * would also reorder the dashboard's live feed and matter to the trace view, or
 * the recording subscriber itself.
 *
 * This file separates them on the real transport. One subscription records the
 * event twice: once synchronously, in the turn the transport invoked it in, and
 * once after an `await` whose latency descends with the event, which is what
 * full-suite database contention does to `readPost` by accident. If the
 * transport reorders, the synchronous record is wrong. If the subscriber does,
 * only the awaited record is.
 *
 * Requires `docker compose up -d redis`.
 */
import type { Event } from "@mastra/core/events"
import { RedisStreamsPubSub } from "@mastra/redis-streams"
import { afterAll, beforeAll, describe, expect, it } from "vitest"

import { inDeliveryOrder } from "./in-delivery-order"

const TOPIC = "in-delivery-order"
/**
 * Enough events that a single inversion is unambiguous, and few enough that the
 * descending latency below stays inside a normal test's patience.
 */
const COUNT = 8
/**
 * The awaited gap for event `i`, descending: the first event waits longest, so
 * a subscriber that records after the await records the events backwards. Real
 * contention is not this tidy, but the failure it produces is the same one and
 * this version produces it every run rather than one in four.
 */
const gapFor = (index: number) => (COUNT - index) * 10

const pubsub = new RedisStreamsPubSub({
  url: process.env.REDIS_URL!,
  keyPrefix: "mastra:test:in-delivery-order",
})

/** The sequence numbers as the transport handed them over, recorded in-turn. */
const onInvocation: number[] = []
/** The same, recorded after the descending await, with no ordering discipline. */
const unordered: number[] = []
/** The same, recorded after the descending await, through `inDeliveryOrder`. */
const ordered: number[] = []

const sequenceOf = (event: Event) => event.data?.n as number

async function settle(target: number[]) {
  const deadline = Date.now() + 30_000
  while (target.length < COUNT) {
    if (Date.now() > deadline) throw new Error(`only ${target.length} of ${COUNT} arrived`)
    await new Promise((resolve) => setTimeout(resolve, 20))
  }
}

beforeAll(async () => {
  // A retained stream read from its first entry replays every previous run of
  // this file, which `pipeline-events.test.ts` records as the trap that let a
  // negative control pass on the run before it.
  await pubsub.clearTopic(TOPIC)

  await pubsub.subscribe(TOPIC, async (event) => {
    const n = sequenceOf(event)
    onInvocation.push(n)
    await new Promise((resolve) => setTimeout(resolve, gapFor(n)))
    unordered.push(n)
  })
  await pubsub.subscribe(
    TOPIC,
    inDeliveryOrder(async (event: Event) => {
      const n = sequenceOf(event)
      await new Promise((resolve) => setTimeout(resolve, gapFor(n)))
      ordered.push(n)
    }),
  )

  for (let n = 0; n < COUNT; n += 1) {
    await pubsub.publish(TOPIC, { type: "tick", runId: TOPIC, data: { n } })
  }

  await settle(onInvocation)
  await settle(unordered)
  await settle(ordered)
}, 60_000)

afterAll(async () => {
  await pubsub.close()
})

const published = Array.from({ length: COUNT }, (_, n) => n)

describe("the Redis Streams fan-out", () => {
  it("invokes a subscriber in publication order", () => {
    expect(onInvocation).toEqual(published)
  })
})

describe("a subscriber that awaits before it records", () => {
  it("records out of publication order, which is the defect P0.3b names", () => {
    expect(unordered).not.toEqual(published)
  })

  it("still receives every event, so the gap is order and not loss", () => {
    expect([...unordered].sort((a, b) => a - b)).toEqual(published)
  })
})

describe("the same subscriber wrapped in inDeliveryOrder", () => {
  it("records in publication order", () => {
    expect(ordered).toEqual(published)
  })
})

describe("inDeliveryOrder itself", () => {
  it("runs handlers one at a time, so no two overlap", async () => {
    let inFlight = 0
    let overlapped = false
    const record = inDeliveryOrder(async () => {
      inFlight += 1
      if (inFlight > 1) overlapped = true
      await new Promise((resolve) => setTimeout(resolve, 5))
      inFlight -= 1
    })
    await Promise.all([record(), record(), record()])
    expect(overlapped).toBe(false)
  })

  it("does not let a handler that throws stall the ones behind it", async () => {
    const seen: number[] = []
    const record = inDeliveryOrder(async (n: number) => {
      if (n === 1) throw new Error("handler failed")
      seen.push(n)
    })
    const settled = await Promise.allSettled([record(0), record(1), record(2)])
    expect(settled.map((result) => result.status)).toEqual(["fulfilled", "rejected", "fulfilled"])
    expect(seen).toEqual([0, 2])
  })
})
