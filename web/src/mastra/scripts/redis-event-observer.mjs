/**
 * A standalone second process that subscribes to Mastra's workflow topics on
 * Redis Streams and reports what it receives on stdout.
 *
 * This is the "second process" of ledger item 2.4. It deliberately shares no
 * memory with the process running the workflow: it does not import the Mastra
 * instance, the database client, or any workflow definition. The only thing
 * connecting the two is the Redis stream, so anything it prints crossed a real
 * process boundary.
 *
 * Usage:
 *   node src/mastra/scripts/redis-event-observer.mjs <redis-url> [topic ...]
 *
 * Protocol on stdout, one JSON object per line:
 *   {"kind":"ready"}                                  once every topic is subscribed
 *   {"kind":"event","topic":..,"type":..,"runId":..}  per received event
 *
 * Plain `.mjs` rather than TypeScript so it runs under bare `node` with no
 * loader, the same way the Railway `worker` service will start.
 */
import { RedisStreamsPubSub } from "@mastra/redis-streams"

const [url, ...topicArgs] = process.argv.slice(2)
if (!url) {
  console.error("usage: redis-event-observer.mjs <redis-url> [topic ...]")
  process.exit(2)
}

/** The two topics Mastra's evented engine uses for cross-process delivery. */
const topics = topicArgs.length > 0 ? topicArgs : ["workflows", "workflows-finish"]

function emit(line) {
  process.stdout.write(`${JSON.stringify(line)}\n`)
}

const pubsub = new RedisStreamsPubSub({ url })

/**
 * No `group` option, so each subscription gets its own fan-out consumer group.
 * An observer must not compete with the orchestration worker for events: a
 * shared group would let this process consume an event the executing process
 * needed, and the run under observation would stall.
 */
for (const topic of topics) {
  await pubsub.subscribe(topic, (event) => {
    emit({
      kind: "event",
      topic,
      type: event.type,
      runId: event.runId ?? event.data?.runId ?? null,
      workflowId: event.data?.workflowId ?? null,
    })
  })
}

emit({ kind: "ready" })

const shutdown = async () => {
  await pubsub.close()
  process.exit(0)
}
process.on("SIGTERM", shutdown)
process.on("SIGINT", shutdown)
