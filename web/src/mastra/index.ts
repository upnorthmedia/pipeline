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
import { imagesAgent } from "./agents/images"
import { outlineAgent } from "./agents/outline"
import { readyAgent } from "./agents/ready"
import { researchAgent } from "./agents/research"
import { writeAgent } from "./agents/write"
import { createWorkerEvents } from "./failure-recorder"
import { imagesWorkflow } from "./workflows/images"
import { nextjsPublishWorkflow } from "./workflows/nextjs-publish"
import { pipelineWorkflow } from "./workflows/pipeline"
import { recrawlCheckWorkflow } from "./workflows/recrawl-check"
import { scaffoldCheckWorkflow } from "./workflows/scaffold-check"
import { sitemapCrawlWorkflow } from "./workflows/sitemap-crawl"
import { wordpressPublishWorkflow } from "./workflows/wordpress-publish"

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

/**
 * How long a step message may sit unacked before the transport hands it to
 * another consumer.
 *
 * `RedisStreamsPubSub` runs `XAUTOCLAIM` on a timer and claims any pending
 * entry idle longer than this, with no liveness check on the consumer holding
 * it. A `workflow.step.run` message stays pending for the whole of the step
 * body, so at the 60s default every stage that takes longer than a minute is
 * re-delivered to a *live* worker and executed a second time alongside the
 * first. The first end-to-end run (ledger 4.7) measured `research` at 63s,
 * `outline` at 66s and `edit` at 75s, and the audit trigger caught `edit`
 * writing four different values; the run still ended `success`, so nothing
 * short of a write log would have shown it.
 *
 * 15 minutes is well past the slowest stage seen (`edit` at 75s, `images` at
 * 57s over four generations) with room for a slow provider, and the library's
 * own guidance is that this "should be much larger than typical in-flight
 * processing time to avoid double-delivery".
 *
 * The cost is recovery latency: this is also the window before a genuinely
 * dead worker's in-flight step is picked up by a replacement (ledger 4.5
 * measured 70-98s at the default). A crashed stage now waits up to 15 minutes
 * instead. Duplicate billing on every stage of every run is the worse of the
 * two, and a stage that does outlive the window is re-delivered rather than
 * lost: the duplicate takes the skip branch if the original has committed.
 */
export const RECLAIM_IDLE_MS = 15 * 60_000

export const pubsub = new RedisStreamsPubSub({
  url: redisUrl(),
  reclaimIdleMs: RECLAIM_IDLE_MS,
  logger: { debug: sink("debug"), warn: sink("warn") },
})

/**
 * Topic listeners, subscribed by `startWorkers()` and so live in the `worker`
 * service and not in `web`. `workflows-finish` carries every run's terminal
 * event; `recordRunFailure` is the port of the post-writing half of Python's
 * `_move_to_dlq()` plus its `stage_error` announcement (see
 * `failure-recorder.ts`).
 *
 * Built from the transport above rather than importing it back inside the
 * listener, which would close an import cycle. A test builds the same map on
 * its own transport, so the subscribed shape and the checkable one stay the
 * same function: `Mastra` keeps its `events` config private.
 */
export const workerEvents = createWorkerEvents(pubsub)

export const mastra = new Mastra({
  storage,
  pubsub,
  logger,
  /**
   * `sharp` is a native module: its `.node` binary cannot be inlined into the
   * worker bundle, so `mastra worker build` produced an artifact that threw
   * "Could not load the sharp module" on boot. Listing it as an external keeps
   * it out of the bundle and puts it into the generated `package.json`, where
   * the deploy target installs it for its own platform.
   */
  bundler: { externals: ["sharp"] },
  // `pipeline` is the six stages composed in order and is what a run starts.
  // `images` stays registered in its own right because it is a workflow rather
  // than a step (its fan-out is `.foreach()`, which only exists at workflow
  // level) and because a single stage can be rerun on its own.
  // `sitemapCrawl` is not part of a pipeline run: it is the ARQ
  // `crawl_profile_sitemap` job, started per profile by the crawl route and by
  // the nightly re-crawl check.
  // `recrawlCheck` is that nightly check, and is ARQ's `cron_jobs` entry: it
  // carries its own cron, so registering it here is what schedules it. The
  // scheduler only runs where `startWorkers()` was called, so it fires in the
  // `worker` service and never in `web`.
  // `wordpressPublish` and `nextjsPublish` are the two ARQ publish jobs. They
  // are separate workflows because Python registered two separate functions
  // and `POST /{post_id}/publish` branched on `output_format` to choose one;
  // they share no state and only one ever runs for a given post.
  workflows: {
    pipeline: pipelineWorkflow,
    images: imagesWorkflow,
    scaffoldCheck: scaffoldCheckWorkflow,
    sitemapCrawl: sitemapCrawlWorkflow,
    recrawlCheck: recrawlCheckWorkflow,
    wordpressPublish: wordpressPublishWorkflow,
    nextjsPublish: nextjsPublishWorkflow,
  },
  events: workerEvents,
  agents: {
    research: researchAgent,
    outline: outlineAgent,
    write: writeAgent,
    edit: editAgent,
    images: imagesAgent,
    ready: readyAgent,
  },
})
