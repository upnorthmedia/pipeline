/**
 * The approval half of the pair `start-pipeline.ts` opens: that module starts a
 * run in the worker, this one releases a run the worker parked.
 *
 * It exists for the same reason, and is the same three lines: `gate-approval.ts`
 * is deliberately free of the `Mastra` singleton so its tests can drive their
 * own instance on their own Redis key prefix, which leaves somebody to hand it
 * the registered workflow. That somebody is here rather than in the route
 * handler, so the boundary between `web` and `worker` stays in one directory.
 *
 * The resume publishes onto Redis Streams and is not awaited to completion:
 * `approveSuspendedGate` returns as soon as the engine has accepted it, and the
 * five remaining stages execute in the worker process.
 */
import { approveSuspendedGate, type SuspendedGate } from "./gate-approval"
import { mastra } from "./index"

export async function approvePipelineGate(postId: string): Promise<SuspendedGate | null> {
  return approveSuspendedGate(mastra.getWorkflow("pipeline"), postId)
}
