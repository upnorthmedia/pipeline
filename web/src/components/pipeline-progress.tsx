"use client";

import {
  Search,
  List,
  Pencil,
  CheckCircle,
  ImageIcon,
  PackageCheck,
  Circle,
  Loader2,
  AlertCircle,
  Eye,
} from "lucide-react";
import { cn } from "@/lib/utils";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import type { PipelineStage, StageStatusMap } from "@/lib/api";
import { STAGES } from "@/lib/api";

const STAGE_META: Record<
  PipelineStage,
  { label: string; icon: React.ComponentType<{ className?: string }> }
> = {
  research: { label: "Research", icon: Search },
  outline: { label: "Outline", icon: List },
  write: { label: "Write", icon: Pencil },
  edit: { label: "Edit", icon: CheckCircle },
  images: { label: "Images", icon: ImageIcon },
  ready: { label: "Ready", icon: PackageCheck },
};

const STATUS_STYLES: Record<string, { ring: string; bg: string; icon: React.ComponentType<{ className?: string }> }> = {
  complete: {
    ring: "ring-emerald-500/30",
    bg: "bg-emerald-500",
    icon: CheckCircle,
  },
  running: {
    ring: "ring-amber-500/30",
    bg: "bg-amber-500",
    icon: Loader2,
  },
  review: {
    ring: "ring-blue-500/30",
    bg: "bg-blue-500",
    icon: Eye,
  },
  failed: {
    ring: "ring-red-500/30",
    bg: "bg-red-500",
    icon: AlertCircle,
  },
  pending: {
    ring: "ring-muted-foreground/20",
    bg: "bg-muted-foreground/30",
    icon: Circle,
  },
};

export const PipelineProgress = ({
  stageStatus,
  currentStage,
  compact = false,
}: {
  stageStatus: StageStatusMap;
  currentStage: string;
  compact?: boolean;
}) => {
  const completedCount = STAGES.filter(
    (s) => stageStatus[s] === "complete"
  ).length;

  if (compact) {
    return (
      <div className="flex items-center gap-1">
        {STAGES.map((stage) => {
          const status = stageStatus[stage] || "pending";
          const style = STATUS_STYLES[status] || STATUS_STYLES.pending;
          return (
            <Tooltip key={stage}>
              <TooltipTrigger>
                <div
                  className={cn(
                    "h-2 w-2 rounded-full transition-colors",
                    style.bg,
                    status === "running" && "animate-pulse"
                  )}
                />
              </TooltipTrigger>
              <TooltipContent>
                <span className="text-xs">
                  {STAGE_META[stage].label}: {status}
                </span>
              </TooltipContent>
            </Tooltip>
          );
        })}
        <span className="ml-1.5 text-[10px] font-mono text-muted-foreground">
          {completedCount}/{STAGES.length}
        </span>
      </div>
    );
  }

  return (
    <div className="flex items-center gap-0">
      {STAGES.map((stage, i) => {
        const status = stageStatus[stage] || "pending";
        const style = STATUS_STYLES[status] || STATUS_STYLES.pending;
        const Icon = status === "pending" ? STAGE_META[stage].icon : style.icon;
        const isActive = currentStage === stage;

        return (
          <div key={stage} className="flex items-center">
            {i > 0 && (
              <div
                className={cn(
                  "h-px w-8 transition-colors",
                  stageStatus[STAGES[i - 1]] === "complete"
                    ? "bg-emerald-500/50"
                    : "bg-border"
                )}
              />
            )}
            <Tooltip>
              <TooltipTrigger>
                <div
                  className={cn(
                    "relative flex h-9 w-9 items-center justify-center rounded-full ring-2 transition-all",
                    style.ring,
                    isActive && "ring-offset-2 ring-offset-background"
                  )}
                >
                  <div
                    className={cn(
                      "flex h-7 w-7 items-center justify-center rounded-full",
                      status === "complete"
                        ? "bg-emerald-500/15"
                        : status === "running"
                          ? "bg-amber-500/15"
                          : status === "review"
                            ? "bg-blue-500/15"
                            : status === "failed"
                              ? "bg-red-500/15"
                              : "bg-muted"
                    )}
                  >
                    <Icon
                      className={cn(
                        "h-3.5 w-3.5",
                        status === "complete" && "text-emerald-500",
                        status === "running" && "text-amber-500 animate-spin",
                        status === "review" && "text-blue-500",
                        status === "failed" && "text-red-500",
                        status === "pending" && "text-muted-foreground/50"
                      )}
                    />
                  </div>
                </div>
              </TooltipTrigger>
              <TooltipContent>
                <p className="text-xs font-medium">{STAGE_META[stage].label}</p>
                <p className="text-[10px] text-muted-foreground capitalize">{status}</p>
              </TooltipContent>
            </Tooltip>
          </div>
        );
      })}
    </div>
  );
};
