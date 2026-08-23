/**
 * The Next.js publish hook as a registered workflow (ledger item
 * 5.3c-iii-b-2-d).
 *
 * One step, for the reason `./wordpress-publish.ts` gives: `publish_to_nextjs`
 * was one function with no resume point, and splitting it would invent a
 * persistence boundary that never existed. It is a workflow rather than a bare
 * step because a run is the only thing the `web` service can start over the
 * bus, so the publish route calls `createRun()` and the worker executes it.
 *
 * Unlike the WordPress hook, this one can throw: Python left the payload build
 * outside its `try`, so a manifest or a frontmatter mapping that raises escapes
 * the job. ARQ answered that with `max_tries = 3`, and `retryConfig.attempts`
 * is that policy, one fewer because the evented engine counts retries after the
 * first execution. Nothing else here retries: a webhook that answers non-200 or
 * refuses the connection is handled by `_fail` and returns normally, exactly as
 * it did under ARQ.
 */
import { createWorkflow } from "@mastra/core/workflows/evented"

import { MAX_ATTEMPTS } from "../state"
import {
  nextjsPublishInputSchema,
  nextjsPublishOutputSchema,
  nextjsPublishStep,
} from "../steps/nextjs-publish"

export const nextjsPublishWorkflow = createWorkflow({
  id: "nextjs-publish",
  inputSchema: nextjsPublishInputSchema,
  outputSchema: nextjsPublishOutputSchema,
  retryConfig: { attempts: MAX_ATTEMPTS - 1 },
})
  .then(nextjsPublishStep)
  .commit()
