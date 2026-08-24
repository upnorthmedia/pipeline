import type { PipelineStage } from "./api";

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
