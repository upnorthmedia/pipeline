// @vitest-environment node
/**
 * The drain itself, against the real transport rather than through a worker.
 *
 * `sigterm-shutdown.test.ts` measures what P2.91 is about: a worker sent
 * `SIGTERM` mid-stage finishes the stage instead of parking its message for
 * fifteen minutes. That suite spawns processes and costs seconds, so it asserts
 * on the shutdown and not on the seam. This one holds the seam: which
 * deliveries count as in flight, what settles them, and that the wait is
 * bounded whatever the subscriber does.
 *
 * Every case runs on a Redis key prefix of its own rather than on a database of
 * its own: nothing here starts a worker, so there is no shared consumer group
 * to collide with, and a prefix keeps the file off the numbered databases in
 * `src/test/redis-databases.ts`.
 *
 * Requires `docker compose up -d redis`.
 */
import { randomUUID } from "node:crypto"

import type { Event } from "@mastra/core/events"
import { afterEach, describe, expect, it } from "vitest"

import { DRAIN_TIMEOUT_MS, DrainingPubSub, drainTimeoutMs } from "./draining-pubsub"

const GROUP = "drain-probe"
const TOPIC = "workflows"

/**
 * What an unsubscribe costs with nothing to drain. `RedisStreamsPubSub`
 * awaits the subscription's read loop, which is parked in
 * `XREADGROUP ... BLOCK 1000` (`blockMs`, the library default), so about a
 * second is the floor for any unsubscribe and is not the drain. Measured at
 * 1010-1090ms; the bound here is generous enough not to be a timing race and
 * still an order of magnitude under every deadline this file sets.
 */
const UNSUBSCRIBE_FLOOR_MS = 2_500

const open: DrainingPubSub[] = []

/** A transport of its own, on its own key prefix, closed after the test. */
function transport(options: { drainTimeoutMs?: number } = {}): DrainingPubSub {
  const pubsub = new DrainingPubSub({
    url: process.env.REDIS_URL!,
    keyPrefix: `drain-probe:${randomUUID()}`,
    // Nothing here should ever be reclaimed out from under the subscriber the
    // test is measuring.
    reclaimIntervalMs: 0,
    ...options,
  })
  open.push(pubsub)
  return pubsub
}

afterEach(async () => {
  for (const pubsub of open.splice(0)) {
    await pubsub.clearTopic(TOPIC)
    await pubsub.close()
  }
})

