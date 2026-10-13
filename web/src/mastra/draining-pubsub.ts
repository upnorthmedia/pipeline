/**
 * `RedisStreamsPubSub` that finishes its work before it lets go of it.
 *
 * Ledger item P2.91. The generated worker entry (`WorkerBundler.getEntry()` in
 * `mastra/dist/index.js`, reproduced verbatim in `.mastra/worker/index.mjs`)
 * handles `SIGTERM` by awaiting `mastra.stopWorkers()` and then calling
 * `process.exit(0)`. P2.21 measured what that does to a step that is executing
 * at the time, and the answer was: nothing waits for it.
 *
 *   - `RedisStreamsPubSub.#deliverMessage` calls `sub.cb(event, ack, nack)` and
 *     does not await it, and `PullTransport`'s callback likewise fires
 *     `router.route(...)` unawaited. No part of the transport holds a handle on
 *     a running step body.
 *   - `Mastra.stopWorkers()` stops each worker; `PullTransport.stop()` only
 *     unsubscribes; `RedisStreamsPubSub.unsubscribe()` sets `stopped`, quits the
 *     read client and awaits the *read loop*, which is not the step.
 *
 * So `stopWorkers()` drained the reader and not the work, `process.exit(0)`
 * truncated the stage mid-provider-call, and the stage's message stayed pending
 * until `XAUTOCLAIM` at `RECLAIM_IDLE_MS`, which this app sets to fifteen
 * minutes. A routine worker redeploy parked the post for that long and then
 * re-ran and re-billed the stage.
 *
 * The handle the transport does not keep is recoverable at the one place the
 * delivery is visible: the `ack` and `nack` a subscription is handed per
 * message. A delivery is in flight from the moment the callback is invoked
 * until one of them is called, which is exactly the window in which the entry
 * is pending in Redis. Counting that window per subscription gives
 * `unsubscribe()` something to wait on, and `stopWorkers()` calls
 * `unsubscribe()`, so the generated entry drains without knowing that it does.
 *
 * Bounded, because an unbounded drain is a worse defect than the one it fixes:
 * a stage that outlives `WORKER_DRAIN_TIMEOUT_MS` is abandoned and the process
 * exits. Abandoning it is not the same as dropping it, which is ledger item
 * P2.91b: the delivery is nacked on the way out, so the transport acks the
 * original entry and republishes the event for whichever consumer reads next,
 * rather than leaving it pending under a consumer that will never read again
 * and waiting out `reclaimIdleMs` (fifteen minutes in this app). The three
 * cases where that handback is not the right answer are on `#handBack` below.
 *
 * The platform's own kill timer is the other bound and it is not ours to read:
 * a container runtime that follows `SIGTERM` with `SIGKILL` before the drain
 * finishes leaves the entry pending, which is the pre-P2.91 behaviour and not a
 * regression.
 */
import type { Event, EventCallback, SubscribeOptions } from "@mastra/core/events"
import { RedisStreamsPubSub, type RedisStreamsPubSubConfig } from "@mastra/redis-streams"

/**
 * How long an unsubscribe waits for the deliveries its subscription still
 * holds.
 *
 * Two minutes is past the slowest stage measured on a real run (`edit` at 75s,
 * ledger item 4.7) with room for a slow provider, and well short of
 * `RECLAIM_IDLE_MS`, the fifteen minutes after which another worker takes the
 * message anyway. A drain that ran longer than the reclaim window would be
 * racing the very redelivery it exists to avoid.
 */
export const DRAIN_TIMEOUT_MS = 120_000

/**
 * `WORKER_DRAIN_TIMEOUT_MS` in milliseconds, or {@link DRAIN_TIMEOUT_MS}.
 *
 * `0` is honoured and means "do not wait", which is the pre-P2.91 behaviour and
 * what a suite that wants a shutdown to be immediate sets. Anything unparseable
 * or negative falls back rather than throwing: this is read on the shutdown
 * path, where a throw would cost more than a wrong-but-sane number.
 */
export function drainTimeoutMs(env: Record<string, string | undefined> = process.env): number {
  const raw = env.WORKER_DRAIN_TIMEOUT_MS
  if (raw === undefined || raw.trim() === "") return DRAIN_TIMEOUT_MS
  const parsed = Number(raw)
  if (!Number.isFinite(parsed) || parsed < 0) return DRAIN_TIMEOUT_MS
  return parsed
}

