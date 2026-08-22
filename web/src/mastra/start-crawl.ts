/**
 * The `enqueue_job("crawl_profile_sitemap", profile_id)` call that
 * `api/src/api/profiles.py` made from two places: the crawl endpoint and the
 * auto-enqueue at the end of profile creation.
 *
 * It lives here rather than in the route handlers because starting a run is
 * the boundary between `web` and `worker`: `startAsync()` publishes
 * `workflow.start` onto Redis Streams and returns the run id without waiting,
 * so the crawl executes in the worker process and a slow site never holds a
 * Next.js request open. That is exactly what ARQ's `enqueue_job` did.
 *
 * The nightly re-crawl sweep does not use this helper: `recrawl-check` reaches
 * the workflow through the `mastra` handed to its `execute`, so a run it starts
 * belongs to the same instance it is running on.
 */
import { mastra } from "./index"

export async function startSitemapCrawl(profileId: string): Promise<string> {
  const run = await mastra.getWorkflow("sitemapCrawl").createRun()
  const { runId } = await run.startAsync({ inputData: { profileId } })
  return runId
}