/** Resolves once `predicate` holds, so a test never sleeps a fixed guess. */
async function waitFor(predicate: () => boolean, timeoutMs: number, what: string) {
  const deadline = Date.now() + timeoutMs
  while (!predicate()) {
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${what}`)
    await new Promise((resolve) => setTimeout(resolve, 10))
  }
}

describe("drainTimeoutMs", () => {
  it("defaults, and takes a number from the environment", () => {
    expect(drainTimeoutMs({})).toBe(DRAIN_TIMEOUT_MS)
    expect(drainTimeoutMs({ WORKER_DRAIN_TIMEOUT_MS: "5000" })).toBe(5_000)
    expect(drainTimeoutMs({ WORKER_DRAIN_TIMEOUT_MS: "0" })).toBe(0)
  })

  it("falls back rather than throwing on a value it cannot use", () => {
    // Read on the shutdown path, where a throw costs more than a sane number.
    expect(drainTimeoutMs({ WORKER_DRAIN_TIMEOUT_MS: "" })).toBe(DRAIN_TIMEOUT_MS)
    expect(drainTimeoutMs({ WORKER_DRAIN_TIMEOUT_MS: "soon" })).toBe(DRAIN_TIMEOUT_MS)
    expect(drainTimeoutMs({ WORKER_DRAIN_TIMEOUT_MS: "-1" })).toBe(DRAIN_TIMEOUT_MS)
  })
})

describe("an unsubscribe with a delivery still in flight", () => {
  it("waits for the subscriber to ack, and the subscriber's work completes", async () => {
    const pubsub = transport({ drainTimeoutMs: 30_000 })
    let acked = false
    let released: () => void
    const holding = new Promise<void>((resolve) => {
      released = resolve
    })
    const cb = async (_event: Event, ack?: () => Promise<void>) => {
      await holding
      await ack?.()
      acked = true
    }

    await pubsub.subscribe(TOPIC, cb, { group: GROUP })
    await pubsub.publish(TOPIC, { type: "probe", runId: randomUUID(), data: {} })
    await waitFor(() => pubsub.inFlightCount() === 1, 10_000, "the event to be delivered")

    let unsubscribed = false
    const stopping = pubsub.unsubscribe(TOPIC, cb).then(() => {
      unsubscribed = true
    })
    // The subscriber is still holding the delivery, so the unsubscribe is not
    // allowed to have resolved. Before P2.91 this was the whole defect.
    await new Promise((resolve) => setTimeout(resolve, 200))
    expect(unsubscribed).toBe(false)
    expect(acked).toBe(false)

    released!()
    await stopping
    expect(acked).toBe(true)
    expect(pubsub.inFlightCount()).toBe(0)
  })

  it("gives up on the deadline rather than holding the process open", async () => {
    // Comfortably past `UNSUBSCRIBE_FLOOR_MS` below, so the measured wait can
    // only be the drain and not the read loop's own last block.
    const pubsub = transport({ drainTimeoutMs: 2_500 })
    // Never settles: the shape of a stage still calling a provider when the
    // platform's kill timer is about to fire.
    const cb = () => new Promise<void>(() => {})

    await pubsub.subscribe(TOPIC, cb, { group: GROUP })
    await pubsub.publish(TOPIC, { type: "probe", runId: randomUUID(), data: {} })
    await waitFor(() => pubsub.inFlightCount() === 1, 10_000, "the event to be delivered")

    const startedAt = Date.now()
    await pubsub.unsubscribe(TOPIC, cb)
    const waited = Date.now() - startedAt
    expect(waited).toBeGreaterThanOrEqual(2_500)
    expect(waited).toBeLessThan(10_000)
  })

  it("does not wait at all when the drain is switched off", async () => {
    const pubsub = transport({ drainTimeoutMs: 0 })
    const cb = () => new Promise<void>(() => {})

    await pubsub.subscribe(TOPIC, cb, { group: GROUP })
    await pubsub.publish(TOPIC, { type: "probe", runId: randomUUID(), data: {} })
    await waitFor(() => pubsub.inFlightCount() === 1, 10_000, "the event to be delivered")

    const startedAt = Date.now()
    await pubsub.unsubscribe(TOPIC, cb)
    expect(Date.now() - startedAt).toBeLessThan(UNSUBSCRIBE_FLOOR_MS)
  })
})

describe("what counts as settled", () => {
  it("a nack, which is a delivery the subscriber handed back", async () => {
    const pubsub = transport({ drainTimeoutMs: 30_000 })
    let nacked = false
    const cb = async (_event: Event, _ack?: () => Promise<void>, nack?: () => Promise<void>) => {
      await nack?.()
      nacked = true
    }

    await pubsub.subscribe(TOPIC, cb, { group: GROUP })
    await pubsub.publish(TOPIC, { type: "probe", runId: randomUUID(), data: {} })
    await waitFor(() => nacked, 10_000, "the subscriber to nack")
    await waitFor(() => pubsub.inFlightCount() === 0, 10_000, "the nacked delivery to settle")

    // The unsubscribe has nothing to wait for, which is what settled means.
    const startedAt = Date.now()
    await pubsub.unsubscribe(TOPIC, cb)
    expect(Date.now() - startedAt).toBeLessThan(UNSUBSCRIBE_FLOOR_MS)
  })

  it("a rejected subscriber, which the transport nacks with its own copy of the settler", async () => {
    // `#deliverMessage` keeps its own `ack`/`nack` closures and uses them on
    // the failure paths, so nothing this class handed the subscriber is called.
    // The token has to be released here or a failing stage would make every
    // later shutdown pay the full deadline.
    const pubsub = transport({ drainTimeoutMs: 30_000 })
    let calls = 0
    const cb = async () => {
      calls += 1
      throw new Error("subscriber rejected")
    }

    await pubsub.subscribe(TOPIC, cb, { group: GROUP })
    await pubsub.publish(TOPIC, { type: "probe", runId: randomUUID(), data: {} })
    await waitFor(() => calls > 0, 10_000, "the subscriber to be called")
    await waitFor(() => pubsub.inFlightCount() === 0, 10_000, "the rejected delivery to settle")
  })

  it("a subscriber that throws before it returns a promise at all", async () => {
    const pubsub = transport({ drainTimeoutMs: 30_000 })
    let calls = 0
    const cb = () => {
      calls += 1
      throw new Error("subscriber threw")
    }

    await pubsub.subscribe(TOPIC, cb, { group: GROUP })
    await pubsub.publish(TOPIC, { type: "probe", runId: randomUUID(), data: {} })
    await waitFor(() => calls > 0, 10_000, "the subscriber to be called")
    await waitFor(() => pubsub.inFlightCount() === 0, 10_000, "the thrown delivery to settle")
  })
})

describe("bookkeeping", () => {
  it("forgets a subscription on unsubscribe, so a later count is not its ghost", async () => {
    const pubsub = transport({ drainTimeoutMs: 30_000 })
    const cb = async (_event: Event, ack?: () => Promise<void>) => {
      await ack?.()
    }

    await pubsub.subscribe(TOPIC, cb, { group: GROUP })
    await pubsub.publish(TOPIC, { type: "probe", runId: randomUUID(), data: {} })
    await waitFor(() => pubsub.inFlightCount() === 0, 10_000, "the delivery to settle")
    await pubsub.unsubscribe(TOPIC, cb)

    // A second unsubscribe of a callback this class no longer knows falls
    // through to the base class, which returns for an unknown subscription.
    await expect(pubsub.unsubscribe(TOPIC, cb)).resolves.toBeUndefined()
    expect(pubsub.inFlightCount()).toBe(0)
  })

  it("counts each subscription separately, and drains only the one being stopped", async () => {
    const pubsub = transport({ drainTimeoutMs: 30_000 })
    let releaseHeld: () => void
    const held = new Promise<void>((resolve) => {
      releaseHeld = resolve
    })
    const slow = async (_event: Event, ack?: () => Promise<void>) => {
      await held
      await ack?.()
    }
    const fast = async (_event: Event, ack?: () => Promise<void>) => {
      await ack?.()
    }

    // Two fan-out subscriptions (no group), so both see the same event.
    await pubsub.subscribe(TOPIC, slow)
    await pubsub.subscribe(TOPIC, fast)
    await pubsub.publish(TOPIC, { type: "probe", runId: randomUUID(), data: {} })
    await waitFor(() => pubsub.inFlightCount() === 1, 10_000, "the slow subscriber to be holding one")

    // The fast subscription has nothing outstanding, so stopping it does not
    // wait on the slow one's delivery.
    const startedAt = Date.now()
    await pubsub.unsubscribe(TOPIC, fast)
    expect(Date.now() - startedAt).toBeLessThan(UNSUBSCRIBE_FLOOR_MS)
    expect(pubsub.inFlightCount()).toBe(1)

    releaseHeld!()
    await pubsub.unsubscribe(TOPIC, slow)
    expect(pubsub.inFlightCount()).toBe(0)
  })
})
