import type { PipelineStage, StageMode, StageStatus } from "./api";

/**
 * The one name each pipeline stage is called by in the UI.
 *
 * Four surfaces used to carry their own copy of this map and two of them
 * disagreed: the tab strip on `/posts/[id]` called `write` "Draft" and `edit`
 * "Editing" while the pipeline progress bar, the run trace and the monitor
 * chart called them "Write" and "Edit", so one screen showed two names for one
 * step. The names here are the verbs the stages actually are, which is also
 * what the six `rules/blog-*.md` files and the stage enum call them.
 */
export const STAGE_LABELS: Record<PipelineStage, string> = {
  research: "Research",
  outline: "Outline",
  write: "Write",
  edit: "Edit",
  images: "Images",
  ready: "Ready",
};

/**
 * The label for a stage name that is not typed as a `PipelineStage`, which is
 * how the analytics endpoints hand them back. An unrecognised value is returned
 * as it came rather than hidden, because a stage the UI does not know about is
 * a defect worth seeing.
 */
export function stageLabel(stage: string): string {
  return (STAGE_LABELS as Record<string, string>)[stage] ?? stage;
}

/**
 * What each `stage_settings` mode does, in the terms the reader cares about.
 *
 * The pipeline treats `review` and `approve_only` identically: both park the
 * run in front of the stage and write `stage_status[stage] = "review"`. The
 * two names are Python's and the column still carries both, so both are named
 * here rather than collapsed into one.
 */
export const STAGE_MODE_LABELS: Record<StageMode, string> = {
  auto: "Run automatically",
  review: "Wait for review",
  approve_only: "Wait for approval",
};

/** A mode read off a row that is only typed as a string, unrecognised values included. */
export function stageModeLabel(mode: string): string {
  return (STAGE_MODE_LABELS as Record<string, string>)[mode] ?? mode;
}

/**
 * What each `stage_status` value means on screen.
 *
 * `review` is the one a reader cannot infer from anything else: a stage parked
 * in front of a reviewer has produced no content, so without a name of its own
 * it reads exactly like a stage the run has not reached yet.
 */
export const STAGE_STATUS_LABELS: Record<StageStatus, string> = {
  pending: "Pending",
  running: "Running",
  review: "Awaiting review",
  complete: "Complete",
  failed: "Failed",
};

/** A status read off a row that is only typed as a string. */
export function stageStatusLabel(status: string): string {
  return (STAGE_STATUS_LABELS as Record<string, string>)[status] ?? status;
}
