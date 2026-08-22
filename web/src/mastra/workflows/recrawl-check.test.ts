// @vitest-environment node
/**
 * The nightly re-crawl check end to end (ledger item 5.2c-ii-2): the cron
 * declared on the workflow, the profile scan, and the `sitemapCrawl` runs it
 * fans out, all on the evented engine against the real database, real Redis
 * Streams and a real HTTP server.
 *
 * Three things are proved here that the pure test in
 * `../steps/recrawl-check.test.ts` cannot:
 *
 * 1. `createWorkflow({ schedule })` really does persist a schedule row and
 *    really does publish `workflow.start` on the cron against the installed
 *    `@mastra/core`. A probe workflow with a per-second cron is what shows the
 *    fire, since waiting for `0 0 * * *` is not a test.
 * 2. The SQL filter matches SQLAlchemy's, including the NULL `crawl_status`
 *    row that `crawl_status <> 'crawling'` silently excludes in both stacks.
 * 3. A started run is a real crawl: the fanned-out `sitemapCrawl` runs reach
 *    the site and write `internal_links`.
 *
 * The scan is global, so assertions are scoped to the profile ids this file
 * creates. No other test file writes a non-null `recrawl_interval` today; one
 * that did would be counted in `considered` but not in the scoped assertions.
 *
 * Requires `docker compose up -d db redis`.
 */
import { createServer, type Server } from "node:http"
import type { AddressInfo } from "node:net"

import { Mastra } from "@mastra/core"
import { createStep, createWorkflow } from "@mastra/core/workflows/evented"
import { PostgresStore } from "@mastra/pg"
import { RedisStreamsPubSub } from "@mastra/redis-streams"
import { eq, inArray } from "drizzle-orm"
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest"
import { z } from "zod"

import { closeDb, getDb, getPool, internalLinks, websiteProfiles } from "../../db"
import type { RecrawlCheckOutput } from "../steps/recrawl-check"
import { RECRAWL_CHECK_CRON, recrawlCheckWorkflow } from "./recrawl-check"
import { sitemapCrawlWorkflow } from "./sitemap-crawl"

const db = getDb()

/** One profile per branch of the scan. */
const DUE_WEEKLY = "00000000-0000-4000-8000-0000000005d0"
const NEVER_CRAWLED = "00000000-0000-4000-8000-0000000005d1"
const NOT_DUE = "00000000-0000-4000-8000-0000000005d2"
const CRAWLING = "00000000-0000-4000-8000-0000000005d3"
const NULL_STATUS = "00000000-0000-4000-8000-0000000005d4"
const NO_INTERVAL = "00000000-0000-4000-8000-0000000005d5"

const ALL = [DUE_WEEKLY, NEVER_CRAWLED, NOT_DUE, CRAWLING, NULL_STATUS, NO_INTERVAL]

const POST_URL = "https://example.com/blog/recrawled"

const SITEMAP = [
  '<?xml version="1.0" encoding="UTF-8"?>',
  '<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">',
  `  <url><loc>${POST_URL}</loc></url>`,
  "</urlset>",
].join("\n")

let server: Server
let base = ""

const pubsub = new RedisStreamsPubSub({
  url: process.env.REDIS_URL!,
  keyPrefix: "mastra:test:recrawl-check",
})
/**
 * Its own Postgres schema, not the shared `public` one.
 *
 * `mastra_schedules` is a single table for the whole database, and a scheduler
 * refuses to fire a schedule whose target workflow it does not know, deleting
 * the row after a few consecutive misses. Any other test file that starts the
 * production instance's workers now runs a scheduler too (the instance has a
 * scheduled workflow), so on the shared table it either steals this file's
 * fires through the compare-and-swap or deletes the probe row outright.
 * Measured: the per-second probe never fired inside 30s when the whole
 * `src/mastra` suite ran, and fires in about a second on its own schema.
 */
const SCHEMA = "mastra_test_recrawl"
const storage = new PostgresStore({
  id: "recrawl-check-test",
  pool: getPool(),
  schemaName: SCHEMA,
})

/**
 * A workflow whose only job is to be scheduled. Six-part cron, which
 * `validateCron` documents as supported, so the seconds field makes the fire
 * observable inside a test. The schedule row is deleted as soon as the first
 * fire lands, so it does not keep firing for the rest of the file.
 */
const probeFires: number[] = []

