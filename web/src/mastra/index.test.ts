// @vitest-environment node
/**
 * Phase 2 item 2.2: the Mastra instance is wired to the real infrastructure,
 * not to defaults.
 *
 * Mastra falls back to an in-memory store and an in-process EventEmitter when
 * `storage` / `pubsub` are omitted, and both fallbacks look perfectly healthy
 * in a single process. So these assertions go all the way to the boundary: the
 * store must create its tables in the same `content_pipeline` database that
 * holds `posts`, and the pubsub must round-trip an event through the Redis the
 * repo-root `.env` points at.
 *
 * Requires `docker compose up -d db redis`.
 */
import { existsSync } from "node:fs"

import { Mastra } from "@mastra/core"
import { PinoLogger } from "@mastra/loggers"
import { PostgresStore } from "@mastra/pg"
import { RedisStreamsPubSub } from "@mastra/redis-streams"
import { Pool } from "pg"
import { afterAll, beforeAll, describe, expect, it } from "vitest"

import { closeDb, getPool, toNodePostgresUrl } from "../db"
import { logger, mastra, pubsub, storage } from "./index"
import { MAX_ATTEMPTS } from "./state"
import { RECRAWL_CHECK_CRON, recrawlCheckWorkflow } from "./workflows/recrawl-check"
import { nextjsPublishWorkflow } from "./workflows/nextjs-publish"
import { wordpressPublishWorkflow } from "./workflows/wordpress-publish"
import { sitemapCrawlWorkflow } from "./workflows/sitemap-crawl"

/** An independent connection, so the assertions do not read through the pool under test. */
let probe: Pool

beforeAll(async () => {
  probe = new Pool({ connectionString: toNodePostgresUrl(process.env.DATABASE_URL_SYNC!) })
  await storage.init()
}, 60_000)

afterAll(async () => {
  await pubsub.close()
  await probe.end()
  await closeDb()
})

