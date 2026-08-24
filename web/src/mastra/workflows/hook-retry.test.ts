// @vitest-environment node
/**
 * Ledger items P2.94a and P2.95: the retry policy the hook workflows lost in
 * the port, and the gap between the attempts it allows.
 *
 * ARQ retried every registered job function three times
 * (`WorkerSettings.max_tries = MAX_ATTEMPTS`) and spaced the attempts by
 * `retry_delay = 10`. Both settings were worker-wide, so they covered the
 * crawl, the nightly check and the two publish hooks as much as the pipeline.
 * The port moved retries onto each workflow's `retryConfig` and the pause into
 * `recordStageRetry()`, which only the eight pipeline stage steps call, so
 * three of the four hooks got a single attempt and the fourth retried with no
 * gap at all.
 *
 * What is being measured is a throw that escapes the step, which for these
 * hooks is never the failure they are written to expect: each one catches its
 * own domain failure (an unreachable sitemap, a webhook that answers 500) and
 * returns it, deliberately, so a retry cannot re-run somebody else's site. What
 * escapes is the band outside that catch, which is the database and transport
 * work bracketing it, and a raise there leaves a row stuck in `crawling` or
 * `publishing` with nothing to move it.
 *
 * Each scenario runs the real step on the real evented engine, against the real
 * database, Redis and storage, under a probe workflow that reads its
 * `retryConfig` off the shipped workflow rather than restating it. The probe
 * exists so the run has no schedule and no sibling registration; the number
 * under test is the shipped one.
 *
 * How each throw is produced, in descending order of realism:
 *
 * * `recrawl-check` throws for real and unaided: it resolves `sitemapCrawl` off
 *   the instance, and this instance holds probes only.
 * * `nextjs-publish` throws for real from `buildNextjsPayload`, which Python
 *   left outside its `try` too: a truthy `nextjs_frontmatter_map` that is not a
 *   dict raises before any image is read.
 * * `sitemap-crawl` has no reachable throw that is not an infrastructure
 *   failure, so one is injected at exactly that boundary: `db.update` raises
 *   for the duration of that run. The read, the engine, the transport and the
 *   storage are real; the failing write is the stub.
 *
 * Requires `docker compose up -d db redis`.
 */
import { mkdtempSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"

import { Mastra } from "@mastra/core"
import { createWorkflow } from "@mastra/core/workflows/evented"
import { PostgresStore } from "@mastra/pg"
import { RedisStreamsPubSub } from "@mastra/redis-streams"
import { eq } from "drizzle-orm"
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest"

import { closeDb, getDb, getPool, posts, websiteProfiles } from "../../db"
import { encryptWithKey } from "../../lib/crypto"
import type { EngineStepErrors } from "../../test/engine-step-errors"
import { captureEngineStepErrors } from "../../test/engine-step-errors"
import { MAX_ATTEMPTS } from "../state"
import {
  nextjsPublishInputSchema,
  nextjsPublishOutputSchema,
  nextjsPublishStep,
} from "../steps/nextjs-publish"
import {
  recrawlCheckInputSchema,
  recrawlCheckOutputSchema,
  recrawlCheckStep,
} from "../steps/recrawl-check"
import {
  sitemapCrawlInputSchema,
  sitemapCrawlOutputSchema,
  sitemapCrawlStep,
} from "../steps/sitemap-crawl"
import { nextjsPublishWorkflow } from "./nextjs-publish"
import { recrawlCheckWorkflow } from "./recrawl-check"
import { sitemapCrawlWorkflow } from "./sitemap-crawl"

const CRAWL_PROFILE = "00000000-0000-4000-8000-000000000941"
const DUE_PROFILE = "00000000-0000-4000-8000-000000000942"
const PUBLISH_PROFILE = "00000000-0000-4000-8000-000000000943"
const PUBLISH_POST = "00000000-0000-4000-8000-000000000944"

const PROFILES = [CRAWL_PROFILE, DUE_PROFILE, PUBLISH_PROFILE]

/** What the injected infrastructure failure says, and so what the engine retries. */
const BOOM = "connection terminated unexpectedly"

const TEST_KEY = Buffer.alloc(32, 41).toString("base64url")
const SECRET = "hook-retry-secret"

const db = getDb()

/**
 * The shipped policy, read off each shipped workflow. Restating
 * `MAX_ATTEMPTS - 1` here would make the probe pass whatever the workflow
 * carries, which is the whole defect.
 */
const sitemapProbe = createWorkflow({
  id: "hook-retry-sitemap",
  inputSchema: sitemapCrawlInputSchema,
  outputSchema: sitemapCrawlOutputSchema,
  retryConfig: { attempts: sitemapCrawlWorkflow.retryConfig?.attempts ?? 0 },
})
  .then(sitemapCrawlStep)
  .commit()

const recrawlProbe = createWorkflow({
  id: "hook-retry-recrawl",
  inputSchema: recrawlCheckInputSchema,
  outputSchema: recrawlCheckOutputSchema,
  retryConfig: { attempts: recrawlCheckWorkflow.retryConfig?.attempts ?? 0 },
})
  .then(recrawlCheckStep)
  .commit()

const nextjsProbe = createWorkflow({
  id: "hook-retry-nextjs",
  inputSchema: nextjsPublishInputSchema,
  outputSchema: nextjsPublishOutputSchema,
  retryConfig: { attempts: nextjsPublishWorkflow.retryConfig?.attempts ?? 0 },
})
  .then(nextjsPublishStep)
  .commit()

const pubsub = new RedisStreamsPubSub({
  url: process.env.REDIS_URL!,
  keyPrefix: "mastra:test:hook-retry",
})
const storage = new PostgresStore({ id: "hook-retry-test", pool: getPool() })

const testMastra = new Mastra({
  storage,
  pubsub,
  workflows: {
    "hook-retry-sitemap": sitemapProbe,
    "hook-retry-recrawl": recrawlProbe,
    "hook-retry-nextjs": nextjsProbe,
  },
})

/**
 * Item P2.39's pause, turned up from the suite's `0` for this file only, for
 * the reason `images-retry.test.ts` gives: long enough to be unambiguous
 * against a millisecond stamp, short enough to cost nothing.
 */
const TEST_RETRY_DELAY_MS = 400

let engineErrors: EngineStepErrors
let previousRetryDelay: string | undefined
let previousKey: string | undefined
let previousMediaDir: string | undefined
const results: Record<string, string> = {}

beforeAll(async () => {
  previousRetryDelay = process.env.STAGE_RETRY_DELAY_MS
  previousKey = process.env.WP_ENCRYPTION_KEY
  previousMediaDir = process.env.MEDIA_DIR
  process.env.STAGE_RETRY_DELAY_MS = String(TEST_RETRY_DELAY_MS)
  process.env.WP_ENCRYPTION_KEY = TEST_KEY
  process.env.MEDIA_DIR = mkdtempSync(join(tmpdir(), "hook-retry-"))

  engineErrors = captureEngineStepErrors()

  await db.delete(posts).where(eq(posts.id, PUBLISH_POST))
  for (const id of PROFILES) await db.delete(websiteProfiles).where(eq(websiteProfiles.id, id))

  await db.insert(websiteProfiles).values([
    {
      id: CRAWL_PROFILE,
      name: "hook retry, crawl",
      // Port 9 is `discard`; the crawl never gets far enough to reach it.
      websiteUrl: "http://127.0.0.1:9/blog",
    },
    {
      id: DUE_PROFILE,
      name: "hook retry, due for a re-crawl",
      websiteUrl: "http://127.0.0.1:9/blog2",
      recrawlInterval: "daily",
      crawlStatus: "pending",
    },
    {
      id: PUBLISH_PROFILE,
      name: "hook retry, publish",
      websiteUrl: "http://127.0.0.1:9/blog3",
      nextjsWebhookUrl: "http://127.0.0.1:9/api/jena/webhook",
      nextjsWebhookSecret: encryptWithKey(SECRET, TEST_KEY),
      // Truthy and not a dict: `toMapping` raises `'list' object has no
      // attribute 'items'` before a single image is read, which is Python's
      // own behaviour and the reason its publish hook was retried at all.
      nextjsFrontmatterMap: ["title"] as unknown as Record<string, unknown>,
    },
  ])

  await db.insert(posts).values({
    id: PUBLISH_POST,
    slug: "hook-retry-publish",
    topic: "hook retry",
    profileId: PUBLISH_PROFILE,
    readyContent: "# Hook retry\n",
  })

  await storage.init()
  await testMastra.startWorkers()

  const failingWrite = vi.spyOn(db, "update").mockImplementation(() => {
    throw new Error(BOOM)
  })
  try {
    const run = await sitemapProbe.createRun()
    const result = await run.start({ inputData: { profileId: CRAWL_PROFILE } })
    results.sitemap = (result as { status: string }).status
  } finally {
    failingWrite.mockRestore()
  }

  const recrawlRun = await recrawlProbe.createRun()
  results.recrawl = (
    (await recrawlRun.start({ inputData: {} })) as { status: string }
  ).status

  const publishRun = await nextjsProbe.createRun()
  results.nextjs = (
    (await publishRun.start({ inputData: { postId: PUBLISH_POST } })) as { status: string }
  ).status
}, 180_000)

afterAll(async () => {
  if (previousRetryDelay === undefined) delete process.env.STAGE_RETRY_DELAY_MS
  else process.env.STAGE_RETRY_DELAY_MS = previousRetryDelay
  if (previousKey === undefined) delete process.env.WP_ENCRYPTION_KEY
  else process.env.WP_ENCRYPTION_KEY = previousKey
  if (previousMediaDir === undefined) delete process.env.MEDIA_DIR
  else process.env.MEDIA_DIR = previousMediaDir

  await testMastra.stopWorkers()
  await pubsub.close()
  await db.delete(posts).where(eq(posts.id, PUBLISH_POST))
  for (const id of PROFILES) await db.delete(websiteProfiles).where(eq(websiteProfiles.id, id))
  await closeDb()
  vi.restoreAllMocks()
})

describe("the hook workflows under ARQ's max_tries", () => {
  it("declares the pipeline's attempt count on every one of them", () => {
    expect(sitemapCrawlWorkflow.retryConfig?.attempts).toBe(MAX_ATTEMPTS - 1)
    expect(recrawlCheckWorkflow.retryConfig?.attempts).toBe(MAX_ATTEMPTS - 1)
    expect(nextjsPublishWorkflow.retryConfig?.attempts).toBe(MAX_ATTEMPTS - 1)
  })

  it("re-runs a crawl whose status write failed, rather than leaving the profile stranded", () => {
    expect(engineErrors.failuresOf("sitemap-crawl")).toHaveLength(MAX_ATTEMPTS)
    expect(engineErrors.failuresOf("sitemap-crawl")[0]).toContain(BOOM)
    expect(results.sitemap).toBe("failed")
  })

  it("re-runs the nightly check, whose next attempt is otherwise a day away", () => {
    expect(engineErrors.failuresOf("recrawl-check")).toHaveLength(MAX_ATTEMPTS)
    expect(results.recrawl).toBe("failed")
  })

  it("re-runs the Next.js publish, as ARQ's max_tries already did", () => {
    expect(engineErrors.failuresOf("nextjs-publish")).toHaveLength(MAX_ATTEMPTS)
    expect(results.nextjs).toBe("failed")
  })
})

describe("the gap between attempts", () => {
  /**
   * Item P2.95. The publish hook is where this is observable end to end: it
   * writes one `publish_start` entry per attempt, in the same band as the raise,
   * so the row itself times the retries. The crawl and the nightly check write
   * no execution log, and their pause is held by the same helper.
   */
  it("spaces the publish attempts by the configured delay", async () => {
    const [row] = await db
      .select({ logs: posts.executionLogs })
      .from(posts)
      .where(eq(posts.id, PUBLISH_POST))
    const starts = ((row?.logs ?? []) as { ts: string; event: string }[]).filter(
      (entry) => entry.event === "publish_start",
    )
    expect(starts).toHaveLength(MAX_ATTEMPTS)

    for (let i = 1; i < starts.length; i += 1) {
      const gap = Date.parse(starts[i].ts) - Date.parse(starts[i - 1].ts)
      expect(gap).toBeGreaterThanOrEqual(TEST_RETRY_DELAY_MS)
    }
  })
})
