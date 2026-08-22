/**
 * The pieces the pipeline control endpoints in `api/src/api/posts.py` shared:
 * `_next_stage()` and the 400s the run endpoints raise before anything is
 * enqueued.
 *
 * `_next_stage()` was defined in the router, not in `state.py`, and it stays
 * at the route layer for the same reason: it decides which stage name the
 * response echoes, not which stages the run executes. The run itself is handed
 * `stage` verbatim, so a `/run` with no `stage` starts a full pipeline whose
 * own skip rule (`shouldRunStage()` in `mastra/steps/stage-io.ts`) re-derives
 * the same first-incomplete stage from the committed row.
 */
import type { StageStatusJson } from "@/db"
import { STAGES, STATUS_COMPLETE } from "@/mastra/state"
import type { Stage } from "@/mastra/state"

/** The first stage `stage_status` does not call complete, or null if none is left. */
export function nextStage(stageStatus: StageStatusJson | null): Stage | null {
  const status = stageStatus ?? {}
  for (const stage of STAGES) {
    if (status[stage] !== STATUS_COMPLETE) return stage
  }
  return null
}

export function isStage(value: string): value is Stage {
  return (STAGES as readonly string[]).includes(value)
}

/**
 * `HTTPException(400, ...)`. FastAPI renders a string detail as
 * `{"detail": "..."}`, unlike the list of issues a validation error produces.
 */
export function badRequest(detail: string): Response {
  return Response.json({ detail }, { status: 400 })
}
