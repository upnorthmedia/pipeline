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
import { Mastra } from "@mastra/core"
import { PinoLogger } from "@mastra/loggers"
import { PostgresStore } from "@mastra/pg"
import { RedisStreamsPubSub } from "@mastra/redis-streams"
import { Pool } from "pg"
import { afterAll, beforeAll, describe, expect, it } from "vitest"

import { closeDb, getPool, toNodePostgresUrl } from "../db"
import { logger, mastra, pubsub, storage } from "./index"
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
   * The crawl job's registration (item 5.2c-ii-1). It is asserted here rather
   * than beside the run in `workflows/sitemap-crawl.test.ts`, because importing
   * this module rebinds the workflow to this instance and a run started in that
   * file would then publish to a topic whose worker is not running.
   */
  it("registers the sitemap crawl as a one-step workflow", () => {
    expect(mastra.getWorkflow("sitemapCrawl")).toBe(sitemapCrawlWorkflow)
    expect(Object.keys(mastra.listWorkflows())).toContain("sitemapCrawl")
    expect(sitemapCrawlWorkflow.id).toBe("sitemap-crawl")

    const graph = sitemapCrawlWorkflow.serializedStepGraph as {
      type: string
      step?: { id?: string }
    }[]
    expect(graph.map((entry) => entry.type)).toEqual(["step"])
    expect(graph[0].step?.id).toBe("sitemap-crawl")
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