/**
 * `RedisStreamsPubSub`'s own default for `maxDeliveryAttempts`, which it keeps
 * private. A nack is what hands an abandoned delivery back, and a nack on an
 * event already at the cap drops it instead of republishing it, so the drain
 * has to know the number to avoid turning a late run into a lost one.
 *
 * `draining-pubsub.test.ts` reads the number out of the installed library and
 * fails if this copy drifts from it.
 */
export const DEFAULT_MAX_DELIVERY_ATTEMPTS = 5

export type DrainingPubSubConfig = RedisStreamsPubSubConfig & {
  /** Overrides `WORKER_DRAIN_TIMEOUT_MS` for this instance. */
  drainTimeoutMs?: number
}

/** One delivery this pubsub has handed out and not seen settled. */
type Delivery = {
  /** The event as the subscriber saw it, read for its `deliveryAttempt`. */
  event: Event
  /** The settler that hands the delivery back, absent on a local publish. */
  nack?: () => Promise<void>
}

/** What one subscription is holding, and the wrapper the base class knows it by. */
type Registration = {
  wrapped: EventCallback
  inFlight: Map<object, Delivery>
  /**
   * Whether this subscription joined a named consumer group. A fan-out
   * subscription has a group of its own that nothing else reads, so
   * republishing its abandoned delivery hands it to nobody.
   */
  grouped: boolean
}

export class DrainingPubSub extends RedisStreamsPubSub {
  readonly drainTimeoutMs: number
  /** This instance's copy of the base class's private delivery-attempt cap. */
  readonly maxDeliveryAttempts: number
  #registrations = new Map<EventCallback, Map<string, Registration>>()
  #waiters = new Set<() => void>()
  /**
   * The base class keeps its own copy of this sink private, so a drain that
   * gives up would have nowhere to say so. Held again here rather than read
   * back off the instance, so both end up on the same logger.
   */
  #logger: DrainingPubSubConfig["logger"]

  constructor(options: DrainingPubSubConfig = {}) {
    super(options)
    this.drainTimeoutMs = options.drainTimeoutMs ?? drainTimeoutMs()
    // The base class's own reading of the same option, including its
    // back-compat treatment of 0 as "no cap". It has already thrown on a value
    // neither of us can use, because `super()` ran first.
    const cap = options.maxDeliveryAttempts ?? DEFAULT_MAX_DELIVERY_ATTEMPTS
    this.maxDeliveryAttempts = cap === 0 ? Infinity : cap
    this.#logger = options.logger
  }

  /** Deliveries this pubsub has handed out and not seen acked or nacked. */
  inFlightCount(): number {
    let total = 0
    for (const byTopic of this.#registrations.values()) {
      for (const registration of byTopic.values()) total += registration.inFlight.size
    }
    return total
  }

  async subscribe(topic: string, cb: EventCallback, options?: SubscribeOptions): Promise<void> {
    const registration = this.#register(topic, cb, !!options?.group)
    try {
      await super.subscribe(topic, registration.wrapped, options)
    } catch (err) {
      // A subscription that never started holds nothing, and leaving its
      // registration behind would make every later `inFlightCount()` wrong.
      this.#forget(topic, cb)
      throw err
    }
  }

  async unsubscribe(topic: string, cb: EventCallback): Promise<void> {
    const registration = this.#registrations.get(cb)?.get(topic)
    if (!registration) return super.unsubscribe(topic, cb)
    this.#forget(topic, cb)
    // The base call is what stops the reader, so no new delivery can join the
    // set while the drain below is waiting on it.
    await super.unsubscribe(topic, registration.wrapped)
    await this.#drain(topic, registration)
  }

  #register(topic: string, cb: EventCallback, grouped: boolean): Registration {
    let byTopic = this.#registrations.get(cb)
    if (!byTopic) {
      byTopic = new Map()
      this.#registrations.set(cb, byTopic)
    }
    const existing = byTopic.get(topic)
    if (existing) return existing

    const inFlight = new Map<object, Delivery>()
    const wrapped: EventCallback = (event, ack, nack) => {
      // A delivery with neither settler is not pending anywhere (the transport
      // hands both to every real subscriber; a local publish hands two no-ops).
      // Tracking it would leave a token nothing can ever clear.
      if (!ack && !nack) return cb(event, ack, nack)

      const token = {}
      const settle = () => {
        if (inFlight.delete(token)) this.#notify()
      }
      const settling = (fn?: () => Promise<void>) => async () => {
        try {
          await fn?.()
        } finally {
          settle()
        }
      }
      // The handback the drain uses is the same wrapped settler the subscriber
      // was handed, so a delivery it nacks leaves the set the same way one the
      // subscriber nacks does.
      inFlight.set(token, { event, nack: nack && settling(nack) })

      let result: void | Promise<void>
      try {
        result = cb(event, ack && settling(ack), nack && settling(nack))
      } catch (err) {
        // `#deliverMessage` catches this and nacks with its own copy of the
        // settler, which this class never sees.
        settle()
        throw err
      }
      if (result && typeof result.catch === "function") {
        // Same again for the rejected-promise path. Observing the rejection
        // here does not consume it: `#deliverMessage` has its own handler on
        // the same promise and still nacks.
        result.catch(() => settle())
      }
      return result
    }

