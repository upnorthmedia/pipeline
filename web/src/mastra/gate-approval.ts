/**
 * Releasing a run that is parked at a review gate.
 *
 * A gated stage calls `suspend()`, which parks the whole run: its place in the
 * chain, the stages it already committed and the stage it stopped in front of
 * all live in `mastra_workflow_snapshot` until something resumes it. Resuming
 * needs the run id and, for a gate inside a nested workflow, the path to the
 * step that suspended. A route handler has neither. It has a post id, and it
 * is not even in the process that started the run.
 *
 * So this module is the translation between the two: post id in, the waiting
 * run out, and a resume that names nothing the caller has to know. It is
 * deliberately free of the `Mastra` singleton, taking the workflow as an
 * argument, so a test can drive it against its own instance and its own Redis
 * key prefix rather than joining the orchestration group the worker consumes.
 */
import type { Stage } from "./state"
import { gateSuspendSchema, type ReviewMode } from "./steps/stage-io"
import type { pipelineWorkflow } from "./workflows/pipeline"

type PipelineWorkflow = typeof pipelineWorkflow

/** The one run a post is waiting on, and what it is waiting for. */
export type SuspendedGate = {
  runId: string
  /** The stage the run stopped in front of. */
  stage: Stage
  /** The `stage_settings` value that stopped it, so the two modes are distinguishable. */
  mode: ReviewMode
}

/**
 * How long the resume is given to report a problem before the caller is told
 * it was accepted.
 *
 * Everything that can reject a resume for a reason a *user* caused (no
 * snapshot, the run is no longer suspended, the step will not take this resume
 * payload) is checked before the engine publishes anything, and all of it is
 * one storage read. What follows the publish is the run itself, which is the
 * five remaining stages and minutes long, and which nothing may hold a request
 * open for. The promise the engine hands back does not distinguish the two, so
 * this is the line between them.
 */
const RESUME_ACCEPTED_MS = 2_000

/**
 * The gate payload a suspended snapshot carries, or null if this run is parked
 * on something that is not one of ours.
 *
 * The payload is read from the snapshot rather than from the post row because
 * the snapshot is what the engine will act on: if the two disagree, the run is
 * the truth and the row is stale. `suspendedPaths` names the *top level* step,
 * which for the images gate is the nested workflow rather than the step that
 * actually suspended, so the stage is taken from the payload, which both write.
 */
function gateFromSnapshot(snapshot: unknown): Omit<SuspendedGate, "runId"> | null {
  const state = snapshot as
    | {
        suspendedPaths?: Record<string, unknown>
        context?: Record<string, { suspendPayload?: unknown } | undefined>
      }
    | undefined
  for (const stepId of Object.keys(state?.suspendedPaths ?? {})) {
    const parsed = gateSuspendSchema.safeParse(state?.context?.[stepId]?.suspendPayload)
    if (parsed.success) return { stage: parsed.data.stage, mode: parsed.data.mode }
  }
  return null
}

/**
 * The run this post is waiting on, or null if it is not waiting on one.
 *
 * The lookup is `resourceId`, which `startPipeline()` sets to the post id: an
 * indexed column and a two-value `where`, not a scan. Matching instead on the
 * `postId` inside every suspended snapshot would also find runs started before
 * that tag existed, and it was tried: it reads every suspended run in the
 * table, and the first thing it did was release a two-day-old orphan whose post
 * had long since moved on. A run with no `resourceId` is not releasable by post
 * id, and `docs/polish/evidence/p2.md#p2109a` states that as a gap.
 *
 * Newest first, which is the order the store returns: a post that was started
 * again while it was parked has more than one suspended run, and the one the
 * reviewer is looking at is the last one to have stopped.
 */
export async function findSuspendedGate(
  workflow: PipelineWorkflow,
  postId: string,
): Promise<SuspendedGate | null> {
  const { runs } = await workflow.listWorkflowRuns({ status: "suspended", resourceId: postId })

  for (const run of runs) {
    const gate = gateFromSnapshot(run.snapshot)
    if (gate) return { runId: run.runId, ...gate }
  }
  return null
}

/**
 * Approve whatever this post is parked on, and let the run carry on.
 *
 * Returns the gate that was released, or null when nothing was waiting, which
 * is what a second click on the same approval looks like and is not an error.
 *
 * The step to resume is not named. The engine derives it from the snapshot's
 * `suspendedPaths`, including the `["images", "images-manifest"]` path of the
 * gate that lives inside the nested images workflow, and deriving it there
 * means this module never has to know the shape of the pipeline.
 *
 * `createRun({ runId })` is a handle onto an existing run, not a new one: it
 * reads the stored snapshot back and leaves it alone. That is what makes this
 * callable from a `web` process that has never seen the run.
 */
export async function approveSuspendedGate(
  workflow: PipelineWorkflow,
  postId: string,
): Promise<SuspendedGate | null> {
  const gate = await findSuspendedGate(workflow, postId)
  if (!gate) return null

  const run = await workflow.createRun({ runId: gate.runId })
  let rejection: unknown
  const resumed = run.resume({ resumeData: { approved: true } }).catch((error: unknown) => {
    rejection = error
  })
  await Promise.race([
    resumed,
    new Promise((resolve) => setTimeout(resolve, RESUME_ACCEPTED_MS)),
  ])
  if (rejection) throw rejection
  return gate
}
