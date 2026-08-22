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
 */
import { createStep } from "@mastra/core/workflows/evented"

import { markPipelineComplete } from "../post-state"
import { stageStepOutputSchema } from "./stage-io"

export const pipelineCompleteStep = createStep({
  id: "pipeline-complete",
  inputSchema: stageStepOutputSchema,
  outputSchema: stageStepOutputSchema,
  execute: async ({ inputData }) => {
    // Python's `if is_full_pipeline`. A run that named its stages is a rerun of
    // part of a post, and `markRerunComplete` in `stage-io.ts` already settles
    // `current_stage` for it; restamping `completed_at` here would move the
    // finish time of a post that finished days ago every time one stage is
    // rerun from the dashboard.
    if (!inputData.stages) await markPipelineComplete(inputData.postId)
    return inputData
  },
})
