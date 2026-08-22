/**
 * `crawl_profile_sitemap` from `api/src/worker.py`, as a Mastra step.
 *
 * The ARQ job discovered a profile's sitemaps, parsed every URL out of them and
 * upserted the results into `internal_links`, moving `crawl_status` from
 * `crawling` to `complete` or `failed` around the work. The parse and fetch half
 * is already ported (`../sitemap`); this is the persistence half.
 *
 * It is a step rather than a helper because the objective's structural rule
 * puts every background job in a Mastra primitive: a step registered on the
 * instance is what Studio can see, what the worker executes off Redis Streams,
 * and what the `web` service can start without doing the work itself.
 *
 * Two properties of the Python job that a naive port would lose:
 *
 * * **A crawl failure is not a job failure.** Python catches everything, marks
 *   the profile `failed` and returns normally, so ARQ never retried a crawl.
 *   This step does the same and reports the failure in its output rather than
 *   throwing, because a thrown step is retried by the transport and a site that
 *   is down would be re-fetched on every redelivery.
 * * **A missing profile is not an error either.** Python logged and returned.
 */
import { createStep } from "@mastra/core/workflows/evented"
import { eq, sql } from "drizzle-orm"
import { z } from "zod"

import { getDb, internalLinks, websiteProfiles } from "../../db"
import { crawlSitemap, type SitemapEntry } from "../sitemap"

export const sitemapCrawlInputSchema = z.object({
  profileId: z.uuid(),
})

export type SitemapCrawlInput = z.infer<typeof sitemapCrawlInputSchema>

export const sitemapCrawlOutputSchema = z.object({
  profileId: z.uuid(),
  /**
   * `missing` is Python's "profile not found" branch; the other two are the
   * value left in `website_profiles.crawl_status`.
   */
  status: z.enum(["complete", "failed", "missing"]),
  /** Entries `crawl_sitemap` returned, duplicates included. */
  entries: z.number().int().nonnegative(),
  /** Rows written, which is the entry count deduplicated by URL. */
  upserted: z.number().int().nonnegative(),
  /** The failure's message, for the trace view. Null on every other status. */
  error: z.string().nullable(),
})

export type SitemapCrawlOutput = z.infer<typeof sitemapCrawlOutputSchema>

/**
 * `urlparse(url).path`, for a string that may not be a URL at all.
 *
 * `new URL()` cannot stand in: it throws on the relative and non-URL `<loc>`
 * values a malformed sitemap can carry, where `urlparse` returns them as a
 * path. The oracle in `data/crawl-slug-parity.json` pins both against the real
 * Python function, including the details that neither implementation decodes
 * percent-escapes and that the fragment is split off before the query.
 */
