/**
 * The full-pipeline completion hook as a Mastra step, ported from the
 * `if is_full_pipeline:` block at `api/src/worker.py:277` and the
 * `_post_completion_hook` it calls.
 *
 * A run that reaches the end of the chain has produced everything the post
 * needs, but nothing had yet said so on the row: `current_stage` still read as
 * whichever stage ran last and `completed_at` was still null. Those two columns
 * are what the dashboard and the posts list read to tell a finished post from
 * one still moving, so the stamp is the last thing a full run does.
 *
 * A step rather than a callback on the workflow, because the structural rule of
 * this port is that everything a run does is a Mastra primitive: as a step it
 * shows up in Studio, in `run.stream()`'s events and on the finished run's
 * `steps` map like any stage, which is where the Phase 8 trace view will read
 * "did this run actually finish" from.
 *
 * It passes `ready`'s stage meta straight through, so adding it to the chain
 * leaves the workflow's declared output unchanged.
 *
 * It is also where the worker records that it finished a run, which is
 * `_record_job_completed()` at `api/src/worker.py:313`. That call sits after
 * Python's `if is_full_pipeline:` block rather than inside it, so it fires for
 * every run that reaches the end without raising, single-stage reruns
 * included. This step has exactly that reach: it is the last link in the
 * chain, a named-stage run still passes through it (only the `completed_at`
 * stamp above is gated on `is_full_pipeline`), and a run that raised or parked
 * at a review gate never arrives.
 */
import { createStep } from "@mastra/core/workflows/evented"

import { appendExecutionLog } from "../execution-log"
import { publishPipelineEvent } from "../pipeline-events"
import { markPipelineComplete } from "../post-state"
import { recordRunCompleted } from "../worker-health"
import { stageStepOutputSchema } from "./stage-io"

export const pipelineCompleteStep = createStep({
  id: "pipeline-complete",
  inputSchema: stageStepOutputSchema,
  outputSchema: stageStepOutputSchema,
  execute: async ({ inputData, mastra }) => {
    // Python's `if is_full_pipeline`. A run that named its stages is a rerun of
    // part of a post, and `markRerunComplete` in `stage-io.ts` already settles
    // `current_stage` for it; restamping `completed_at` here would move the
    // finish time of a post that finished days ago every time one stage is
    // rerun from the dashboard.
    if (!inputData.stages) {
      await markPipelineComplete(inputData.postId)
      // The row's own record of the same fact, from inside Python's database
      // block and before the publish. `stage` is `""`, as it was there: this
      // entry is about the run, not about any one stage, and `GET /logs`
      // filtering by stage is meant to skip it.
      await appendExecutionLog(inputData.postId, {
        stage: "",
        level: "info",
        event: "pipeline_complete",
        message: "Pipeline finished",
      })
      // Python's `pipeline_complete` publish, from inside the same
      // `if is_full_pipeline:` block and after the stamp, because the dashboard
      // refetches the post on this event and must read the finished row.
      // A named-stage rerun sends nothing, as it sent nothing in Python: the
      // run finished, but the post did not.
      await publishPipelineEvent(mastra.pubsub, inputData.postId, "pipeline_complete", {
        message: "Pipeline finished",
      })
    }
    await recordRunCompleted()
    return inputData
  },
})