    const registration = { wrapped, inFlight, grouped }
    byTopic.set(topic, registration)
    return registration
  }

  #forget(topic: string, cb: EventCallback): void {
    const byTopic = this.#registrations.get(cb)
    if (!byTopic) return
    byTopic.delete(topic)
    if (byTopic.size === 0) this.#registrations.delete(cb)
  }

  #notify(): void {
    for (const waiter of [...this.#waiters]) waiter()
  }

  async #drain(topic: string, registration: Registration): Promise<void> {
    const { inFlight } = registration
    if (inFlight.size === 0) return
    if (this.drainTimeoutMs === 0) {
      // "Do not wait" is the pre-P2.91 configuration, and a handback is a
      // write to the transport rather than a wait: a caller that asked this
      // instance to stay out of the way gets exactly that.
      this.#warnAbandoned(topic, inFlight.size)
      return
    }
    const held = inFlight.size
    const startedAt = Date.now()
    await new Promise<void>((resolve) => {
      const finish = () => {
        this.#waiters.delete(check)
        clearTimeout(timer)
        resolve()
      }
      const check = () => {
        if (inFlight.size === 0) finish()
      }
      const timer = setTimeout(finish, this.drainTimeoutMs)
      this.#waiters.add(check)
    })
    if (inFlight.size === 0) {
      this.#logger?.debug?.("redis-streams: drained in-flight deliveries before unsubscribe", {
        topic,
        deliveries: held,
        waitedMs: Date.now() - startedAt,
      })
      return
    }
    await this.#handBack(topic, registration)
  }

  /**
   * Give the deliveries the deadline abandoned back to the group.
   *
   * Ledger item P2.91b. `nack()` acks the entry the dying consumer owns and
   * republishes the event, so the next consumer to read the stream takes it
   * instead of waiting out `reclaimIdleMs`. Three cases keep the old
   * leave-it-pending behaviour, because for them a nack is worse than a wait:
   *
   *   - A fan-out subscription (no named group). Its group is private to the
   *     subscription that is going away, so a republished event is read by
   *     nobody and the original entry would have been reclaimed by nobody
   *     either. Neither path recovers it; the quieter one wins.
   *   - A delivery with no `nack` to call, which is a local publish.
   *   - A delivery already at `maxDeliveryAttempts`. `nack()` drops an event at
   *     the cap rather than republishing it, and a redeploy turning a late run
   *     into a lost one is the one outcome worse than the fifteen minute park.
   *     Reclaim has no such cap, so leaving it pending still recovers it.
   */
  async #handBack(topic: string, registration: Registration): Promise<void> {
    const abandoned = [...registration.inFlight.values()]
    const handed: Promise<void>[] = []
    let left = 0
    for (const delivery of abandoned) {
      const attempt = delivery.event.deliveryAttempt ?? 1
      if (!registration.grouped || !delivery.nack || attempt >= this.maxDeliveryAttempts) {
        left += 1
        continue
      }
      handed.push(
        delivery.nack().catch((err) => {
          this.#logger?.warn?.("redis-streams: handing an abandoned delivery back failed", {
            topic,
            eventId: delivery.event.id,
            err: err instanceof Error ? err.message : err,
          })
        }),
      )
    }
    await Promise.all(handed)
    if (handed.length > 0) {
      this.#logger?.warn?.(
        "redis-streams: drain deadline reached; handing the deliveries still in flight back to the group",
        { topic, deliveries: handed.length, drainTimeoutMs: this.drainTimeoutMs },
      )
    }
    if (left > 0) this.#warnAbandoned(topic, left)
  }

  #warnAbandoned(topic: string, deliveries: number): void {
    this.#logger?.warn?.(
      "redis-streams: unsubscribing with deliveries still in flight; they stay pending for reclaim",
      { topic, deliveries, drainTimeoutMs: this.drainTimeoutMs },
    )
  }
}
