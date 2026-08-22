/**
 * The `enqueue_job("run_pipeline_stage", post_id)` call `api/src/api/posts.py`
 * made after writing a new post.
 *
 * It lives here rather than in the route handler for the same reason
 * `start-crawl.ts` does: starting a run is the boundary between `web` and
 * `worker`. `startAsync()` publishes `workflow.start` onto Redis Streams and
 * returns the run id without waiting, so the six stages execute in the worker
 * process and a Next.js request is never held open for the length of a
 * pipeline.
 *
 * Passing no `stages` is ARQ's `stage=None`: the run executes every stage
 * `stage_status` does not already call complete, and pauses itself at whichever
 * of them `stage_settings` marks for review.
 */
import { mastra } from "./index"

export async function startPipeline(postId: string): Promise<string> {
  const run = await mastra.getWorkflow("pipeline").createRun()
  const { runId } = await run.startAsync({ inputData: { postId } })
  return runId
}
