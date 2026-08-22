/**
 * The sitemap crawl as a registered workflow (ledger item 5.2c-ii-1).
 *
 * One step, because the Python job was one function and splitting it would
 * invent a persistence boundary that never existed. It is a workflow rather
 * than a bare step because a run is the only thing the `web` service can start
 * over the bus: `POST /api/profiles/{id}/crawl` (item 5.2c-iii) calls
 * `createRun()` and `startAsync()`, and the worker process executes the step.
 *
 * On the evented engine for the same reason the pipeline is: `createWorkflow`
 * from `@mastra/core/workflows` runs in the calling process, which would put a
 * multi-minute crawl of a stranger's website inside a Next.js request.
 */
import { createWorkflow } from "@mastra/core/workflows/evented"

import {
  sitemapCrawlInputSchema,
  sitemapCrawlOutputSchema,
  sitemapCrawlStep,
} from "../steps/sitemap-crawl"

export const sitemapCrawlWorkflow = createWorkflow({
  id: "sitemap-crawl",
  inputSchema: sitemapCrawlInputSchema,
  outputSchema: sitemapCrawlOutputSchema,
})
  .then(sitemapCrawlStep)
  .commit()
