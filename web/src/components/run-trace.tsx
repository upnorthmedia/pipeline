"use client";

/**
 * The run trace: one row per pipeline step, with what it cost and how long it
 * took, live while the run is executing in the `worker` service.
 *
 * The numbers are Mastra's own usage accounting. Each step reads `usage` off
 * the agent's answer and `announceStageComplete()` writes the model, the token
 * counts, the measured duration and the priced estimate onto the post row;
 * `buildRunTrace()` folds that column back into per-stage rows. See
 * `web/src/lib/run-trace.ts` for why the trace reads the row rather than
 * subscribing to Mastra's per-run stream directly.
 *
 * The one thing this component owns rather than reads is the elapsed clock for
 * the stage that is still running: a stage in flight has no duration yet, so
 * the time it has been running is counted here, from the `stage_start` the
 * trace carries, and re-rendered once a second.
 */

import { useEffect, useState } from "react";
import {
  Activity,
  AlertCircle,
  CheckCircle2,
  Circle,
  Loader2,
  PauseCircle,
  RotateCw,
} from "lucide-react";

import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { cn } from "@/lib/utils";
import type { PipelineStage, StageStatusMap } from "@/lib/api";
import { buildRunTrace, type StageTrace, type TraceStatus } from "@/lib/run-trace";

const STAGE_LABELS: Record<PipelineStage, string> = {
  research: "Research",
  outline: "Outline",
  write: "Write",
  edit: "Edit",
  images: "Images",
  ready: "Ready",
};

const STATUS_META: Record<
  TraceStatus,
  { label: string; icon: React.ComponentType<{ className?: string }>; className: string }
> = {
  pending: { label: "Pending", icon: Circle, className: "text-muted-foreground/60" },
  running: { label: "Running", icon: Loader2, className: "text-amber-500" },
  review: { label: "Awaiting review", icon: PauseCircle, className: "text-sky-500" },
  complete: { label: "Complete", icon: CheckCircle2, className: "text-emerald-500" },
  failed: { label: "Failed", icon: AlertCircle, className: "text-red-500" },
};

/** `12.5` -> `12.5s`, `95.2` -> `1m 35s`. Durations here run from under a second to minutes. */
function formatDuration(seconds: number): string {
  if (seconds < 60) return `${seconds.toFixed(1)}s`;
  const minutes = Math.floor(seconds / 60);
  return `${minutes}m ${Math.round(seconds - minutes * 60)}s`;
}

/**
 * Priced at Anthropic Opus rates for every stage, which is what the pipeline
 * stores, so sub-cent runs are common and `$0.00` would tell an operator
 * nothing. Four decimal places until a run is worth more than a cent.
 */
function formatCost(usd: number): string {
  if (usd === 0) return "$0";
  return usd < 0.01 ? `$${usd.toFixed(4)}` : `$${usd.toFixed(2)}`;
}

function formatTokens(count: number): string {
  return count.toLocaleString("en-US");
}

/** Seconds since `startedAt`, or `null` if it is missing or unparseable. */
function elapsedSeconds(startedAt: string | null, now: number): number | null {
  if (!startedAt) return null;
  const started = Date.parse(startedAt);
  if (Number.isNaN(started)) return null;
  return Math.max(0, (now - started) / 1000);
}

function StatusCell({ status }: { status: TraceStatus }) {
  const meta = STATUS_META[status];
  const Icon = meta.icon;
  return (
    <span className={cn("inline-flex items-center gap-1.5 text-xs", meta.className)}>
      <Icon className={cn("h-3.5 w-3.5 shrink-0", status === "running" && "animate-spin")} />
      {meta.label}
    </span>
  );
}