describe("mastra instance", () => {
  it("is a Mastra instance carrying the configured storage, pubsub and logger", () => {
    expect(mastra).toBeInstanceOf(Mastra)
    // `getStorage()` hands back an init-ensuring Proxy around the store rather
    // than the store itself, so identity is checked through the shared pool.
    expect(mastra.getStorage()).toBeInstanceOf(PostgresStore)
    expect((mastra.getStorage() as PostgresStore).pool).toBe(storage.pool)
    // Same story for `pubsub`: the getter returns a Proxy that rewrites
    // `publish` for Mastra's internal topics. The round-trip test below is what
    // proves the instance is talking to the Redis-backed bus configured here.
    expect(mastra.pubsub).toBeInstanceOf(RedisStreamsPubSub)
    // And `getLogger()` returns a `DualLogger` that dual-writes to
    // observability; the logger configured here is its `baseLogger`.
    const dual = mastra.getLogger() as unknown as { baseLogger: unknown }
    expect(dual.baseLogger).toBe(logger)
    expect(dual.baseLogger).toBeInstanceOf(PinoLogger)
  })

  it("shares the one pg pool the rest of the TypeScript stack uses", () => {
    expect(storage.pool).toBe(getPool())
  })

  /**
   * Item P2.110. `Mastra.workflows` is a record and the key is free of the
   * workflow's own `id`, but a resume is not: the engine's `resume`, `restart`
   * and `timeTravel` branches all go through
   * `resolveWorkflow(params.workflowId)`, which is `Mastra.getWorkflow()` on
   * the *registration key* while `params.workflowId` is the workflow's `id`.
   * Five of these seven were registered under a camelCase key, so each of them
   * would have thrown `MASTRA_GET_WORKFLOW_BY_ID_NOT_FOUND` the first time a
   * step in it suspended and anything resumed it.
   *
   * `registration-key.test.ts` demonstrates that on a real suspended run;
   * this is the invariant it justifies, and it is written over the registry
   * rather than over a list of names so a workflow added later is covered.
   */
  /**
   * The same invariant from the other side. Three of the call sites that broke
   * when the keys changed are inside a step's `execute`, where `mastra` is
   * loosely typed, so `tsc` saw nothing and only a run that reached the line
   * failed. A literal is cheap to check and this is the whole population of
   * them: the parameter type covers every other caller.
   */
  it("has no source literal asking for a workflow that is not registered", async () => {
    const { readFile } = await import("node:fs/promises")
    const { execFileSync } = await import("node:child_process")
    const keys = new Set(Object.keys(mastra.listWorkflows()))
    const files = execFileSync("git", ["ls-files", "src"], { encoding: "utf8" })
      .split("\n")
      .filter((file) => file.endsWith(".ts") || file.endsWith(".tsx"))

    const unregistered: string[] = []
    for (const file of files) {
      // The probe suites register their own workflows on their own instances.
      if (file.endsWith(".test.ts") || file.endsWith(".test.tsx")) continue
      if (!existsSync(file)) continue
      const source = await readFile(file, "utf8")
      for (const match of source.matchAll(/getWorkflow\("([^"]+)"\)/g)) {
        if (!keys.has(match[1])) unregistered.push(`${file}: ${match[1]}`)
      }
    }
    expect(unregistered).toEqual([])
    // Anti-vacuity: the scan reaches the files that hold these calls.
    expect(files).toContain("src/mastra/steps/pipeline-complete.ts")
  })

  it("registers every workflow under its own id, which is what a resume resolves", () => {
    const registered = Object.entries(mastra.listWorkflows())
      // Mastra registers its own notification dispatcher on every instance.
      .filter(([key]) => !key.startsWith("__mastra"))
    expect(registered.length).toBe(7)
    expect(registered.map(([key, workflow]) => [key, workflow.id])).toEqual(
      registered.map(([, workflow]) => [workflow.id, workflow.id]),
    )
  })

  /**
   * The crawl job's registration (item 5.2c-ii-1). It is asserted here rather
   * than beside the run in `workflows/sitemap-crawl.test.ts`, because importing
   * this module rebinds the workflow to this instance and a run started in that
   * file would then publish to a topic whose worker is not running.
   */
  it("registers the sitemap crawl as a one-step workflow", () => {
    expect(mastra.getWorkflow("sitemap-crawl")).toBe(sitemapCrawlWorkflow)
    expect(Object.keys(mastra.listWorkflows())).toContain("sitemap-crawl")
    expect(sitemapCrawlWorkflow.id).toBe("sitemap-crawl")

    const graph = sitemapCrawlWorkflow.serializedStepGraph as {
      type: string
      step?: { id?: string }
    }[]
    expect(graph.map((entry) => entry.type)).toEqual(["step"])
    expect(graph[0].step?.id).toBe("sitemap-crawl")
  })

  /**
   * The nightly re-crawl check's registration (item 5.2c-ii-2), here for the
   * same reason. Registering it is what schedules it: the declared cron is read
   * off the workflow by the instance's scheduler, so an unregistered
   * `recrawlCheckWorkflow` is a re-crawl that never happens.
   */
  it("registers the nightly re-crawl check with its cron declared", () => {
    expect(mastra.getWorkflow("recrawl-check")).toBe(recrawlCheckWorkflow)
    expect(Object.keys(mastra.listWorkflows())).toContain("recrawl-check")
    expect(recrawlCheckWorkflow.id).toBe("recrawl-check")
    // `createWorkflow` returns `EventedWorkflow`, which declares
    // `getScheduleConfigs()`, but `.then().commit()` narrows back to the base
    // `Workflow`, which does not. The method is there at runtime (it is what
    // the scheduler reads at registration); only the chained type loses it.
    const scheduled = recrawlCheckWorkflow as unknown as {
      getScheduleConfigs(): { cron: string; inputData?: unknown }[]
    }
    expect(scheduled.getScheduleConfigs()).toEqual([{ cron: RECRAWL_CHECK_CRON, inputData: {} }])

    const graph = recrawlCheckWorkflow.serializedStepGraph as {
      type: string
      step?: { id?: string }
    }[]
    expect(graph.map((entry) => entry.type)).toEqual(["step"])
    expect(graph[0].step?.id).toBe("recrawl-check")
  })

  /**
   * The WordPress publish hook's registration (item 5.3c-iii-b-1-c-iii), here
   * for the same reason as the two above: importing this module rebinds the
   * workflow to this instance, so the run in
   * `steps/wordpress-publish.test.ts` calls the step directly instead.
   */
  it("registers the WordPress publish hook as a one-step workflow", () => {
    expect(mastra.getWorkflow("wordpress-publish")).toBe(wordpressPublishWorkflow)
    expect(Object.keys(mastra.listWorkflows())).toContain("wordpress-publish")
    expect(wordpressPublishWorkflow.id).toBe("wordpress-publish")

    const graph = wordpressPublishWorkflow.serializedStepGraph as {
      type: string
      step?: { id?: string }
    }[]
    expect(graph.map((entry) => entry.type)).toEqual(["step"])
    expect(graph[0].step?.id).toBe("wordpress-publish")
  })

  /**
   * The Next.js publish hook's registration (item 5.3c-iii-b-2-d). It carries a
   * retry policy because Python left the payload build outside its `try` and
   * ARQ's `max_tries = 3` therefore applied to it; `attempts` is one fewer
   * because the engine counts retries after the first execution. Its WordPress
   * sibling carries the same policy since item P2.94b, and stops it at the site
   * from inside the step rather than by declaring nothing here.
   */
  it("registers the Next.js publish hook as a one-step workflow that retries", () => {
    expect(mastra.getWorkflow("nextjs-publish")).toBe(nextjsPublishWorkflow)
    expect(Object.keys(mastra.listWorkflows())).toContain("nextjs-publish")
    expect(nextjsPublishWorkflow.id).toBe("nextjs-publish")
    expect(nextjsPublishWorkflow.retryConfig).toEqual({ attempts: MAX_ATTEMPTS - 1 })
    expect(wordpressPublishWorkflow.retryConfig).toEqual({ attempts: MAX_ATTEMPTS - 1 })

    const graph = nextjsPublishWorkflow.serializedStepGraph as {
      type: string
      step?: { id?: string }
    }[]
    expect(graph.map((entry) => entry.type)).toEqual(["step"])
    expect(graph[0].step?.id).toBe("nextjs-publish")
  })
})

