/**
 * Worker liveness and backlog, read off the Redis Streams transport.
 *
 * This is the Mastra replacement for the two ARQ Redis reads in
 * `api/src/api/queue.py`'s `worker_status()`: a scan for `arq:worker:*`
 * heartbeat keys, and `ZCARD arq:queue` for the depth of the job queue.
 * Neither key exists once ARQ is gone, so both signals are re-derived from the
 * bookkeeping the transport already keeps.
 *
 * There is no heartbeat writer here on purpose. A worker process that is
 * consuming the orchestration topic is, by construction, registered as a
 * consumer in that topic's Redis consumer group, and Redis tracks how long ago
 * it last interacted. That is a liveness signal the worker cannot forget to
 * emit and cannot emit while wedged, which a separate `SET key EX n` loop
 * cannot claim.
 *
 * Deliberately free of `next/*` imports, like the rest of `src/mastra`.
 */
import { createClient } from "redis"

/**
 * The topic Mastra's orchestration worker consumes, and the consumer group it
 * joins. Both are internal constants in `@mastra/core` rather than exported
 * symbols (`TOPIC_WORKFLOWS` in `dist/pull-transport-*.js`, `DEFAULT_GROUP` in
 * `dist/worker-*.js`), so they are restated here and pinned by a test that
 * starts a real worker and asserts the group exists under these names.
 */
export const ORCHESTRATION_TOPIC = "workflows"
export const ORCHESTRATION_GROUP = "mastra-orchestration"

/** `RedisStreamsPubSub`'s default `keyPrefix`; the app does not override it. */
export const STREAM_KEY_PREFIX = "mastra:topic"

export function orchestrationStreamKey(keyPrefix: string = STREAM_KEY_PREFIX): string {
  return `${keyPrefix}:${ORCHESTRATION_TOPIC}`
}

/**
 * How long a consumer may go without touching the stream before it is treated
 * as a dead process.
 *
 * `RedisStreamsPubSub` polls with `XREADGROUP ... BLOCK 1000`, so a live
 * consumer's `idle` sawtooths between 0 and roughly one second. Measured over
 * 55 samples spanning a 100-second step, the maximum observed `idle` was
 * 1018 ms: the read loop keeps polling while a step executes, so a *busy*
 * worker looks exactly as alive as a quiet one. 15 s allows fifteen missed
 * polls before a worker is called dead, which is ~14x the observed worst case
 * and still detects a killed worker inside a dashboard refresh.
 *
 * The threshold is doing real work rather than guarding a rare case: nothing
 * in the transport ever runs `XGROUP DELCONSUMER`, so every worker process
 * that has ever run leaves its consumer entry behind forever. Counting entries
 * would report every historical worker as alive.
 */
export const WORKER_ALIVE_IDLE_LIMIT_MS = 15_000

export type WorkerHealth = {
  /** At least one worker process is currently consuming the orchestration topic. */
  workerAlive: boolean
  /** Live consumers, i.e. the number of worker processes behind `workerAlive`. */
  liveWorkers: number
  /**
   * Orchestration events published but not yet delivered to any worker: the
   * transport's own `lag`. `null` when Redis cannot determine it, which it
   * reports after entries are deleted from the middle of a stream. Reported
   * rather than defaulted to 0, because "no backlog" and "backlog unknown" are
   * different answers and only one of them is reassuring.
   *
   * Not the same unit as ARQ's `ZCARD arq:queue`: that counted whole jobs
   * waiting, this counts orchestration events (a run start, each step's run
   * and end), so one pipeline run contributes many entries over its life.
   */
  queuedEvents: number | null
}

type RedisClient = ReturnType<typeof createClient>

const globalForRedis = globalThis as unknown as { __workerHealthRedis?: RedisClient }

function redisUrl(): string {
  const url = process.env.REDIS_URL
  if (!url) {
    throw new Error("REDIS_URL must be set to read worker health")
  }
  return url
}

/**
 * The transport's clients are private to `RedisStreamsPubSub` and it exposes
 * no `XINFO`, so health reads need their own connection. One per process,
 * cached like `getPool()` so Next.js dev reloads do not leak connections.
 */
export function getHealthRedis(): RedisClient {
  if (!globalForRedis.__workerHealthRedis) {
    globalForRedis.__workerHealthRedis = createClient({ url: redisUrl() })
  }
  return globalForRedis.__workerHealthRedis
}

/** For scripts and tests; the servers keep the connection open. */
export async function closeHealthRedis(): Promise<void> {
  const client = globalForRedis.__workerHealthRedis
  globalForRedis.__workerHealthRedis = undefined
  if (client?.isOpen) await client.close()
}

/**
 * A stream that has never been published to, or a group no worker has ever
 * joined, is not an error condition: it is a system no worker process has
 * reached yet. Redis reports the two cases as `ERR no such key` and
 * `NOGROUP ...` respectively.
 */