function StageRow({ row, now }: { row: StageTrace; now: number }) {
  const running = row.status === "running";
  const elapsed = running ? elapsedSeconds(row.startedAt, now) : null;
  const hasDetail = row.retries.length > 0 || row.error !== null;

  return (
    <>
      <TableRow className={cn(hasDetail && "border-b-0")}>
        <TableCell className="font-medium">{STAGE_LABELS[row.stage]}</TableCell>
        <TableCell>
          <StatusCell status={row.status} />
        </TableCell>
        <TableCell className="font-mono text-xs text-muted-foreground">
          {row.model ?? <span aria-hidden>&mdash;</span>}
        </TableCell>
        <TableCell className="text-right font-mono text-xs tabular-nums">
          {row.durationS !== null ? (
            formatDuration(row.durationS)
          ) : elapsed !== null ? (
            <span className="text-amber-500">{formatDuration(elapsed)}</span>
          ) : (
            <span aria-hidden>&mdash;</span>
          )}
        </TableCell>
        <TableCell className="text-right font-mono text-xs tabular-nums text-muted-foreground">
          {row.tokensIn === 0 && row.tokensOut === 0 ? (
            <span aria-hidden>&mdash;</span>
          ) : (
            `${formatTokens(row.tokensIn)} / ${formatTokens(row.tokensOut)}`
          )}
        </TableCell>
        <TableCell className="text-right font-mono text-xs tabular-nums">
          {row.costUsd === 0 ? <span aria-hidden>&mdash;</span> : formatCost(row.costUsd)}
        </TableCell>
      </TableRow>
      {hasDetail && (
        <TableRow className="hover:bg-transparent">
          <TableCell colSpan={6} className="pt-0">
            <div className="space-y-1 pl-1">
              {row.retries.map((retry) => (
                <p
                  key={retry.attempt}
                  className="flex items-start gap-1.5 text-xs text-yellow-600 dark:text-yellow-500"
                >
                  <RotateCw className="mt-0.5 h-3 w-3 shrink-0" />
                  <span>
                    Attempt {retry.attempt}
                    {retry.maxAttempts !== null ? ` of ${retry.maxAttempts}` : ""} failed
                    {retry.error ? `: ${retry.error}` : ""}
                  </span>
                </p>
              ))}
              {row.error !== null && (
                <p className="flex items-start gap-1.5 text-xs text-red-500">
                  <AlertCircle className="mt-0.5 h-3 w-3 shrink-0" />
                  <span className="break-all">{row.error}</span>
                </p>
              )}
            </div>
          </TableCell>
        </TableRow>
      )}
    </>
  );
}

export function RunTrace({
  executionLogs,
  stageStatus,
  liveStart,
}: {
  executionLogs: readonly unknown[];
  stageStatus: StageStatusMap;
  /** The stage of the latest `stage_start` SSE frame, so the clock starts before the refetch. */
  liveStart?: { stage: PipelineStage; at: string } | null;
}) {
  const trace = buildRunTrace({ entries: executionLogs, stageStatus, liveStart });
  const running = trace.stages.some((row) => row.status === "running");

  // One tick a second, and only while something is actually running: the
  // elapsed column is the only thing on this card that changes without an
  // event behind it. The clock is read in the interval callback rather than
  // during render or in the effect body, both of which the React compiler
  // rejects; the cost is that a run starting on a page that has been open a
  // while shows `0.0s` for its first second before the first tick corrects it.
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (!running) return;
    const timer = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(timer);
  }, [running]);

  const started = trace.stages.some((row) => row.status !== "pending");

  return (
    <Card>
      <CardHeader className="flex flex-row items-center justify-between gap-4 space-y-0 py-3">
        <div className="flex items-center gap-2">
          <Activity className="h-4 w-4 text-muted-foreground" />
          <CardTitle className="text-base">Run Trace</CardTitle>
          {running && (
            <span className="relative flex h-2 w-2" aria-label="Run in progress">
              <span className="absolute inline-flex h-full w-full animate-ping rounded-full bg-amber-400 opacity-75" />
              <span className="relative inline-flex h-2 w-2 rounded-full bg-amber-500" />
            </span>
          )}
        </div>
        {started && (
          <div className="flex items-center gap-2">
            <Badge variant="secondary" className="font-mono text-[10px]">
              {formatTokens(trace.totals.tokensIn + trace.totals.tokensOut)} tokens
            </Badge>
            <Badge variant="secondary" className="font-mono text-[10px]">
              {formatCost(trace.totals.costUsd)}
            </Badge>
            <Badge variant="secondary" className="font-mono text-[10px]">
              {formatDuration(trace.totals.durationS)}
            </Badge>
          </div>
        )}
      </CardHeader>
      <CardContent className="pt-0 pb-3">
        {!started ? (
          <p className="rounded border border-dashed border-border px-3 py-6 text-center text-sm text-muted-foreground">
            No run yet. Start the pipeline to see per-step status, timing, tokens and cost.
          </p>
        ) : (
          <Table>
            <TableHeader>
              <TableRow className="hover:bg-transparent">
                <TableHead>Step</TableHead>
                <TableHead>Status</TableHead>
                <TableHead>Model</TableHead>
                <TableHead className="text-right">Time</TableHead>
                <TableHead className="text-right">Tokens in / out</TableHead>
                <TableHead className="text-right">Cost</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {trace.stages.map((row) => (
                <StageRow key={row.stage} row={row} now={now} />
              ))}
            </TableBody>
          </Table>
        )}
        {trace.runError !== null && (
          <p className="mt-3 flex items-start gap-1.5 rounded border border-red-500/30 bg-red-500/5 px-3 py-2 text-xs text-red-500">
            <AlertCircle className="mt-0.5 h-3 w-3 shrink-0" />
            <span className="break-all">{trace.runError}</span>
          </p>
        )}
      </CardContent>
    </Card>
  );
}
