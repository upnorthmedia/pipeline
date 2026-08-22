/**
 * The single Mastra entry point.
 *
 * Both Railway services import this module: `web` (Next.js) to start runs and
 * read run state, and `worker` to execute steps. The Mastra CLI (Studio)
 * discovers it here too.
 *
 * Deliberately free of `next/*` imports. The worker and Studio load this
 * outside Next.js, so a single `next/...` specifier anywhere in its import
 * graph would stop them booting; `no-next-imports.test.ts` enforces that.
 *
 * Split of responsibilities, per the port's architecture:
 *   - state (runs, suspended runs, workflow snapshots) lives in Postgres,
 *     in the same `content_pipeline` database as posts, so one backup is
 *     internally consistent;
 *   - transport (workflow lifecycle events between `web` and `worker`) lives
 *     in Redis Streams.
 */
import { Mastra } from "@mastra/core"
import { PinoLogger } from "@mastra/loggers"
import { PostgresStore } from "@mastra/pg"
import { RedisStreamsPubSub } from "@mastra/redis-streams"

import { getPool } from "../db"
import { editAgent } from "./agents/edit"
import { outlineAgent } from "./agents/outline"
import { researchAgent } from "./agents/research"
import { writeAgent } from "./agents/write"
import { scaffoldCheckWorkflow } from "./workflows/scaffold-check"

function redisUrl(): string {
  const url = process.env.REDIS_URL
  if (!url) {
    throw new Error("REDIS_URL must be set to reach the Mastra event bus")
  }
  return url
}

export const logger = new PinoLogger({ name: "content-pipeline" })

/**
 * Run state goes in the existing `content_pipeline` database, on the pool the
 * rest of the TypeScript stack already uses. Sharing the pool keeps one
 * connection budget per process instead of two, and `PostgresStore.close()`
 * leaves a pool it did not create alone, so `closeDb()` stays the single
 * teardown for scripts and tests.
 *
 * The adapter creates its own `mastra_*` tables; `schema-parity.ts` already
 * excludes that prefix, so this does not disturb the Alembic parity check.
 */
export const storage = new PostgresStore({ id: "content-pipeline", pool: getPool() })

/**
 * `RedisStreamsPubSub` takes loose `(...args: unknown[]) => void` diagnostic
 * sinks, which `MastraLogger`'s typed `(message, args)` signature does not
 * satisfy. Adapt instead of widening, so its BUSYGROUP and connection-close
 * warnings still reach the app logger rather than being swallowed.
 */
function sink(level: "debug" | "warn") {
  return (...args: unknown[]) => {
    const [message, ...rest] = args
    logger[level](String(message), rest.length > 0 ? { details: rest } : undefined)
  }
}

export const pubsub = new RedisStreamsPubSub({
  url: redisUrl(),
  logger: { debug: sink("debug"), warn: sink("warn") },
})

export const mastra = new Mastra({
  storage,
  pubsub,
  logger,
  // Phase 3 registers the six pipeline stages alongside the scaffold check.
  workflows: { scaffoldCheck: scaffoldCheckWorkflow },
  agents: { research: researchAgent, outline: outlineAgent, write: writeAgent, edit: editAgent },
})