const scheduleProbeStep = createStep({
  id: "recrawl-schedule-probe",
  inputSchema: z.object({}),
  outputSchema: z.object({ fired: z.boolean() }),
  execute: async () => {
    probeFires.push(Date.now())
    return { fired: true }
  },
})

const scheduleProbeWorkflow = createWorkflow({
  id: "recrawl-schedule-probe",
  inputSchema: z.object({}),
  outputSchema: z.object({ fired: z.boolean() }),
  schedule: { cron: "* * * * * *", inputData: {} },
})
  .then(scheduleProbeStep)
  .commit()

const testMastra = new Mastra({
  storage,
  pubsub,
  scheduler: { tickIntervalMs: 500 },
  workflows: {
    recrawlCheck: recrawlCheckWorkflow,
    sitemapCrawl: sitemapCrawlWorkflow,
    scheduleProbe: scheduleProbeWorkflow,
  },
})

/** Log lines the step emits, captured rather than printed. */
let logs: { level: string; message: string }[]

function daysAgo(days: number): Date {
  return new Date(Date.now() - days * 86_400_000)
}

async function readProfiles() {
  return db.select().from(websiteProfiles).where(inArray(websiteProfiles.id, ALL))
}

async function waitFor(label: string, predicate: () => Promise<boolean>, timeoutMs = 30_000) {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    if (await predicate()) return
    await new Promise((resolve) => setTimeout(resolve, 250))
  }
  throw new Error(`timed out after ${timeoutMs}ms waiting for ${label}`)
}

