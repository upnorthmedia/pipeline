/**
 * One way to capture the line Mastra's engine prints when a step throws, and
 * one place recording why it has to come off `console.error`.
 *
 * `StepExecutor` writes `Error executing step <id>: <stack>` through
 * `this.logger`, and that logger is never the app's. `MastraBase`'s constructor
 * gives every primitive its own `ConsoleLogger`
 * (`@mastra/core/dist/base-BeUQ6mLP.js:12`) and a primitive adopts the Mastra
 * instance's logger only in `__registerMastra`. `StepExecutor.__registerMastra`
 * exists and does call `__setLogger`, but nothing calls it: the executor is
 * built in `WorkflowEventProcessor`'s constructor, and both construction sites
 * pass `mastra` and stop there.
 *
 * - `Mastra.handleWorkflowEvent` (`mastra-Bn5mWcPE.js:4250`), the `web`
 *   process's path, builds the processor lazily and never registers it.
 * - `OrchestrationWorker.init` (`worker-BeL6789j.js:142`), the `worker`
 *   service's path, builds it in `init(deps)`. `Mastra`'s constructor does call
 *   `w.__registerMastra(this)` on each worker (`mastra-Bn5mWcPE.js:935`), but
 *   that runs before `init`, and `OrchestrationWorker` does not forward to the
 *   processor in any case.
 *
 * Verified against `@mastra/core` 1.61.0 (ledger item P2.35). The consequence
 * in the `worker` service is that a step failure prints as plain text on stderr
 * rather than as a line in the configured `PinoLogger`'s JSON stream, and that
 * `logger.trackException` for it is a no-op. The failure itself is not lost:
 * `recordRunFailure` writes `_error` onto the post and announces `stage_error`,
 * which is what the dashboard and the dead-letter queue read.
 *
 * There is no seam to fix it from here. The processor is a private field on
 * both owners and `OrchestrationWorker` is not exported, so the only route is a
 * console bridge installed by a worker entry this repo owns, which is the work
 * ledger item P2.91 already schedules. Until then this helper is how a suite
 * asserts on an expected step failure instead of leaving it on stderr.
 *
 * Call it from `beforeAll`; the spy is torn down by the caller's existing
 * `vi.restoreAllMocks()`.
 */
import { vi } from "vitest"

export interface EngineStepErrors {
  /** Every line captured, in the order the engine printed it. */
  readonly lines: string[]
  /** The lines naming a given step id's thrown error. */
  failuresOf(stepId: string): string[]
}

export function captureEngineStepErrors(): EngineStepErrors {
  const lines: string[] = []
  vi.spyOn(console, "error").mockImplementation((...args: unknown[]) => {
    lines.push(args.map(String).join(" "))
  })
  return {
    lines,
    failuresOf: (stepId) => lines.filter((line) => line.startsWith(`Error executing step ${stepId}:`)),
  }
}
