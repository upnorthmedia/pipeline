/**
 * Where a permanently failed pipeline run is recorded.
 *
 * Python's runner caught the exception out of `_run_pipeline()` and, once ARQ
 * had spent `MAX_ATTEMPTS`, called `_move_to_dlq()`: push a JSON entry onto a
 * Redis list and stamp the post `current_stage = "failed"` with an `_error`
 * entry in `stage_logs` (`api/src/worker.py:389`). Nothing in the TypeScript
 * port did either, so a run that died left the row sitting on the stage it was
 * executing and the dashboard's `failed` bucket permanently empty.
 *
 * The Redis list is not ported. A failed run is already recorded, durably and
 * with its error, by Mastra itself: `processWorkflowFail` writes
 * `status: "failed"` and the error onto the run's row in the Postgres storage
 * adapter before it publishes anything. A second list in Redis would be a
 * parallel store of the same fact that nothing keeps in step. The dead-letter
 * *endpoints* (ledger 5.4d-ii, 5.4d-iii) therefore read Mastra's run rows; this
 * module only ports the half of `_move_to_dlq()` that touches the post, which
 * is the half the dashboard reads.
 *
 * The hook is a listener on the `workflows-finish` topic, registered through
 * `events` on the Mastra instance. That keeps it inside a Mastra primitive and
 * puts it in the right process for free: `Mastra.startWorkers()` is what
 * subscribes user event listeners, and only the `worker` service calls it, so
 * `web` never double-records a failure it did not execute.
 *
 * Two properties of that topic shape the code below, both measured rather than
 * assumed (see `failure-recorder.test.ts`):
 *
 *   - a single failed run publishes `workflow.fail` more than once, so the
 *     write has to be safe to repeat. It is: every field it sets is derived
 *     from the event, so a repeat rewrites the same values. The `stage_error`
 *     announcement is not, because the dashboard raises a toast per event, so
 *     that one is guarded by run id.
 *   - `subscribe()` with no group is fan-out, so every worker process receives
 *     every event. Same consequence, same answer.
 *
 * A throwing listener is nacked by Mastra's wrapper and redelivered, so a
 * transient database error here retries rather than losing the record.
 */
import type { Event, PubSub } from "@mastra/core/events"

import { publishPipelineEvent } from "./pipeline-events"
import { markPipelineFailed } from "./post-state"
import { STAGES, type Stage } from "./state"
import { pipelineWorkflow } from "./workflows/pipeline"

/**
 * How many times a failing run was executed before the engine gave up, which is
 * what Python passed as `attempts` (ARQ's `job_try`, always `MAX_ATTEMPTS` by
 * the time it reached the DLQ).
 *
 * The evented engine republishes `workflow.step.run` while
 * `retryCount < retryConfig.attempts` and only fails the run once that is
 * exhausted, so a run that reaches `workflow.fail` has executed the failing
 * step `attempts + 1` times. `pipelineWorkflow.retryConfig` is `{attempts: 0}`
 * (the engine's default; the workflow sets none), so today this is 1 and a
 * later retry policy moves it without touching this module.
 */
function executionsBeforeFailure(): number {
  return (pipelineWorkflow.retryConfig?.attempts ?? 0) + 1
}

/**
 * The workflow whose failures mark a post. The nested `images` workflow fails
 * its parent rather than standing alone, and `sitemapCrawl`, `recrawlCheck` and
 * `scaffoldCheck` are not about a post at all, so this is the only id that maps
 * onto a row.
 */
const PIPELINE_WORKFLOW_ID = pipelineWorkflow.id

/** The post id a run carries: `stageStepInputSchema`'s, as the engine stored it. */
function postIdOf(data: unknown): string | undefined {
  const stepResults = (data as { stepResults?: { input?: { postId?: unknown } } })?.stepResults
  const postId = stepResults?.input?.postId
  return typeof postId === "string" && postId.length > 0 ? postId : undefined
}

/**
 * The failed step's error text, Python's `str(e)`.
 *
 * The engine serialises a thrown `Error` to `{name, message}` and passes a
 * thrown non-`Error` through as it was, so both shapes reach here.
 */