export function urlPath(url: string): string {
  let rest = url
  const scheme = /^[a-zA-Z][a-zA-Z0-9+.-]*:/.exec(rest)
  if (scheme) rest = rest.slice(scheme[0].length)
  if (rest.startsWith("//")) {
    const authorityEnd = rest.slice(2).search(/[/?#]/)
    rest = authorityEnd === -1 ? "" : rest.slice(2 + authorityEnd)
  }
  return rest.split("#")[0].split("?")[0]
}

/**
 * The job's `slug` derivation: the last non-empty path segment, or null for a
 * URL whose path is empty or only slashes.
 */
export function slugFromUrl(url: string): string | null {
  const path = urlPath(url).replace(/^\/+/, "").replace(/\/+$/, "")
  if (!path) return null
  const segments = path.split("/")
  return segments[segments.length - 1]
}

interface LinkRow {
  profileId: string
  url: string
  title: string | null
  slug: string | null
}

/**
 * Fold entries into one row per URL.
 *
 * Python selected, then inserted or updated, once per entry, so a sitemap that
 * lists the same URL twice took the second entry's title only if it had one.
 * Folding "last truthy wins" here reproduces that in a single row, which is
 * what lets the writes be batched: `ON CONFLICT DO UPDATE` refuses to touch the
 * same row twice within one statement.
 */
export function foldEntries(profileId: string, entries: SitemapEntry[]): LinkRow[] {
  const rows = new Map<string, LinkRow>()
  for (const entry of entries) {
    const existing = rows.get(entry.url)
    const row: LinkRow = existing ?? {
      profileId,
      url: entry.url,
      title: null,
      slug: slugFromUrl(entry.url),
    }
    if (entry.title) row.title = entry.title
    rows.set(entry.url, row)
  }
  return [...rows.values()]
}

/** Rows per `INSERT`, so a large sitemap does not build one enormous statement. */
export const UPSERT_CHUNK_SIZE = 500

/**
 * `if entry.title: link.title = entry.title` and the same for `slug`, as a
 * conflict clause: a null or empty incoming value keeps whatever is stored,
 * and `source`, `post_id` and `keywords` are left alone on an existing row
 * exactly as the Python job left them.
 */
async function upsertLinks(
  tx: Pick<ReturnType<typeof getDb>, "insert">,
  rows: LinkRow[],
): Promise<void> {
  for (let start = 0; start < rows.length; start += UPSERT_CHUNK_SIZE) {
    const chunk = rows.slice(start, start + UPSERT_CHUNK_SIZE)
    await tx
      .insert(internalLinks)
      .values(chunk.map((row) => ({ ...row, source: "sitemap" })))
      .onConflictDoUpdate({
        target: [internalLinks.profileId, internalLinks.url],
        set: {
          title: sql`coalesce(nullif(excluded.title, ''), ${internalLinks.title})`,
          slug: sql`coalesce(nullif(excluded.slug, ''), ${internalLinks.slug})`,
        },
      })
  }
}

export const sitemapCrawlStep = createStep({
  id: "sitemap-crawl",
  inputSchema: sitemapCrawlInputSchema,
  outputSchema: sitemapCrawlOutputSchema,
  execute: async ({ inputData, mastra }) => {
    const { profileId } = inputData
    const logger = mastra?.getLogger()
    const db = getDb()

    const [profile] = await db
      .select({
        id: websiteProfiles.id,
        name: websiteProfiles.name,
        websiteUrl: websiteProfiles.websiteUrl,
      })
      .from(websiteProfiles)
      .where(eq(websiteProfiles.id, profileId))
      .limit(1)

    if (!profile) {
      logger?.error(`Profile ${profileId} not found`)
      return { profileId, status: "missing" as const, entries: 0, upserted: 0, error: null }
    }

    await db
      .update(websiteProfiles)
      .set({ crawlStatus: "crawling" })
      .where(eq(websiteProfiles.id, profileId))

    try {
      const entries = await crawlSitemap(profile.websiteUrl)
      logger?.info(
        `Crawled ${entries.length} URLs for profile ${profile.name} (${profile.websiteUrl})`,
      )

      const rows = foldEntries(profileId, entries)
      // One transaction for the links and the status, because Python committed
      // them together: a crawl that dies partway leaves the profile `crawling`
      // and the table untouched rather than half-written and `complete`.
      await db.transaction(async (tx) => {
        await upsertLinks(tx, rows)
        await tx
          .update(websiteProfiles)
          .set({ crawlStatus: "complete", lastCrawledAt: new Date() })
          .where(eq(websiteProfiles.id, profileId))
      })

      logger?.info(`Sitemap crawl complete for profile ${profile.name}`)
      return {
        profileId,
        status: "complete" as const,
        entries: entries.length,
        upserted: rows.length,
        error: null,
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      logger?.error(`Sitemap crawl failed for profile ${profileId}`, { error: message })
      await db
        .update(websiteProfiles)
        .set({ crawlStatus: "failed" })
        .where(eq(websiteProfiles.id, profileId))
      return {
        profileId,
        status: "failed" as const,
        entries: 0,
        upserted: 0,
        error: message,
      }
    }
  },
})
