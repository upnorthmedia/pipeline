"use client";

/**
 * The run trace: one row per pipeline step, with what it cost and how long it
 * took, live while the run is executing in the `worker` service.
 *
 * The numbers are Mastra's own usage accounting. Each step reads `usage` off
 * the agent's answer and `announceStageComplete()` writes the model, the token
 * counts, the measured duration and the cost onto the post row (a per-token
 * estimate, or the provider's own price where it reports one);
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
  Images,
  Loader2,
  PauseCircle,
  RotateCw,
} from "lucide-react";

import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
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
import {
  buildRunTrace,
  type ImageProgress,
  type LiveImage,
  type PublishTrace,
  type StageTrace,
  type TraceStatus,
} from "@/lib/run-trace";
import { PUBLISH_TARGET_LABELS, type PublishTarget } from "@/lib/publishing";
import { STAGE_LABELS, STAGE_STATUS_LABELS } from "@/lib/stages";

/**
 * The icon and colour for each status. The names come from
 * `STAGE_STATUS_LABELS` rather than being repeated here: the progress bar
 * above this table shows the same statuses, and two copies of the words is how
 * the stage names ended up disagreeing.
 */
const STATUS_META: Record<
  TraceStatus,
  { label: string; icon: React.ComponentType<{ className?: string }>; className: string }
> = {
  pending: { label: STAGE_STATUS_LABELS.pending, icon: Circle, className: "text-muted-foreground/60" },
  running: { label: STAGE_STATUS_LABELS.running, icon: Loader2, className: "text-amber-500" },
  review: { label: STAGE_STATUS_LABELS.review, icon: PauseCircle, className: "text-sky-500" },
  complete: { label: STAGE_STATUS_LABELS.complete, icon: CheckCircle2, className: "text-emerald-500" },
  failed: { label: STAGE_STATUS_LABELS.failed, icon: AlertCircle, className: "text-red-500" },
};

/** `12.5` -> `12.5s`, `95.2` -> `1m 35s`. Durations here run from under a second to minutes. */
function formatDuration(seconds: number): string {
  if (seconds < 60) return `${seconds.toFixed(1)}s`;
  const minutes = Math.floor(seconds / 60);
  return `${minutes}m ${Math.round(seconds - minutes * 60)}s`;
}

/**
 * Priced by the pipeline at the model each stage reported, or at what the
 * provider said the call cost where it reports one (see `stageCostUsd`), so
 * sub-cent stages are common and `$0.00` would tell an operator nothing.
 * Four decimal places until a run is worth more than a cent.
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

/**
 * The fan-out's count in words: `images` is the only stage where "running"
 * hides how much is done and "complete" can hide that some of it failed.
 *
 * Both halves are counted rather than only the failures, because a run that
 * generated four of five images and a run that generated none read the same
 * without the successes beside them.
 */
function imageProgressText({ generated, failed }: ImageProgress): string {
  const made = `${generated} ${generated === 1 ? "image" : "images"} generated`;
  if (failed === 0) return made;
  if (generated === 0) return `${failed} ${failed === 1 ? "image" : "images"} failed`;
  return `${made}, ${failed} failed`;
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

function StageRow({
  row,
  now,
  onApprove,
}: {
  row: StageTrace;
  now: number;
  onApprove?: () => void;
}) {
  const running = row.status === "running";
  const elapsed = running ? elapsedSeconds(row.startedAt, now) : null;
  // A gate is the one status on this table that is waiting on the reader
  // rather than on a machine, so it is the one that gets a control.
  const waiting = row.status === "review" && onApprove !== undefined;
  // A gate the run has already been let through. The wait is reported only
  // once it is over: while the run is parked the status column and the release
  // control below already say so, and an elapsed clock for it would freeze,
  // since the ticker on this card runs only while something is executing.
  const waited = row.review?.waitedS ?? null;
  const hasDetail =
    row.retries.length > 0 ||
    row.error !== null ||
    row.images !== null ||
    waited !== null ||
    waiting;

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
              {row.images !== null && (
                <p
                  className={cn(
                    "flex items-start gap-1.5 text-xs",
                    row.images.failed > 0 ? "text-amber-600 dark:text-amber-500" : "text-muted-foreground"
                  )}
                >
                  <Images className="mt-0.5 h-3 w-3 shrink-0" />
                  <span>{imageProgressText(row.images)}</span>
                </p>
              )}
              {waited !== null && (
                <p className="flex items-start gap-1.5 text-xs text-sky-600 dark:text-sky-500">
                  <PauseCircle className="mt-0.5 h-3 w-3 shrink-0" />
                  <span>Waited {formatDuration(waited)} for review before this step ran.</span>
                </p>
              )}
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
              {waiting && (
                <div className="flex items-center gap-2 pt-1">
                  <span className="text-xs text-muted-foreground">
                    Nothing runs until you release this stage.
                  </span>
                  <Button size="sm" variant="outline" className="h-7" onClick={onApprove}>
                    <CheckCircle2 className="mr-1.5 h-3 w-3" />
                    Approve {STAGE_LABELS[row.stage]}
                  </Button>
                </div>
              )}
            </div>
          </TableCell>
        </TableRow>
      )}
    </>
  );
}

