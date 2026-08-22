/**
 * The nightly re-crawl check as a registered, self-scheduling workflow
 * (ledger item 5.2c-ii-2).
 *
 * `WorkerSettings.cron_jobs = [cron(check_recrawl_schedules, hour=0, minute=0)]`
 * was ARQ's own scheduler, not a job anyone enqueued. Mastra has a first-party
 * equivalent: a `schedule` declared on a workflow makes the instance's
 * `SchedulerWorker` publish a `workflow.start` event on the cron expression,
 * with `nextFireAt` advanced by a compare-and-swap in storage so only one of
 * several worker replicas polling the same Postgres claims each fire. That is a
 * property ARQ's cron did not have.
 *
 * The schedule sits on this workflow rather than on `sitemapCrawl`, because a
 * declared schedule carries one static `inputData` and `sitemapCrawl` needs a
 * different `profileId` per run. The fan-out has to be a step that queries.
 *
 * Only the worker process runs the scheduler: `SchedulerWorker` starts inside
 * `startWorkers()`, which the `web` service never calls, so a Next.js server
 * cannot fire the nightly sweep.
 */
import { createWorkflow } from "@mastra/core/workflows/evented"

import {
  recrawlCheckInputSchema,
  recrawlCheckOutputSchema,
  recrawlCheckStep,
} from "../steps/recrawl-check"

/**
 * `cron(hour=0, minute=0)` in ARQ terms: midnight every day in the host
 * timezone, which is what ARQ's cron used too (it took no timezone argument
 * here). Five-part, the form `validateCron` documents first.
 */
export const RECRAWL_CHECK_CRON = "0 0 * * *"

export const recrawlCheckWorkflow = createWorkflow({
  id: "recrawl-check",
  inputSchema: recrawlCheckInputSchema,
  outputSchema: recrawlCheckOutputSchema,
  schedule: { cron: RECRAWL_CHECK_CRON, inputData: {} },
})
  .then(recrawlCheckStep)
  .commit()
