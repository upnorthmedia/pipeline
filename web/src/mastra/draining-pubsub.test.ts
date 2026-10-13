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
import { readFileSync } from "node:fs"
import { randomUUID } from "node:crypto"
import { createRequire } from "node:module"

import type { Event } from "@mastra/core/events"
import { createClient } from "redis"
import { afterAll, afterEach, describe, expect, it } from "vitest"

import { DEFAULT_MAX_DELIVERY_ATTEMPTS, DRAIN_TIMEOUT_MS, DrainingPubSub, drainTimeoutMs } from "./draining-pubsub"

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
function transport(
  options: { drainTimeoutMs?: number; keyPrefix?: string; maxDeliveryAttempts?: number } = {},
): DrainingPubSub {
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

/**
 * A client of the suite's own, for the assertions that are about the stream
 * rather than about the counter: whether an abandoned delivery was handed back
 * (acked and republished) or left pending is only visible in Redis.
 */
const redis = createClient({ url: process.env.REDIS_URL! })
let connected = false

/** `RedisStreamsPubSub`'s own key derivation, which it keeps private. */
function streamKey(keyPrefix: string): string {
  return `${keyPrefix}:${TOPIC}`
}

type StreamState = {
  pending: { id: string; consumer: string }[]
  events: { id: string; deliveryAttempt?: number; type?: string }[]
}

async function client() {
  if (!connected) {
    await redis.connect()
    connected = true
  }
  return redis
}

async function readEvents(keyPrefix: string): Promise<StreamState["events"]> {
  const entries = await (await client()).xRange(streamKey(keyPrefix), "-", "+")
  return entries.map((entry) => {
    const event = JSON.parse(entry.message?.event ?? "{}")
    return { id: String(entry.id), deliveryAttempt: event.deliveryAttempt, type: event.type }
  })
}

async function groupsOn(keyPrefix: string) {
  return (await client()).xInfoGroups(streamKey(keyPrefix))
}

async function readStream(keyPrefix: string, group: string): Promise<StreamState> {
  const pending = (await (await client()).xPendingRange(streamKey(keyPrefix), group, "-", "+", 50)).map((entry) => ({
    id: String(entry.id),
    consumer: String(entry.consumer),
  }))
  return { pending, events: await readEvents(keyPrefix) }
}

afterEach(async () => {
  for (const pubsub of open.splice(0)) {
    await pubsub.clearTopic(TOPIC)
    await pubsub.close()
  }
})

afterAll(async () => {
  if (connected) await redis.close()
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

describe("the deliveries the deadline abandons", () => {
  /** A grouped subscriber that takes a delivery and never lets go of it. */
  function held() {
    return () => new Promise<void>(() => {})
  }

  it("hands them back to the group rather than leaving them pending for reclaim", async () => {
    // P2.91b. A nack acks the entry this consumer owns and republishes the
    // event, so the next consumer to read takes it. Left pending, it is owned
    // by a consumer that will never read again and waits out `reclaimIdleMs`,
    // which this app sets to fifteen minutes.
    const keyPrefix = `drain-probe:${randomUUID()}`
    const pubsub = transport({ drainTimeoutMs: 500, keyPrefix })
    const cb = held()

    await pubsub.subscribe(TOPIC, cb, { group: GROUP })
    await pubsub.publish(TOPIC, { type: "probe", runId: randomUUID(), data: {} })
    await waitFor(() => pubsub.inFlightCount() === 1, 10_000, "the event to be delivered")
    const before = await readStream(keyPrefix, GROUP)
    expect(before.pending).toHaveLength(1)

    await pubsub.unsubscribe(TOPIC, cb)

    const after = await readStream(keyPrefix, GROUP)
    expect(after.pending).toEqual([])
    expect(after.events).toHaveLength(before.events.length + 1)
    expect(after.events.at(-1)).toMatchObject({ type: "probe", deliveryAttempt: 2 })
    expect(pubsub.inFlightCount()).toBe(0)
  })

  it("leaves one already at the delivery cap pending, because a nack would drop it", async () => {
    // `RedisStreamsPubSub#nack` acks and drops an event whose attempt has
    // reached `maxDeliveryAttempts` instead of republishing it. Reclaim has no
    // such cap, so the fifteen minute park is the recoverable option and the
    // handback is not.
    const keyPrefix = `drain-probe:${randomUUID()}`
    const pubsub = transport({ drainTimeoutMs: 500, keyPrefix, maxDeliveryAttempts: 3 })
    const cb = held()

    await pubsub.subscribe(TOPIC, cb, { group: GROUP })
    await pubsub.publish(TOPIC, { type: "probe", runId: randomUUID(), data: {}, deliveryAttempt: 3 })
    await waitFor(() => pubsub.inFlightCount() === 1, 10_000, "the event to be delivered")
    const before = await readStream(keyPrefix, GROUP)

    await pubsub.unsubscribe(TOPIC, cb)

    const after = await readStream(keyPrefix, GROUP)
    expect(after.pending).toEqual(before.pending)
    expect(after.events).toEqual(before.events)
  })

  it("does not republish a fan-out delivery, whose group has no other reader", async () => {
    // A subscription with no named group gets a group of its own, and the base
    // class destroys that group on unsubscribe, so a republished event would
    // be read by nobody. All a handback could do here is leave an orphan entry
    // in the stream for the idle TTL to collect.
    const keyPrefix = `drain-probe:${randomUUID()}`
    const pubsub = transport({ drainTimeoutMs: 500, keyPrefix })
    const cb = held()

    await pubsub.subscribe(TOPIC, cb)
    await pubsub.publish(TOPIC, { type: "probe", runId: randomUUID(), data: {} })
    await waitFor(() => pubsub.inFlightCount() === 1, 10_000, "the event to be delivered")
    const fanout = String((await groupsOn(keyPrefix))[0].name)
    const before = await readStream(keyPrefix, fanout)
    expect(before.pending).toHaveLength(1)

    await pubsub.unsubscribe(TOPIC, cb)

    expect(await groupsOn(keyPrefix)).toEqual([])
    expect((await readEvents(keyPrefix))).toEqual(before.events)
  })

  it("does not hand anything back when the drain is switched off", async () => {
    // `0` is the pre-P2.91 configuration, and a handback is a write to the
    // transport rather than a wait: a caller that asked this instance to stay
    // out of the way gets that.
    const keyPrefix = `drain-probe:${randomUUID()}`
    const pubsub = transport({ drainTimeoutMs: 0, keyPrefix })
    const cb = held()

    await pubsub.subscribe(TOPIC, cb, { group: GROUP })
    await pubsub.publish(TOPIC, { type: "probe", runId: randomUUID(), data: {} })
    await waitFor(() => pubsub.inFlightCount() === 1, 10_000, "the event to be delivered")
    const before = await readStream(keyPrefix, GROUP)

    await pubsub.unsubscribe(TOPIC, cb)

    const after = await readStream(keyPrefix, GROUP)
    expect(after.pending).toEqual(before.pending)
    expect(after.events).toEqual(before.events)
  })
})

describe("the delivery cap this class keeps a copy of", () => {
  it("matches the installed library's own default", () => {
    // The base class keeps `maxDeliveryAttempts` private, so the handback has
    // to carry its own copy of the default to know when a nack would drop an
    // event instead of republishing it. A library that changes the number
    // fails here rather than silently turning a late run into a lost one.
    const require = createRequire(import.meta.url)
    const source = readFileSync(require.resolve("@mastra/redis-streams"), "utf8")
    const declared = source.match(/options\.maxDeliveryAttempts \?\? (\d+)/)
    expect(declared?.[1]).toBe(String(DEFAULT_MAX_DELIVERY_ATTEMPTS))
  })

  it("reads the option, including the library's treatment of 0 as no cap", () => {
    expect(transport().maxDeliveryAttempts).toBe(DEFAULT_MAX_DELIVERY_ATTEMPTS)
    expect(transport({ maxDeliveryAttempts: 2 }).maxDeliveryAttempts).toBe(2)
    expect(transport({ maxDeliveryAttempts: 0 }).maxDeliveryAttempts).toBe(Infinity)
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
