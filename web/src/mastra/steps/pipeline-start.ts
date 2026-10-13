/**
 * The run-level `pipeline_start` record, ported from the `if is_full_pipeline:`
 * block at the top of `_run_pipeline()` (`api/src/worker.py:117`).
 *
 * Python's very first act on a full run, before it loaded API keys and before
 * the stage loop, was to append one line to `posts.execution_logs`. It is the
 * only thing that says a full run was started at all: a run that dies inside
 * `research` commits no column and moves no status, so without this entry
 * `GET /api/posts/{id}/logs` shows nothing for it and an operator cannot tell a
 * run that failed immediately from one that was never enqueued.
 *
 * A step rather than something the route handler that starts the run does,
 * because the structural rule of this port is that everything a run does is a
 * Mastra primitive. That is also the honest place for it: `web` starting a run
 * only means the event reached Redis, while this entry is meant to say the
 * worker picked it up and began.
 *
 * Symmetric with `pipeline-complete.ts` at the other end of the chain, down to
 * the gate: both are about the run rather than about any stage, both write
 * `stage: ""`, and both do nothing at all for a run that named its stages,
 * which is a rerun of part of a post rather than a pipeline.
 *
 * It passes its input straight through, so the chain's first stage receives
 * exactly the workflow's input.
 *
 * There is no `pipeline_start` SSE event to publish beside it. Python wrote
 * this entry to the row and published nothing, and `use-sse.ts` has never had a
 * handler for such an event.
 */
import { createStep } from "@mastra/core/workflows/evented"

import { appendExecutionLog } from "../execution-log"
import { stageStepInputSchema } from "./stage-io"

export const pipelineStartStep = createStep({
  id: "pipeline-start",
  inputSchema: stageStepInputSchema,
  outputSchema: stageStepInputSchema,
  execute: async ({ inputData }) => {
    // Python's `is_full_pipeline = stages is None`.
    if (!inputData.stages) {
      await appendExecutionLog(inputData.postId, {
        stage: "",
        level: "info",
        event: "pipeline_start",
        message: "Full pipeline run initiated",
      })
    }
    return inputData
  },
})
