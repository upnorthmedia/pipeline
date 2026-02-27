import { Badge } from "@/components/ui/badge";
import { cn } from "@/lib/utils";
import type { PostStage } from "@/lib/api";

const STAGE_COLORS: Record<string, string> = {
  pending: "bg-muted text-muted-foreground",
  research: "bg-violet-500/15 text-violet-400 border-violet-500/20",
  outline: "bg-sky-500/15 text-sky-400 border-sky-500/20",
  write: "bg-amber-500/15 text-amber-400 border-amber-500/20",
  edit: "bg-emerald-500/15 text-emerald-400 border-emerald-500/20",
  images: "bg-pink-500/15 text-pink-400 border-pink-500/20",
  ready: "bg-cyan-500/15 text-cyan-400 border-cyan-500/20",
  complete: "bg-emerald-500/15 text-emerald-400 border-emerald-500/20",
  failed: "bg-red-500/15 text-red-400 border-red-500/20",
  paused: "bg-orange-500/15 text-orange-400 border-orange-500/20",
};

export const StageBadge = ({ stage }: { stage: PostStage }) => (
  <Badge
    variant="outline"
    className={cn(
      "text-[10px] font-mono uppercase tracking-wider",
      STAGE_COLORS[stage] || STAGE_COLORS.pending
    )}
  >
    {stage}
  </Badge>
);
