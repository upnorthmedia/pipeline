/**
 * `check_recrawl_schedules` from `api/src/worker.py`, as a Mastra step.
 *
 * ARQ ran it on `cron(check_recrawl_schedules, hour=0, minute=0)`: once a day
 * it looked for profiles whose `recrawl_interval` had elapsed since their
 * `last_crawled_at` and enqueued `crawl_profile_sitemap` for each one. It is
 * not a router, so Phase 5's per-router plan had no slot for it, and deleting
 * `api/` in Phase 7 would have silently dropped every scheduled re-crawl.
 *
 * The port keeps the two halves separate the same way ARQ did: this step only
 * decides who is due and starts a `sitemapCrawl` run per profile, and the crawl
 * itself is `./sitemap-crawl`. `startAsync()` is the `enqueue_job` equivalent:
 * it publishes `workflow.start` and returns the run id without waiting, so one
 * slow site cannot hold up the rest of the nightly sweep.
 */
import { createStep } from "@mastra/core/workflows/evented"
import { and, isNotNull, ne } from "drizzle-orm"
import { z } from "zod"

import { getDb, websiteProfiles } from "../../db"

export const recrawlCheckInputSchema = z.object({})

export type RecrawlCheckInput = z.infer<typeof recrawlCheckInputSchema>

export const recrawlCheckOutputSchema = z.object({
  /** Profiles the query returned, which is Python's `len(profiles)`. */
  considered: z.number().int().nonnegative(),
  /** The runs started, which is Python's `enqueued`. */
  started: z.array(z.object({ profileId: z.uuid(), runId: z.string().min(1) })),
})

export type RecrawlCheckOutput = z.infer<typeof recrawlCheckOutputSchema>

/**
 * The intervals the job understands, and how many whole days each one waits.
 *
 * A `Map` rather than an object literal so a profile whose `recrawl_interval`
 * is `constructor` or `toString` cannot reach `Object.prototype` and be read as
 * a due interval. The column is a free `varchar(20)` with no check constraint,
 * so the value is whatever a client sent.
 */
export const RECRAWL_INTERVAL_DAYS = new Map<string, number>([
  ["weekly", 7],
  ["biweekly", 14],
  ["monthly", 30],
])

/**
 * Python's per-profile branch, verbatim in its ordering:
 *
 * ```py
 * if not profile.last_crawled_at:
 *     enqueue; continue
 * delta = now - profile.last_crawled_at
 * if profile.recrawl_interval == "weekly" and delta.days >= 7: ...
 * ```
 *
 * The detail a rewrite loses: the never-crawled check runs *before* the
 * interval is looked at, so a profile with an unrecognised interval and no
 * `last_crawled_at` is still crawled.
 *
 * `Math.floor` is what `timedelta.days` does (both floor toward negative
 * infinity). The two only diverge for a negative delta, and since every
 * threshold here is positive both answer "not due" for a `last_crawled_at` in
 * the future, so the choice is faithfulness rather than an observable
 * difference. The oracle covers those cases anyway, in case a threshold ever
 * changes.
 */
export function isDue(recrawlInterval: string, lastCrawledAt: Date | null, now: Date): boolean {
  if (!lastCrawledAt) return true
  const days = RECRAWL_INTERVAL_DAYS.get(recrawlInterval)
  if (days === undefined) return false
  return Math.floor((now.getTime() - lastCrawledAt.getTime()) / 86_400_000) >= days
}

export const recrawlCheckStep = createStep({
  id: "recrawl-check",
  inputSchema: recrawlCheckInputSchema,
  outputSchema: recrawlCheckOutputSchema,
  execute: async ({ mastra }) => {
    if (!mastra) {
      throw new Error("recrawl-check needs a Mastra instance to start crawl runs")
    }
    const logger = mastra.getLogger()
    const db = getDb()

    /**
     * `ne()` renders `crawl_status <> 'crawling'`, which is NULL and therefore
     * false for a NULL `crawl_status`, exactly as SQLAlchemy's
     * `WebsiteProfile.crawl_status != "crawling"` was. A profile whose status
     * was never set is skipped by both stacks.
     */
    const profiles = await db
      .select({
        id: websiteProfiles.id,
        recrawlInterval: websiteProfiles.recrawlInterval,
        lastCrawledAt: websiteProfiles.lastCrawledAt,
      })
      .from(websiteProfiles)
      .where(
        and(
          isNotNull(websiteProfiles.recrawlInterval),
          ne(websiteProfiles.crawlStatus, "crawling"),
        ),
      )

    const crawl = mastra.getWorkflow("sitemapCrawl")
    const now = new Date()
    const started: RecrawlCheckOutput["started"] = []

    for (const profile of profiles) {
      if (!isDue(profile.recrawlInterval ?? "", profile.lastCrawledAt, now)) continue
      const run = await crawl.createRun()
      const { runId } = await run.startAsync({ inputData: { profileId: profile.id } })
      started.push({ profileId: profile.id, runId })
    }

    logger.info(`Re-crawl check: ${started.length} profiles enqueued out of ${profiles.length}`)
    return { considered: profiles.length, started }
  },
})
