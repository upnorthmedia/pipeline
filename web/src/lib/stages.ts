import type { PipelineStage, StageMode, StageSettings, StageStatus } from "./api";

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

/**
 * What a gate change did, as a sentence: "Outline will wait for review."
 *
 * The confirmation the per-post gate picker on `/posts/[id]` reports, kept
 * beside the labels it is built from so the mode never has two names.
 */
export function stageModeSentence(stage: PipelineStage, mode: StageMode): string {
  const label = STAGE_MODE_LABELS[mode] ?? mode;
  return `${STAGE_LABELS[stage]} will ${label.charAt(0).toLowerCase()}${label.slice(1)}.`;
}

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

/**
 * What a stage will actually do on a run configured by `settings`.
 *
 * Two fallbacks, and they disagree, which is why this is a function rather
 * than an index. A post whose whole `stage_settings` column is null runs every
 * stage unattended (`post.stageSettings || defaultStageSettings()` in
 * `src/mastra/post-state.ts`), but a column that names *some* stages parks the
 * run at the ones it leaves out: `DEFAULT_GATE_MODE` in
 * `src/mastra/steps/stage-io.ts` reads it with a `review` fallback, failing
 * safe towards the human rather than towards the provider's bill. A profile
 * row with a hole in it therefore stops a run at a stage nothing on screen
 * ever named. `stage-modes.test.ts` cross-checks both constants.
 */
export function effectiveStageMode(
  stage: PipelineStage,
  settings: Partial<StageSettings> | null | undefined,
): StageMode {
  if (!settings) return "auto";
  return settings[stage] ?? "review";
}

/** Whether a mode parks the run in front of the stage, `REVIEW_MODES`. */
export function stageModeStopsRun(mode: StageMode): boolean {
  return mode !== "auto";
}

/**
 * What a stage-mode picker offers, plus whatever the row is already set to.
 *
 * All three modes are offered. Only `auto` was, for as long as nothing in the
 * dashboard could resume a suspended run: a gate switched on parked the post
 * with no approve action anywhere to release it. `POST /api/posts/{id}/approve`
 * and the approval on the post page are that action, so the two waiting modes
 * are real settings again (ledger item P2.109b).
 *
 * The pipeline treats `review` and `approve_only` identically; both names are
 * kept because the column carries both and a profile written by the Python app
 * may hold either.
 *
 * Two pickers read this now, the profile editor's defaults and the per-post
 * gates on the new-post form (ledger item P2.114), so it lives beside the
 * labels rather than in either page.
 */
export const OFFERED_STAGE_MODES: StageMode[] = ["auto", "review", "approve_only"];

export function stageModeOptions(current: StageMode | undefined): StageMode[] {
  // `stage_settings` is a bare JSON object on the wire, so a row that names
  // fewer than six stages reaches here with a hole in it. Prepending that hole
  // would put an option with no value in the list, and the picker is not the
  // place to guess what an unconfigured stage means.
  if (!current || OFFERED_STAGE_MODES.includes(current)) return OFFERED_STAGE_MODES;
  return [current, ...OFFERED_STAGE_MODES];
}
