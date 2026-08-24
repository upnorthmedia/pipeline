/**
 * The WordPress publish hook as a registered workflow (ledger item
 * 5.3c-iii-b-1-c-iii).
 *
 * One step, because the Python job was one function and splitting it would
 * invent a persistence boundary that never existed: `publish_to_wordpress` has
 * no resume point, and a run that died halfway through the uploads was started
 * again from the top. It is a workflow rather than a bare step for the same
 * reason the sitemap crawl is one: a run is the only thing the `web` service
 * can start over the bus, so `POST /api/posts/{id}/publish` calls `createRun()`
 * and the worker process executes the step.
 *
 * `retryConfig` is ARQ's `WorkerSettings.max_tries = MAX_ATTEMPTS`, which
 * covered every registered job function (ledger item P2.94b). It retries
 * nothing the step reports: a WordPress that answers 500 is caught, recorded as
 * a failed publish and returned, so a site is never written three times for one
 * request. What it retries is the band outside that catch, the reads and the
 * `publishing` mark that bracket it, where a raise otherwise leaves the row
 * reading `publishing` with nothing left to move it. The step itself decides
 * which of those a raise is, because only it knows whether a request has
 * already gone out; see the guard at the foot of `../steps/wordpress-publish`.
 */
import { createWorkflow } from "@mastra/core/workflows/evented"

import { MAX_ATTEMPTS } from "../state"
import {
  wordpressPublishInputSchema,
  wordpressPublishOutputSchema,
  wordpressPublishStep,
} from "../steps/wordpress-publish"

export const wordpressPublishWorkflow = createWorkflow({
  id: "wordpress-publish",
  inputSchema: wordpressPublishInputSchema,
  outputSchema: wordpressPublishOutputSchema,
  retryConfig: { attempts: MAX_ATTEMPTS - 1 },
})
  .then(wordpressPublishStep)
  .commit()