function isMissingStreamOrGroup(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error)
  return message.startsWith("NOGROUP") || message.includes("no such key")
}

export type ReadWorkerHealthOptions = {
  client?: RedisClient
  streamKey?: string
  group?: string
  idleLimitMs?: number
}

export async function readWorkerHealth(
  options: ReadWorkerHealthOptions = {},
): Promise<WorkerHealth> {
  const client = options.client ?? getHealthRedis()
  const streamKey = options.streamKey ?? orchestrationStreamKey()
  const group = options.group ?? ORCHESTRATION_GROUP
  const idleLimitMs = options.idleLimitMs ?? WORKER_ALIVE_IDLE_LIMIT_MS

  if (!client.isOpen) await client.connect()

  try {
    const consumers = await client.xInfoConsumers(streamKey, group)
    const liveWorkers = consumers.filter((c) => Number(c.idle) < idleLimitMs).length

    const groups = await client.xInfoGroups(streamKey)
    const own = groups.find((g) => String(g.name) === group)
    /**
     * The installed typings declare `lag` as a plain number, but Redis returns
     * a nil for it when the count is not determinable. Runtime wins over the
     * `.d.ts` here, so the nil is handled rather than trusted away.
     */
    const rawLag: unknown = own?.lag
    const queuedEvents = rawLag === null || rawLag === undefined ? null : Number(rawLag)

    return { workerAlive: liveWorkers > 0, liveWorkers, queuedEvents }
  } catch (error) {
    if (!isMissingStreamOrGroup(error)) throw error
    /**
     * No group means no worker has ever subscribed, so nothing on the stream
     * has been delivered and `XLEN` is the exact backlog rather than an
     * estimate of it. `XLEN` on a stream that does not exist is 0, which
     * covers the never-published case in the same expression.
     */
    return { workerAlive: false, liveWorkers: 0, queuedEvents: await client.xLen(streamKey) }
  }
}

/**
 * Where the worker records the finish time of its last run.
 *
 * Python kept the same fact at `arq:worker:last_completed`
 * (`WORKER_LAST_COMPLETED_KEY` in `api/src/worker.py`), written by
 * `_record_job_completed()` at the end of `_run_pipeline`'s `try`. The name
 * changes because nothing named `arq:` survives the port; the semantics do
 * not.
 *
 * Deliberately still a written timestamp rather than a value derived from the
 * run rows Mastra already stores. `listWorkflowRuns({ status: "success" })`
 * orders by `createdAt`, so the most recently *started* successful run is not
 * the most recently *finished* one when two runs overlap, and answering it
 * correctly means either an unbounded scan of every successful run ever or an
 * arbitrary window over the last N. One `SET` per completed run is cheaper
 * than both and says exactly what Python said.
 */
export const WORKER_LAST_COMPLETED_KEY = "mastra:worker:last_completed"

/**
 * A connection for one write, closed again straight away.
 *
 * The worker is long-lived and could cache a client the way `getHealthRedis()`
 * does, but this runs once per completed run rather than per step, so the
 * round trip to open it is noise next to the run that just finished. Keeping
 * it out of process-lifetime state also keeps `pipelineCompleteStep` free of a
 * handle that every test executing the workflow would otherwise inherit and
 * have to close.
 */
async function withOwnClient<T>(fn: (client: RedisClient) => Promise<T>): Promise<T> {
  const client = createClient({ url: redisUrl() })
  await client.connect()
  try {
    return await fn(client)
  } finally {
    await client.close()
  }
}

export type LastCompletedOptions = {
  client?: RedisClient
  key?: string
}

async function onClient<T>(
  options: LastCompletedOptions,
  fn: (client: RedisClient) => Promise<T>,
): Promise<T> {
  const client = options.client
  if (!client) return withOwnClient(fn)
  if (!client.isOpen) await client.connect()
  return fn(client)
}

/**
 * Stamp "a run just finished" and return the timestamp written.
 *
 * The value is `Date#toISOString()`, so it reads as `...T12:00:00.000Z` where
 * Python's `datetime.now(UTC).isoformat()` read as `...T12:00:00.000000+00:00`:
 * same instant, same ISO 8601, different spelling and three fewer digits of
 * precision. Nothing consumes the string except the health endpoint, which
 * passes it through, so the spelling is a recorded deviation rather than a
 * contract change.
 *
 * Errors are not swallowed. Python's call sits inside `_run_pipeline`'s `try`,
 * so a Redis failure there failed the run too.
 */
export async function recordRunCompleted(options: LastCompletedOptions = {}): Promise<string> {
  const at = new Date().toISOString()
  await onClient(options, (client) => client.set(options.key ?? WORKER_LAST_COMPLETED_KEY, at))
  return at
}

/** The last recorded finish time, or `null` if no run has finished yet. */
export async function readLastCompleted(options: LastCompletedOptions = {}): Promise<string | null> {
  return onClient(options, (client) => client.get(options.key ?? WORKER_LAST_COMPLETED_KEY))
}
