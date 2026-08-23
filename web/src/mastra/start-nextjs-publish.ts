/**
 * The `enqueue_job("publish_to_nextjs", post_id)` call `api/src/api/posts.py`
 * made from `POST /{post_id}/publish`.
 *
 * The sibling of `./start-wordpress-publish.ts`, and here for the same reason:
 * starting a run is the boundary between `web` and `worker`. `startAsync()`
 * publishes `workflow.start` onto Redis Streams and returns the run id without
 * waiting, so reading every image off disk, base64-encoding it and posting the
 * signed webhook all happen in the worker process.
 *
 * Unlike the WordPress hook this workflow carries a retry policy, because
 * Python built the payload outside its `try` and ARQ's `max_tries` therefore
 * applied to it. That lives on the workflow, not here.
 */
import { mastra } from "./index"

export async function startNextjsPublish(postId: string): Promise<string> {
  const run = await mastra.getWorkflow("nextjsPublish").createRun()
  const { runId } = await run.startAsync({ inputData: { postId } })
  return runId
}
