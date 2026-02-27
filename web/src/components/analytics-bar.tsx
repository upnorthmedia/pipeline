"use client";

import type { PostAnalytics } from "@/lib/api";
import { cn } from "@/lib/utils";

interface AnalyticsBarProps {
  analytics: PostAnalytics;
  targetWordCount?: number;
  className?: string;
}

function ratingColor(ok: boolean) {
  return ok ? "text-emerald-400" : "text-amber-400";
}

function dotColor(ok: boolean) {
  return ok ? "bg-emerald-500" : "bg-red-500";
}

export function AnalyticsBar({
  analytics,
  targetWordCount = 2000,
  className,
}: AnalyticsBarProps) {
  const wordCountOk =
    analytics.word_count >= targetWordCount * 0.9 &&
    analytics.word_count <= targetWordCount * 1.1;
  const fleschOk =
    analytics.flesch_reading_ease >= 60 &&
    analytics.flesch_reading_ease <= 70;
  const sentenceOk = analytics.avg_sentence_length < 20;

  return (
    <div className={cn("space-y-4", className)} data-testid="analytics-bar">
      <div className="grid grid-cols-2 gap-4 sm:grid-cols-4">
        <Stat
          label="Words"
          value={analytics.word_count.toLocaleString()}
          target={targetWordCount.toLocaleString()}
          ok={wordCountOk}
        />
        <Stat
          label="Flesch Score"
          value={analytics.flesch_reading_ease.toFixed(1)}
          target="60-70"
          ok={fleschOk}
        />
        <Stat
          label="Sentences"
          value={String(analytics.sentence_count)}
        />
        <Stat
          label="Avg Sentence"
          value={`${analytics.avg_sentence_length.toFixed(1)} words`}
          target="< 20"
          ok={sentenceOk}
        />
      </div>
    </div>
  );
}

function Stat({
  label,
  value,
  target,
  ok,
}: {
  label: string;
  value: string;
  target?: string;
  ok?: boolean;
}) {
  return (
    <div>
      <p className="text-xs text-muted-foreground">{label}</p>
      <p
        className={cn(
          "text-lg font-semibold tabular-nums",
          ok !== undefined && ratingColor(ok)
        )}
      >
        {value}
      </p>
      {target && (
        <p className="text-[10px] font-mono text-muted-foreground/60">
          target: {target}
        </p>
      )}
    </div>
  );
}

interface SeoChecklistProps {
  checklist: Record<string, boolean>;
  className?: string;
}

export function SeoChecklist({ checklist, className }: SeoChecklistProps) {
  if (!checklist || Object.keys(checklist).length === 0) return null;

  const passed = Object.values(checklist).filter(Boolean).length;
  const total = Object.keys(checklist).length;

  return (
    <div className={cn("space-y-2", className)} data-testid="seo-checklist">
      <div className="flex items-center justify-between">
        <h4 className="text-xs font-medium text-muted-foreground uppercase tracking-wider">
          SEO Checklist
        </h4>
        <span className="text-xs text-muted-foreground font-mono">
          {passed}/{total}
        </span>
      </div>
      <div className="grid grid-cols-1 gap-1.5 sm:grid-cols-2">
        {Object.entries(checklist).map(([check, ok]) => (
          <div key={check} className="flex items-center gap-2 text-xs">
            <div className={cn("h-1.5 w-1.5 rounded-full shrink-0", dotColor(ok))} />
            <span className={ok ? "text-muted-foreground" : "text-muted-foreground/70"}>
              {formatCheckLabel(check)}
            </span>
          </div>
        ))}
      </div>
    </div>
  );
}

interface KeywordDensityProps {
  density: Record<string, number>;
  className?: string;
}

export function KeywordDensity({ density, className }: KeywordDensityProps) {
  if (!density || Object.keys(density).length === 0) return null;

  return (
    <div className={cn("space-y-2", className)} data-testid="keyword-density">
      <h4 className="text-xs font-medium text-muted-foreground uppercase tracking-wider">
        Keyword Density
      </h4>
      <div className="flex flex-wrap gap-2">
        {Object.entries(density).map(([kw, pct]) => {
          const ok = pct >= 1 && pct <= 2;
          return (
            <span
              key={kw}
              className={cn(
                "inline-flex items-center rounded-md px-2 py-0.5 text-xs font-mono",
                ok
                  ? "bg-emerald-500/10 text-emerald-400 ring-1 ring-emerald-500/20"
                  : pct < 1
                    ? "bg-amber-500/10 text-amber-400 ring-1 ring-amber-500/20"
                    : "bg-red-500/10 text-red-400 ring-1 ring-red-500/20"
              )}
            >
              {kw}: {pct.toFixed(1)}%
            </span>
          );
        })}
      </div>
    </div>
  );
}

function formatCheckLabel(key: string): string {
  return key
    .replace(/_/g, " ")
    .replace(/\b\w/g, (c) => c.toUpperCase())
    .replace(/\bOk\b/, "OK")
    .replace(/\bH1\b/, "H1")
    .replace(/\bH2\b/, "H2");
}
