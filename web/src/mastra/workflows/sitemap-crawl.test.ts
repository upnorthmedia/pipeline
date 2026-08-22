// @vitest-environment node
/**
 * The crawl job end to end (ledger item 5.2c-ii-1): a run started on the
 * evented engine, executed by an in-process worker off Redis Streams, fetching
 * a real sitemap over a real socket and writing real `internal_links` rows.
 *
 * Nothing is mocked. The server is a Node `http.Server` on a loopback port, the
 * database is the dev database the rest of the suite uses, and the transport is
 * the same `RedisStreamsPubSub` the worker service runs, on its own key prefix
 * so a run cannot be stolen by another test file's worker.
 *
 * The four outcomes of `crawl_profile_sitemap` are covered here: a crawl that
 * finds links, a crawl that finds none, a crawl that raises, and a profile that
 * does not exist. The slug and duplicate rules are in
 * `../steps/sitemap-crawl.test.ts`, against the Python-generated oracle.
 *
 * The registration assertion lives in `../steps/sitemap-crawl.test.ts`:
 * importing `../index` here would rebind the workflow to the Mastra instance
 * that file constructs, whose worker is not running, and every run below would
 * publish to a topic nobody consumes.
 *
 * Requires `docker compose up -d db redis`.
 */
import { createServer, type Server } from "node:http"
import type { AddressInfo } from "node:net"

import { Mastra } from "@mastra/core"
import { PostgresStore } from "@mastra/pg"
import { RedisStreamsPubSub } from "@mastra/redis-streams"
import { and, eq } from "drizzle-orm"
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest"

import { closeDb, getDb, getPool, internalLinks, websiteProfiles } from "../../db"
import type { SitemapCrawlOutput } from "../steps/sitemap-crawl"
import { sitemapCrawlWorkflow } from "./sitemap-crawl"

const db = getDb()

/** One profile per outcome, so no test depends on another test's run. */
const CRAWLABLE = "00000000-0000-4000-8000-0000000005c0"
const BARE = "00000000-0000-4000-8000-0000000005c1"
const BROKEN = "00000000-0000-4000-8000-0000000005c2"
const ABSENT = "00000000-0000-4000-8000-0000000005c3"

const POST_ONE = "https://example.com/blog/post-one"
const POST_TWO = "https://example.com/blog/post-two/"
const ROOT = "https://example.com/"

/**
 * `post-one` appears twice, so the run exercises the duplicate fold, and the
 * root URL is there because its derived slug is null.
 */
const SITEMAP = [
  '<?xml version="1.0" encoding="UTF-8"?>',
  '<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">',
  `  <url><loc>${POST_ONE}</loc><lastmod>2026-01-01</lastmod></url>`,
  `  <url><loc>${POST_TWO}</loc></url>`,
  `  <url><loc>${ROOT}</loc></url>`,
  `  <url><loc>${POST_ONE}</loc></url>`,
  "</urlset>",
].join("\n")

/**
 * Two servers rather than one with a flag: the `bare` profile's host answers
 * 404 to everything for its whole life, so no assertion depends on when a
 * request arrives. A shared mutable flag made this file order-dependent, and a
 * step redelivered by the transport's reclaim loop after the flag flipped back
 * wrote links the `bare` case asserts are absent.
 */
let server: Server
let base = ""
let emptyServer: Server
let emptyBase = ""

const pubsub = new RedisStreamsPubSub({
  url: process.env.REDIS_URL!,
  keyPrefix: "mastra:test:sitemap-crawl",
})
const storage = new PostgresStore({ id: "sitemap-crawl-test", pool: getPool() })
const testMastra = new Mastra({
  storage,
  pubsub,
  workflows: { sitemapCrawl: sitemapCrawlWorkflow },
})

/** Log lines the step emits, captured rather than printed. */
let logs: { level: string; message: string }[]

async function runCrawl(profileId: string): Promise<SitemapCrawlOutput> {
  const run = await sitemapCrawlWorkflow.createRun()
  const result = await run.start({ inputData: { profileId } })
  if (result.status !== "success") {
    throw new Error(`crawl run ended ${result.status}: ${JSON.stringify(result)}`)
  }
  return result.result as SitemapCrawlOutput
}

async function readProfile(profileId: string) {
  const [row] = await db.select().from(websiteProfiles).where(eq(websiteProfiles.id, profileId))
  return row
}