beforeAll(async () => {
  server = createServer((req, res) => {
    const path = new URL(req.url ?? "/", "http://localhost").pathname
    if (path === "/robots.txt") {
      res.writeHead(200, { "Content-Type": "text/plain" })
      res.end(`User-agent: *\nSitemap: ${base}/sitemap.xml\n`)
      return
    }
    if (path === "/sitemap.xml") {
      res.writeHead(200, { "Content-Type": "application/xml" })
      res.end(SITEMAP)
      return
    }
    res.writeHead(404, { "Content-Length": "0" })
    res.end()
  })
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve))
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`

  for (const id of ALL) {
    await db.delete(internalLinks).where(eq(internalLinks.profileId, id))
    await db.delete(websiteProfiles).where(eq(websiteProfiles.id, id))
  }
  await db.insert(websiteProfiles).values([
    {
      id: DUE_WEEKLY,
      name: "due weekly",
      websiteUrl: base,
      recrawlInterval: "weekly",
      crawlStatus: "complete",
      lastCrawledAt: daysAgo(8),
    },
    {
      id: NEVER_CRAWLED,
      name: "never crawled",
      websiteUrl: base,
      recrawlInterval: "monthly",
      crawlStatus: "pending",
      lastCrawledAt: null,
    },
    {
      id: NOT_DUE,
      name: "not due",
      websiteUrl: base,
      recrawlInterval: "weekly",
      crawlStatus: "complete",
      lastCrawledAt: daysAgo(1),
    },
    {
      id: CRAWLING,
      name: "already crawling",
      websiteUrl: base,
      recrawlInterval: "weekly",
      crawlStatus: "crawling",
      lastCrawledAt: daysAgo(100),
    },
    {
      id: NULL_STATUS,
      name: "null status",
      websiteUrl: base,
      recrawlInterval: "weekly",
      crawlStatus: null,
      lastCrawledAt: daysAgo(100),
    },
    {
      id: NO_INTERVAL,
      name: "no interval",
      websiteUrl: base,
      recrawlInterval: null,
      crawlStatus: "complete",
      lastCrawledAt: daysAgo(100),
    },
  ])

  logs = []
  for (const level of ["info", "error"] as const) {
    vi.spyOn(testMastra.getLogger(), level).mockImplementation(((message: string) => {
      logs.push({ level, message })
    }) as never)
  }

  await storage.init()
  await testMastra.startWorkers()
}, 60_000)

afterAll(async () => {
  for (const schedule of await testMastra.schedules.list()) {
    if (schedule.workflowId === "recrawl-schedule-probe" || schedule.workflowId === "recrawl-check") {
      await testMastra.schedules.delete(schedule.id)
    }
  }
  await testMastra.stopWorkers()
  await pubsub.close()
  await getPool().query(`drop schema if exists ${SCHEMA} cascade`)
  for (const id of ALL) {
    await db.delete(internalLinks).where(eq(internalLinks.profileId, id))
    await db.delete(websiteProfiles).where(eq(websiteProfiles.id, id))
  }
  await closeDb()
  await new Promise<void>((resolve, reject) =>
    server.close((error) => (error ? reject(error) : resolve())),
  )
  vi.restoreAllMocks()
})

describe("the declared cron", () => {
  it("persists a schedule row for the re-crawl check", async () => {
    const schedules = await testMastra.schedules.list({ workflowId: "recrawl-check" })

    expect(schedules).toHaveLength(1)
    expect(schedules[0]).toMatchObject({
      cron: RECRAWL_CHECK_CRON,
      status: "active",
      workflowId: "recrawl-check",
    })
    // Midnight tonight or tomorrow, never in the past: the scheduler computes
    // it at registration and advances it by compare-and-swap on each fire.
    expect(schedules[0].nextFireAt).toBeGreaterThan(Date.now())
  })

  it("keeps ARQ's cron(hour=0, minute=0) as midnight daily", () => {
    expect(RECRAWL_CHECK_CRON).toBe("0 0 * * *")
  })

  it("actually fires a scheduled workflow against the installed version", async () => {
    await waitFor("the per-second probe schedule to fire", async () => probeFires.length > 0)

    const [schedule] = await testMastra.schedules.list({ workflowId: "recrawl-schedule-probe" })
    await testMastra.schedules.delete(schedule.id)

    expect(probeFires.length).toBeGreaterThan(0)
  }, 40_000)
})

describe("the profile scan", () => {
  let output: RecrawlCheckOutput

  beforeAll(async () => {
    const run = await recrawlCheckWorkflow.createRun()
    const result = await run.start({ inputData: {} })
    if (result.status !== "success") {
      throw new Error(`recrawl check ended ${result.status}: ${JSON.stringify(result)}`)
    }
    output = result.result as RecrawlCheckOutput
  }, 60_000)

  it("starts a crawl for the due profile and the never-crawled one only", () => {
    const started = output.started
      .map((entry) => entry.profileId)
      .filter((id) => ALL.includes(id))
      .sort()

    expect(started).toEqual([DUE_WEEKLY, NEVER_CRAWLED].sort())
  })

  it("gives every started run a run id", () => {
    for (const entry of output.started) {
      expect(entry.runId).toMatch(/\S/)
    }
  })

  it("considers only profiles with an interval and a status that is not crawling", () => {
    // NOT_DUE is considered but not due; CRAWLING, NULL_STATUS and NO_INTERVAL
    // are excluded by the query itself.
    expect(output.considered).toBeGreaterThanOrEqual(2)
    expect(output.started.length).toBeLessThanOrEqual(output.considered)
  })

  it("logs the line ARQ logged", () => {
    expect(logs).toContainEqual({
      level: "info",
      message: `Re-crawl check: ${output.started.length} profiles enqueued out of ${output.considered}`,
    })
  })

  it("leaves the excluded profiles untouched", async () => {
    const byId = new Map((await readProfiles()).map((row) => [row.id, row]))

    expect(byId.get(CRAWLING)!.crawlStatus).toBe("crawling")
    expect(byId.get(NULL_STATUS)!.crawlStatus).toBeNull()
    expect(byId.get(NO_INTERVAL)!.crawlStatus).toBe("complete")
    for (const id of [CRAWLING, NULL_STATUS, NO_INTERVAL, NOT_DUE]) {
      const links = await db.select().from(internalLinks).where(eq(internalLinks.profileId, id))
      expect(links).toEqual([])
    }
  })

  it("runs the crawls it started through to completion", async () => {
    await waitFor("both fanned-out crawls to finish", async () => {
      const byId = new Map((await readProfiles()).map((row) => [row.id, row]))
      return (
        byId.get(DUE_WEEKLY)!.crawlStatus === "complete" &&
        byId.get(NEVER_CRAWLED)!.crawlStatus === "complete"
      )
    })

    for (const id of [DUE_WEEKLY, NEVER_CRAWLED]) {
      const links = await db.select().from(internalLinks).where(eq(internalLinks.profileId, id))
      expect(links.map((link) => link.url)).toEqual([POST_URL])
    }
  }, 60_000)

  it("advances last_crawled_at past the due threshold", async () => {
    const byId = new Map((await readProfiles()).map((row) => [row.id, row]))

    expect(byId.get(DUE_WEEKLY)!.lastCrawledAt!.getTime()).toBeGreaterThan(daysAgo(1).getTime())
    expect(byId.get(NEVER_CRAWLED)!.lastCrawledAt).not.toBeNull()
  })
})
