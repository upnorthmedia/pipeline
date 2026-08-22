/**
 * Phase 2's scaffold-check workflow: the smallest thing that exercises every
 * piece of infrastructure `index.ts` wires up.
 *
 * It is deliberately not a pipeline stage. Its job is to prove, without any
 * provider call or database row of its own, that:
 *   - `createWorkflow`/`createStep`/`.then()`/`.commit()` compose and run,
 *   - the run persists into the Postgres storage adapter,
 *   - `run.stream()` emits the lifecycle events the Phase 8 trace view reads,
 *   - the same events cross a process boundary over Redis Streams (item 2.4),
 *   - Mastra Studio can discover a registered workflow (item 2.5).
 *
 * It stays registered after Phase 3 so those five properties keep a cheap
 * regression test that does not cost a provider call.
 */
import { createStep, createWorkflow } from "@mastra/core/workflows"
import { z } from "zod"

const echoInput = z.object({
  message: z.string().min(1),
})

const echoOutput = z.object({
  message: z.string(),
  seenBy: z.array(z.string()),
})

/** First step: records that it ran, and hands the message on unchanged. */
export const scaffoldFirstStep = createStep({
  id: "scaffold-first",
  inputSchema: echoInput,
  outputSchema: echoOutput,
  execute: async ({ inputData }) => ({
    message: inputData.message,
    seenBy: ["scaffold-first"],
  }),
})

/**
 * Second step: appends to `seenBy`. Reading the first step's output is what
 * proves the steps are chained rather than run independently, and gives the
 * event assertions two distinct `workflow-step-result` payloads to check.
 */
export const scaffoldSecondStep = createStep({
  id: "scaffold-second",
  inputSchema: echoOutput,
  outputSchema: echoOutput,
  execute: async ({ inputData }) => ({
    message: inputData.message,
    seenBy: [...inputData.seenBy, "scaffold-second"],
  }),
})

export const scaffoldCheckWorkflow = createWorkflow({
  id: "scaffold-check",
  inputSchema: echoInput,
  outputSchema: echoOutput,
})
  .then(scaffoldFirstStep)
  .then(scaffoldSecondStep)
  .commit()
