/**
 * Recording a pub/sub topic in delivery order from an asynchronous subscriber.
 *
 * `RedisStreamsPubSub` reads a stream with `xReadGroup` and hands each entry to
 * the subscriber in stream order, but it does not await the callback before
 * moving to the next entry: `#deliverMessage` calls `sub.cb(event, ack, nack)`
 * and only attaches a `.catch()` to whatever comes back. So invocation order is
 * the topic's order, and completion order is not. A subscriber that awaits
 * anything before recording the event, a database read, a permission check,
 * records in whatever order those awaits happen to resolve in, which under load
 * is not the order the events were published.
 *
 * That is a test-side hazard, not a transport defect. The dashboard's own
 * subscriber in `src/app/api/events/stream.ts` already chains its work onto a
 * `tail` promise for exactly this reason, and this is the same discipline for
 * the suites that record events to assert on them afterwards.
 *
 * The wrapped callback returns the chained promise, so a `await` on the array's
 * length also means every earlier handler has finished: an event is only in the
 * array once its own asynchronous work, and every prior event's, is done.
 */

/**
 * Wrap a subscriber so its body runs in delivery order rather than in the order
 * its internal awaits resolve.
 *
 * The chain is extended synchronously, inside the turn the transport called the
 * listener in, which is what makes the order the topic's rather than the event
 * loop's. A handler that rejects is swallowed so it cannot stall every event
 * behind it, and the returned promise rejects, which is what the transport's
 * own `nack` path reads.
 */
export function inDeliveryOrder<A extends unknown[]>(
  handler: (...args: A) => void | Promise<void>,
): (...args: A) => Promise<void> {
  let tail: Promise<void> = Promise.resolve()
  return (...args: A) => {
    const delivery = tail.then(() => handler(...args))
    tail = delivery.catch(() => {})
    return delivery
  }
}