function messageOf(data: unknown): string {
  const error = (data as { prevResult?: { error?: unknown } })?.prevResult?.error
  if (typeof error === "string") return error
  const message = (error as { message?: unknown })?.message
  return typeof message === "string" ? message : String(error ?? "")
}

/**
 * The stage that failed: the step in the run's results whose own status is
 * `failed`. Python sent `target_stages[0] if len(target_stages) == 1 else ""`,
 * so a full run reported no stage at all and the dashboard showed "Pipeline
 * failed"; the run results name the step that actually threw, so this reports
 * it, which is the same choice `dead-letter.ts` records for the DLQ list.
 *
 * Only the six stage ids are considered, so `input`, `__state` and the
 * bookkeeping steps in the chain cannot be mistaken for one.
 */
function failedStageOf(data: unknown): Stage | "" {
  const stepResults = (data as { stepResults?: Record<string, unknown> })?.stepResults
  for (const stage of STAGES) {
    const step = stepResults?.[stage] as { status?: unknown } | undefined
    if (step?.status === "failed") return stage
  }
  return ""
}

/**
 * Runs already announced by this process, so one failure produces one
 * `stage_error` on the bus.
 *
 * The engine publishes `workflow.fail` more than once for a single failed run
 * (measured in `failure-recorder.test.ts`), which the database write above can
 * absorb because it rewrites the same values. A notification cannot: the
 * dashboard raises a toast per `stage_error` and appends one debug log line
 * per event, so a repeat is visible to the operator. Python published exactly
 * one per attempt.
 *
 * In-process, and deliberately so: it guards the measured duplicate, which is
 * two publishes of the same event a few milliseconds apart, reaching the same
 * subscriber. It is not a distributed lock, and a second `worker` process
 * subscribed to the same fan-out topic would announce the same failure again.
 * The bound keeps a long-lived worker from accumulating run ids forever;
 * insertion order makes the oldest entry the one to drop.
 */
const announced = new Set<string>()
const ANNOUNCED_LIMIT = 1000

function firstAnnouncementOf(runId: string): boolean {
  if (announced.has(runId)) return false
  announced.add(runId)
  if (announced.size > ANNOUNCED_LIMIT) {
    const oldest = announced.values().next().value
    if (oldest !== undefined) announced.delete(oldest)
  }
  return true
}

/**
 * Record a `workflow.fail` event against its post and tell the dashboard.
 * Registered as the `workflows-finish` listener in `index.ts`.
 *
 * Events for other workflows, other lifecycle types, and runs with no post id
 * on their input are ignored rather than treated as errors: the topic carries
 * every run's terminal event, not only this workflow's.
 *
 * The row is written before the event goes out, which is the order every
 * announcement in this port keeps: `posts/[id]/page.tsx` refetches the post on
 * `stage_error`, so the refetch must not read a row that still calls the run
 * healthy.
 */
export async function recordRunFailure(event: Event, pubsub: PubSub): Promise<void> {
  if (event.type !== "workflow.fail") return
  const data = event.data as { workflowId?: unknown }
  if (data?.workflowId !== PIPELINE_WORKFLOW_ID) return

  const postId = postIdOf(event.data)
  if (!postId) return

  const message = messageOf(event.data)
  await markPipelineFailed(postId, message, executionsBeforeFailure())

  if (!firstAnnouncementOf(event.runId)) return
  await publishPipelineEvent(pubsub, postId, "stage_error", {
    stage: failedStageOf(event.data),
    error: message,
    // Python's `f"Pipeline failed: {e}"`, which is what `debug-log-panel.tsx`
    // prefers over the bare error when it renders the line.
    message: `Pipeline failed: ${message}`,
  })
}

/**
 * The topic listeners the `worker` service subscribes, bound to the transport
 * the run is executing on.
 *
 * A factory rather than a constant because a listener that publishes needs a
 * `PubSub`, and taking it from `index.ts` would both close an import cycle and
 * publish onto the production transport even when a test builds its own
 * instance. `index.ts` builds this from the same `pubsub` it hands `Mastra`.
 */
export function createWorkerEvents(pubsub: PubSub) {
  return {
    "workflows-finish": (event: Event) => recordRunFailure(event, pubsub),
  }
}
