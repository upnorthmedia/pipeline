/**
 * The one badge that says what a post's run is doing.
 *
 * It replaces a badge that rendered `current_stage` straight out of the column,
 * uppercased. That was wrong twice over: it printed the raw enum value at the
 * reader, and it read one of the two columns that hold the answer, so a run
 * whose `images` stage failed but which reached the end still said COMPLETE.
 * `deriveRunState()` owns that decision and is the only thing this component
 * asks; see `src/lib/run-state.ts` for the precedence and why.
 */
import { Badge } from "@/components/ui/badge";
import { cn } from "@/lib/utils";
import type { PostStage, StageStatusMap } from "@/lib/api";
import { deriveRunState, type RunStateKind } from "@/lib/run-state";

const KIND_COLORS: Record<RunStateKind, string> = {
  not_started: "bg-muted text-muted-foreground",
  in_progress: "bg-violet-500/15 text-violet-400 border-violet-500/20",
  running: "bg-amber-500/15 text-amber-400 border-amber-500/20",
  review: "bg-sky-500/15 text-sky-400 border-sky-500/20",
  paused: "bg-orange-500/15 text-orange-400 border-orange-500/20",
  complete: "bg-emerald-500/15 text-emerald-400 border-emerald-500/20",
  // A finished run missing a stage's output is not a success and not a dead
  // run, so it gets neither colour: amber says "there is something here for
  // you" without claiming the run is still moving.
  finished_with_errors: "bg-amber-500/15 text-amber-500 border-amber-500/30",
  failed: "bg-red-500/15 text-red-400 border-red-500/20",
};

export const RunStateBadge = ({
  currentStage,
  stageStatus,
}: {
  currentStage: PostStage;
  stageStatus: StageStatusMap;
}) => {
  const state = deriveRunState({ currentStage, stageStatus });
  return (
    <Badge
      variant="outline"
      className={cn("text-[10px] tracking-wide", KIND_COLORS[state.kind])}
      title={state.detail ?? undefined}
    >
      {state.label}
    </Badge>
  );
};