describe("postgres storage", () => {
  it("created its tables in the same database that holds posts", async () => {
    const { rows } = await probe.query<{ table_name: string }>(
      `select table_name from information_schema.tables
       where table_schema = 'public' and table_name like 'mastra_%'
       order by table_name`,
    )
    const names = rows.map((r) => r.table_name)
    expect(names.length).toBeGreaterThan(0)
    expect(names).toContain("mastra_workflow_snapshot")

    // Same database, same connection: `posts` is right there next to them.
    const posts = await probe.query(
      `select 1 from information_schema.tables
       where table_schema = 'public' and table_name = 'posts'`,
    )
    expect(posts.rowCount).toBe(1)

    const db = await probe.query<{ current_database: string }>("select current_database()")
    expect(db.rows[0].current_database).toBe("content_pipeline")
  })

  it("round-trips a workflow snapshot through the store", async () => {
    const workflows = await storage.getStore("workflows")
    expect(workflows).toBeDefined()

    const runId = `scaffold-${process.pid}-${probe.totalCount}`
    await workflows!.persistWorkflowSnapshot({
      workflowName: "scaffold-probe",
      runId,
      snapshot: { value: { step: "done" } } as never,
    })
    const loaded = await workflows!.loadWorkflowSnapshot({
      workflowName: "scaffold-probe",
      runId,
    })
    expect(loaded).toMatchObject({ value: { step: "done" } })

    await probe.query("delete from mastra_workflow_snapshot where run_id = $1", [runId])
  })
})

describe("redis streams pubsub", () => {
  it("delivers a published event to a subscriber over the real Redis", async () => {
    const topic = `scaffold-probe-${process.pid}`
    const received: { type: string; data: unknown }[] = []
    const delivered = new Promise<void>((resolve) => {
      void pubsub.subscribe(topic, async (event) => {
        received.push({ type: event.type, data: event.data })
        resolve()
      })
    })

    // Give the consumer group its first XREADGROUP before publishing, otherwise
    // the entry lands before the group exists and is never delivered.
    await new Promise((r) => setTimeout(r, 500))
    // Published through the Mastra instance, received on the instance we
    // configured: this is what proves `mastra` carries this Redis bus.
    await mastra.pubsub.publish(topic, {
      type: "scaffold.ping",
      runId: topic,
      data: { ok: true },
    })

    await Promise.race([
      delivered,
      new Promise((_, reject) =>
        setTimeout(() => reject(new Error("no event delivered within 10s")), 10_000),
      ),
    ])

    expect(received).toEqual([{ type: "scaffold.ping", data: { ok: true } }])
    await pubsub.clearTopic(topic)
  }, 20_000)
})