/**
 * The publish leg, on the same table as the stages because it is part of the
 * same account: a user watching a run wants to know it reached its
 * destination, and a publish is the step most likely to fail on something
 * outside this app.
 *
 * It carries no model, tokens or cost, and those cells say so rather than
 * being left blank, for the same reason a stage that has not run does: an
 * empty cell reads as a value that failed to load.
 */
function PublishRow({ row, now }: { row: PublishTrace; now: number }) {
  const elapsed = row.status === "running" ? elapsedSeconds(row.startedAt, now) : null;

  return (
    <>
      <TableRow className={cn(row.error !== null && "border-b-0")}>
        <TableCell className="font-medium">
          Publish to {PUBLISH_TARGET_LABELS[row.target]}
        </TableCell>
        <TableCell>
          <StatusCell status={row.status} />
        </TableCell>
        <TableCell className="font-mono text-xs text-muted-foreground">
          <span aria-hidden>&mdash;</span>
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
          <span aria-hidden>&mdash;</span>
        </TableCell>
        <TableCell className="text-right font-mono text-xs tabular-nums">
          <span aria-hidden>&mdash;</span>
        </TableCell>
      </TableRow>
      {row.error !== null && (
        <TableRow className="hover:bg-transparent">
          <TableCell colSpan={6} className="pt-0">
            <p className="flex items-start gap-1.5 pl-1 text-xs text-red-500">
              <AlertCircle className="mt-0.5 h-3 w-3 shrink-0" />
              <span className="break-all">{row.error}</span>
            </p>
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
  liveImages,
  publish,
  onApprove,
}: {
  executionLogs: readonly unknown[];
  stageStatus: StageStatusMap;
  /** The stage of the latest `stage_start` SSE frame, so the clock starts before the refetch. */
  liveStart?: { stage: PipelineStage; at: string } | null;
  /**
   * The per-image frames seen since the `images` stage started. The fan-out
   * publishes one per manifest entry and nothing refetches the row until the
   * stage ends, so without these the count only appears once it is over.
   */
  liveImages?: readonly LiveImage[];
  /**
   * The destination this post's `output_format` names and its status column,
   * or nothing for a format that publishes nowhere. The post page owns that
   * decision: the format is on the row it already holds.
   */
  publish?: { target: PublishTarget; status: string } | null;
  /**
   * Release the gate a stage is parked at. Omitted where nothing can act on
   * it, which is what keeps the button out of a read-only trace: a stage row
   * with no handler shows the status and no control.
   */
  onApprove?: (stage: PipelineStage) => void;
}) {
  const trace = buildRunTrace({
    entries: executionLogs,
    stageStatus,
    liveStart,
    liveImages,
    publish,
  });
  const running =
    trace.stages.some((row) => row.status === "running") || trace.publish?.status === "running";

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

  // A publish that has not been queued yet is not a run: a post whose format
  // names WordPress carries `pending` from the moment it is created.
  const started =
    trace.stages.some((row) => row.status !== "pending") ||
    (trace.publish !== null && trace.publish.status !== "pending");

  return (
    <Card className="gap-0 py-0">
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
          <div className="flex items-center gap-2" role="group" aria-label="Run totals">
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
                <StageRow
                  key={row.stage}
                  row={row}
                  now={now}
                  onApprove={onApprove ? () => onApprove(row.stage) : undefined}
                />
              ))}
              {trace.publish !== null && <PublishRow row={trace.publish} now={now} />}
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
