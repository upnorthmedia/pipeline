/**
 * The `enqueue_job("run_pipeline_stage", post_id, stage)` call
 * `api/src/api/posts.py` made after writing a new post and from every pipeline
 * control endpoint.
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
 * of them `stage_settings` marks for review. Naming stages is ARQ's
 * `stage="write"`, which `run_pipeline_stage` turned into `stages=[stage]` and
 * ran with no gate checks.
 */
import { mastra } from "./index"
import type { Stage } from "./state"

export async function startPipeline(postId: string, stages?: Stage[]): Promise<string> {
  const run = await mastra.getWorkflow("pipeline").createRun()
  const { runId } = await run.startAsync({ inputData: { postId, stages } })
  return runId
}