async function readLinks(profileId: string) {
  return db
    .select()
    .from(internalLinks)
    .where(eq(internalLinks.profileId, profileId))
    .orderBy(internalLinks.url)
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

  emptyServer = createServer((_req, res) => {
    res.writeHead(404, { "Content-Length": "0" })
    res.end()
  })
  await new Promise<void>((resolve) => emptyServer.listen(0, "127.0.0.1", resolve))
  emptyBase = `http://127.0.0.1:${(emptyServer.address() as AddressInfo).port}`

  for (const id of [CRAWLABLE, BARE, BROKEN, ABSENT]) {
    await db.delete(websiteProfiles).where(eq(websiteProfiles.id, id))
  }
  await db.insert(websiteProfiles).values([
    { id: CRAWLABLE, name: "crawlable", websiteUrl: base },
    { id: BARE, name: "bare", websiteUrl: emptyBase },
    // `urlparse` never raises, so Python reached `://robots.txt` and recorded a
    // successful crawl of nothing; `new URL()` throws, so this profile takes
    // the port's failure branch. Recorded in the ledger as a deviation.
    { id: BROKEN, name: "broken", websiteUrl: "not a url" },
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
  await testMastra.stopWorkers()
  await pubsub.close()
  for (const id of [CRAWLABLE, BARE, BROKEN, ABSENT]) {
    await db.delete(websiteProfiles).where(eq(websiteProfiles.id, id))
  }
  await closeDb()
  for (const listener of [server, emptyServer]) {
    await new Promise<void>((resolve, reject) =>
      listener.close((error) => (error ? reject(error) : resolve())),
    )
  }
  vi.restoreAllMocks()
})

describe("a crawl that finds links", () => {
  let output: SitemapCrawlOutput

  beforeAll(async () => {
    output = await runCrawl(CRAWLABLE)
  }, 60_000)

  it("reports every entry it fetched and one row per URL", () => {
    expect(output).toEqual({
      profileId: CRAWLABLE,
      status: "complete",
      entries: 4,
      upserted: 3,
      error: null,
    })
  })

  it("writes one internal_links row per URL, with the Python-derived slug", async () => {
    const links = await readLinks(CRAWLABLE)

    // Ordered by URL, so the root sorts first: it is a prefix of the other two.
    expect(links.map((link) => [link.url, link.slug])).toEqual([
      [ROOT, null],
      [POST_ONE, "post-one"],
      [POST_TWO, "post-two"],
    ])
  })

  it("stamps the rows the way the ARQ job stamped them", async () => {
    const links = await readLinks(CRAWLABLE)

    for (const link of links) {
      expect(link.source).toBe("sitemap")
      expect(link.title).toBeNull()
      expect(link.postId).toBeNull()
      expect(link.keywords).toEqual([])
    }
  })

  it("moves the profile to complete and stamps last_crawled_at", async () => {
    const profile = await readProfile(CRAWLABLE)

    expect(profile.crawlStatus).toBe("complete")
    expect(profile.lastCrawledAt).toBeInstanceOf(Date)
  })

  it("logs the two lines the Python job logged", () => {
    expect(logs).toContainEqual({
      level: "info",
      message: `Crawled 4 URLs for profile crawlable (${base})`,
    })
    expect(logs).toContainEqual({
      level: "info",
      message: "Sitemap crawl complete for profile crawlable",
    })
  })
})

/**
 * The re-crawl case, which is the whole reason the write is an upsert: the
 * links router and the pipeline both write to this table, and a nightly
 * re-crawl must not undo them.
 */
describe("a second crawl over the same profile", () => {
  let output: SitemapCrawlOutput

  beforeAll(async () => {
    await db
      .update(internalLinks)
      .set({ title: "Hand written title", slug: null, source: "manual", keywords: ["seo"] })
      .where(and(eq(internalLinks.profileId, CRAWLABLE), eq(internalLinks.url, POST_ONE)))

    output = await runCrawl(CRAWLABLE)
  }, 60_000)

  it("adds no duplicate rows", async () => {
    expect(output.upserted).toBe(3)
    expect((await readLinks(CRAWLABLE)).length).toBe(3)
  })

  it("keeps a title the sitemap does not carry, and everything else it does not own", async () => {
    const link = (await readLinks(CRAWLABLE)).find((row) => row.url === POST_ONE)!

    expect(link.title).toBe("Hand written title")
    expect(link.source).toBe("manual")
    expect(link.keywords).toEqual(["seo"])
  })

  it("refills a slug that was cleared", async () => {
    const link = (await readLinks(CRAWLABLE)).find((row) => row.url === POST_ONE)!

    expect(link.slug).toBe("post-one")
  })
})

describe("a crawl that finds no sitemap", () => {
  let output: SitemapCrawlOutput

  beforeAll(async () => {
    output = await runCrawl(BARE)
  }, 60_000)

  it("completes with nothing rather than failing", () => {
    expect(output).toEqual({
      profileId: BARE,
      status: "complete",
      entries: 0,
      upserted: 0,
      error: null,
    })
  })

  it("still marks the profile complete and crawled", async () => {
    const profile = await readProfile(BARE)

    expect(profile.crawlStatus).toBe("complete")
    expect(profile.lastCrawledAt).toBeInstanceOf(Date)
  })

  it("writes no links", async () => {
    expect(await readLinks(BARE)).toEqual([])
  })
})

describe("a crawl that raises", () => {
  let output: SitemapCrawlOutput

  beforeAll(async () => {
    output = await runCrawl(BROKEN)
  }, 60_000)

  /**
   * The run still succeeds: Python swallowed the exception so ARQ never retried
   * a crawl, and a thrown step here would be redelivered by the transport and
   * re-fetch a site that is already known to be unreachable.
   */
  it("ends the run successfully and reports the failure in its output", () => {
    expect(output.status).toBe("failed")
    expect(output.error).toBeTruthy()
    expect(output.entries).toBe(0)
  })

  it("marks the profile failed and leaves last_crawled_at alone", async () => {
    const profile = await readProfile(BROKEN)

    expect(profile.crawlStatus).toBe("failed")
    expect(profile.lastCrawledAt).toBeNull()
  })

  it("logs the failure instead of printing a stack trace", () => {
    expect(logs).toContainEqual(
      expect.objectContaining({
        level: "error",
        message: `Sitemap crawl failed for profile ${BROKEN}`,
      }),
    )
  })
})

describe("a crawl for a profile that is gone", () => {
  let output: SitemapCrawlOutput

  beforeAll(async () => {
    output = await runCrawl(ABSENT)
  }, 60_000)

  it("reports it and does nothing else", () => {
    expect(output).toEqual({
      profileId: ABSENT,
      status: "missing",
      entries: 0,
      upserted: 0,
      error: null,
    })
    expect(logs).toContainEqual({ level: "error", message: `Profile ${ABSENT} not found` })
  })
})
