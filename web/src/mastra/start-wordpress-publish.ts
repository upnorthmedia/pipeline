/**
 * The `enqueue_job("publish_to_wordpress", post_id)` call
 * `api/src/api/posts.py` made from `POST /{post_id}/publish`, and the same call
 * `_post_completion_hook()` in `api/src/worker.py` made when a finished post
 * asked for it.
 *
 * It lives here rather than in the route handler for the same reason
 * `start-pipeline.ts` and `start-crawl.ts` do: starting a run is the boundary
 * between `web` and `worker`. `startAsync()` publishes `workflow.start` onto
 * Redis Streams and returns the run id without waiting, so the uploads and the
 * two WordPress requests happen in the worker process and a Next.js request is
 * never held open for the length of a publish.
 */
import { mastra } from "./index"

export async function startWordPressPublish(postId: string): Promise<string> {
  const run = await mastra.getWorkflow("wordpressPublish").createRun()
  const { runId } = await run.startAsync({ inputData: { postId } })
  return runId
}
