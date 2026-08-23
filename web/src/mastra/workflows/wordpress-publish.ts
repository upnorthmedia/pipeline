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
 */
import { createWorkflow } from "@mastra/core/workflows/evented"

import {
  wordpressPublishInputSchema,
  wordpressPublishOutputSchema,
  wordpressPublishStep,
} from "../steps/wordpress-publish"

export const wordpressPublishWorkflow = createWorkflow({
  id: "wordpress-publish",
  inputSchema: wordpressPublishInputSchema,
  outputSchema: wordpressPublishOutputSchema,
})
  .then(wordpressPublishStep)
  .commit()
