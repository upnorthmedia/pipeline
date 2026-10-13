"use client";

import { useEffect, useRef, useState, useCallback } from "react";
import {
  Activity,
  Play,
  Pause,
  CircleDashed,
  Eye,
  AlertCircle,
  RefreshCw,
  TriangleAlert,
  Zap,
  XCircle,
  Plus,
  TrendingUp,
  FileText,
  Timer,
  type LucideIcon,
} from "lucide-react";
import { Area, AreaChart, Bar, BarChart, CartesianGrid, XAxis, YAxis } from "recharts";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Skeleton } from "@/components/ui/skeleton";
import { Separator } from "@/components/ui/separator";
import {
  ChartContainer,
  ChartTooltip,
  ChartTooltipContent,
  type ChartConfig,
} from "@/components/ui/chart";
import Link from "next/link";
import {
  queue,
  analytics,
  apiErrorMessage,
  type QueueStatus,
  type DashboardStats,
  type StalledPublish,
} from "@/lib/api";
import { STAGE_LABELS } from "@/lib/stages";
import { PAUSABLE_RUN_STATES, type RunStateKind } from "@/lib/run-state";
import { useSSE, type SSEEvent } from "@/hooks/use-sse";
import { cn } from "@/lib/utils";
import { toast } from "sonner";
import { TabError, TabEmpty, StaleBanner } from "./tab-states";

/**
 * The feed frames that can change something this tab renders.
 *
 * `GET /api/analytics/dashboard` groups the caller's posts over
 * `current_stage` and reads `completed_at` and `created_at`, and the counts in
 * `GET /api/queue` come off `current_stage` and `stage_status`. Only these
 * frames accompany a write to one of those. The rest of the feed cannot: `log`
 * is a stage's own progress line, and `image_generated` and `image_failed` are
 * two frames per manifest entry from inside the `images` stage.
 *
 * The three `publish_*` frames are here because `GET /api/queue` also reports
 * the publishes that have stopped moving (ledger item P4.9b), and each of
 * those frames accompanies a write to the status column that derivation reads.
 * They cannot make a stall appear, which happens with no event at all and is
 * what the 10s interval below is for, but they are how one leaves.
 *
 * The feed used to refetch on all of them, so one running post turned an open
 * monitor page into dozens of aggregate queries. Everything still reaches the
 * activity list below; this set only decides what costs a round trip.
 */
const AGGREGATE_EVENTS = new Set([
  "stage_start",
  "stage_complete",
  "stage_error",
  "pipeline_complete",
  // A pause writes `current_stage` and starts nothing, so this frame is the
  // only one that accompanies it. Both aggregates group over that column.
  "run_paused",
  "publish_start",
  "publish_complete",
  "publish_error",
]);

/**
 * How long a scheduled refetch waits for more frames before it runs.
 *
 * Frames arrive in bursts: a stage's completion and the next one's start are
 * milliseconds apart, and several posts run at once. One trailing window turns
 * a burst into one request. It stays well under the 10s interval beside it, so
 * the numbers still move while a run is watched.
 */
const AGGREGATE_REFETCH_DELAY_MS = 500;

/**
 * The Queue Controls strip, in the vocabulary the posts list uses.
 *
 * `GET /api/queue` answers one count per `RunStateKind`, so each line here is
 * a sum over the kinds it covers and its label is the word `deriveRunState()`
 * puts on a single row's badge. The strip used to read the `current_stage`
 * column instead, which is where `Running: 11` came from on an account whose
 * posts list called two of those rows "Not started" and one "Failed at
 * Research".
 *
 * `running` and `in_progress` share a line because the difference between them
 * is about the record (a stage recorded as running, versus a row caught
 * between two of them), not about what the reader is waiting for. Finished
 * with errors is the only line that hides at zero: it is a complaint, where
 * the five above it are the standing shape of the queue.
 */
const QUEUE_LINES: {
  label: string;
  kinds: RunStateKind[];
  icon: LucideIcon;
  iconClass?: string;
  valueClass?: string;
  hideAtZero?: boolean;
}[] = [
  {
    label: "Running",
    kinds: ["running", "in_progress"],
    icon: Activity,
    iconClass: "text-amber-500",
  },
  { label: "Waiting for you", kinds: ["review"], icon: Eye, iconClass: "text-blue-500" },
  { label: "Not started", kinds: ["not_started"], icon: CircleDashed },
  { label: "Paused", kinds: ["paused"], icon: Pause },
  {
    label: "Failed",
    kinds: ["failed"],
    icon: XCircle,
    iconClass: "text-red-500",
    valueClass: "text-red-500",
  },
  {
    label: "Finished with errors",
    kinds: ["finished_with_errors"],
    icon: TriangleAlert,
    iconClass: "text-amber-500",
    valueClass: "text-amber-500",
    hideAtZero: true,
  },
];

const EVENT_COLORS: Record<string, string> = {
  stage_start: "bg-blue-500/15 text-blue-400",
  stage_complete: "bg-emerald-500/15 text-emerald-400",
  stage_error: "bg-red-500/15 text-red-400",
  pipeline_complete: "bg-emerald-500/15 text-emerald-400",
};

const statusChartConfig = {
  count: { label: "Posts" },
  pending: { label: "Pending", color: "hsl(210, 70%, 55%)" },
  research: { label: STAGE_LABELS.research, color: "hsl(200, 65%, 50%)" },
  outline: { label: STAGE_LABELS.outline, color: "hsl(270, 55%, 55%)" },
  write: { label: STAGE_LABELS.write, color: "hsl(35, 85%, 55%)" },
  edit: { label: STAGE_LABELS.edit, color: "hsl(45, 90%, 50%)" },
  images: { label: STAGE_LABELS.images, color: "hsl(330, 60%, 55%)" },
  ready: { label: STAGE_LABELS.ready, color: "hsl(160, 60%, 45%)" },
  complete: { label: "Complete", color: "hsl(145, 65%, 42%)" },
  failed: { label: "Failed", color: "hsl(0, 70%, 55%)" },
  paused: { label: "Paused", color: "hsl(220, 10%, 55%)" },
} satisfies ChartConfig;

const overTimeConfig = {
  count: { label: "Posts", color: "hsl(160, 60%, 45%)" },
} satisfies ChartConfig;

const profileConfig = {
  count: { label: "Posts", color: "hsl(210, 70%, 55%)" },
} satisfies ChartConfig;

function formatDuration(seconds: number | null): string {
  if (!seconds) return "--";
  if (seconds < 60) return `${Math.round(seconds)}s`;
  if (seconds < 3600) return `${Math.round(seconds / 60)}m`;
  const h = Math.floor(seconds / 3600);
  const m = Math.round((seconds % 3600) / 60);
  return `${h}h ${m}m`;
}

function formatTimestamp(iso: string): string {
  const d = new Date(iso);
  return d.toLocaleTimeString([], {
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
  });
}

function truncateId(id: string): string {
  return id.length > 8 ? `${id.slice(0, 8)}...` : id;
}

/**
 * The publishes that have stopped moving, ledger item P4.9b.
 *
 * It sits above the numbers because it is the one thing on this tab that is
 * asking for a person: a run that finished and a publish after it that died
 * are two facts about one row, and everything below is about the first of them.
 * The completion rate answers this card rather than contradicting it since
 * ledger item P5.2, by counting these rows under `publish_incomplete` instead
 * of calling them clean finishes. Outside the `hasPosts` branch, since a dead
 * publish belongs to a run that is already over.
 *
 * The words are the server's, from the same `publishStall()` the posts list
 * and the post page ask of a row they hold. The retry lives on the post, so
 * the row here is a link to it rather than a second copy of the action.
 */
function StalledPublishes({ posts }: { posts: StalledPublish[] }) {
  if (posts.length === 0) return null;
  return (
    <Card role="alert" className="border-amber-500/40 bg-amber-500/5">
      <CardHeader className="pb-3">
        <CardTitle className="text-sm font-medium flex items-center gap-2">
          <AlertCircle className="h-4 w-4 text-amber-500" />
          Publishing stopped responding on {posts.length}{" "}
          {posts.length === 1 ? "post" : "posts"}
        </CardTitle>
        <CardDescription className="text-xs">
          Nothing will move these on their own. Open one to see the reason and try again.
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-2">
        {posts.map((post) => (
          <div
            key={post.id}
            className="flex flex-wrap items-baseline gap-x-2 gap-y-0.5 rounded-md border border-border/50 px-3 py-2"
          >
            <Link
              href={`/posts/${post.id}`}
              className="text-sm font-medium hover:underline"
            >
              {post.topic}
            </Link>
            <span className="text-xs text-muted-foreground">{post.label}</span>
            <span className="w-full text-xs text-muted-foreground">{post.short}</span>
          </div>
        ))}
      </CardContent>
    </Card>
  );
}

export function OverviewTab() {
  const [stats, setStats] = useState<QueueStatus | null>(null);
  const [dashboard, setDashboard] = useState<DashboardStats | null>(null);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [events, setEvents] = useState<(SSEEvent & { timestamp: string })[]>([]);

  const fetchData = useCallback(async () => {
    try {
      const [queueData, dashData] = await Promise.all([
        queue.status(),
        analytics.dashboard(),
      ]);
      setStats(queueData);
      setDashboard(dashData);
      setError(null);
    } catch (err) {
      // This runs on a 10s interval and after a run's stage frames, so a toast per
      // failure would be a toast every ten seconds for as long as the backend
      // is down. The state is what the render reads instead.
      setError(apiErrorMessage(err, "Could not load overview data."));
    } finally {
      setLoading(false);
    }
  }, []);

  // Held in a ref rather than state: a pending window must not re-render the
  // page, and the cleanup below has to be able to cancel it on unmount.
  const refetchTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const scheduleRefetch = useCallback(() => {
    if (refetchTimer.current) return;
    refetchTimer.current = setTimeout(() => {
      refetchTimer.current = null;
      fetchData();
    }, AGGREGATE_REFETCH_DELAY_MS);
  }, [fetchData]);

  useSSE(undefined, (event) => {
    setEvents((prev) => [
      { ...event, timestamp: new Date().toISOString() },
      ...prev.slice(0, 19),
    ]);
    if (AGGREGATE_EVENTS.has(event.event)) scheduleRefetch();
  });

  useEffect(() => {
    fetchData();
  }, [fetchData]);

  useEffect(
    () => () => {
      if (refetchTimer.current) clearTimeout(refetchTimer.current);
    },
    []
  );

  useEffect(() => {
    const interval = setInterval(fetchData, 10000);
    return () => clearInterval(interval);
  }, [fetchData]);

  const handleRefresh = async () => {
    setRefreshing(true);
    await fetchData();
    setRefreshing(false);
  };

  const hasPosts = (dashboard?.total ?? 0) > 0;

  // What each button would act on, counted out of the same buckets the strip
  // beside them prints, so the control and the number agree. `null` means the
  // counts have not loaded (or failed to), and neither button is disabled on a
  // number nobody has.
  const pausableCount = stats
    ? PAUSABLE_RUN_STATES.reduce((sum, kind) => sum + (stats[kind] ?? 0), 0)
    : null;
  const resumableCount = stats?.paused ?? null;

  const handlePauseAll = async () => {
    try {
      const result = await queue.pauseAll();
      toast.success(
        result.count === 1 ? "Paused 1 run" : `Paused ${result.count} runs`
      );
      fetchData();
    } catch {
      toast.error("Could not pause the runs");
    }
  };

  const handleResumeAll = async () => {
    try {
      const result = await queue.resumeAll();
      toast.success(
        result.count === 1 ? "Resumed 1 run" : `Resumed ${result.count} runs`
      );
      fetchData();
    } catch {
      toast.error("Could not resume the runs");
    }
  };

  // Prepare status chart data
  const statusData = dashboard
    ? Object.entries(dashboard.by_status)
        .map(([status, count]) => ({
          status,
          count,
          fill: `var(--color-${status})`,
        }))
        .sort((a, b) => b.count - a.count)
    : [];

  if (loading) {
    return (
      <div className="space-y-6">
        <div className="grid grid-cols-2 lg:grid-cols-4 gap-4">
          {Array.from({ length: 4 }).map((_, i) => (
            <Card key={i}>
              <CardContent className="p-4">
                <Skeleton className="h-3 w-20 mb-2" />
                <Skeleton className="h-8 w-16" />
              </CardContent>
            </Card>
          ))}
        </div>
        <div className="grid grid-cols-1 lg:grid-cols-2 gap-4">
          <Card>
            <CardContent className="p-6">
              <Skeleton className="h-48 w-full" />
            </CardContent>
          </Card>
          <Card>
            <CardContent className="p-6">
              <Skeleton className="h-48 w-full" />
            </CardContent>
          </Card>
        </div>
      </div>
    );
  }

  // Only a first load with nothing to show takes over the tab. Once there are
  // numbers on screen a later failure keeps them and says they are stale.
  if (error && !dashboard) {
    return (
      <TabError
        title="Could not load the overview"
        message={error}
        retryLabel="Retry overview"
        onRetry={handleRefresh}
      />
    );
  }

  return (
    <div className="space-y-6">
      {error && <StaleBanner message={error} />}

      <StalledPublishes posts={stats?.publish_stalled ?? []} />

      {!hasPosts ? (
        <TabEmpty
          icon={FileText}
          title="No posts yet"
          description="Counts, completion rate and the status charts fill in once the pipeline has a post to run."
        >
          <Button asChild variant="outline" size="sm">
            <Link href="/posts/new">
              <Plus className="h-3.5 w-3.5 mr-1.5" />
              New post
            </Link>
          </Button>
        </TabEmpty>
      ) : (
        <>
        {/* Stat Cards */}
        <div className="grid grid-cols-2 lg:grid-cols-4 gap-4">
          <Card>
            <CardContent className="p-4">
              <div className="flex items-center justify-between">
                <div>
                  <p className="text-[11px] font-medium text-muted-foreground uppercase tracking-wider">
                    Total Posts
                  </p>
                  <p className="text-3xl font-bold mt-1 tracking-tight">
                    {dashboard?.total ?? 0}
                  </p>
                </div>
                <div className="h-10 w-10 rounded-lg bg-muted/50 flex items-center justify-center">
                  <FileText className="h-5 w-5 text-muted-foreground" />
                </div>
              </div>
            </CardContent>
          </Card>

          <Card>
            <CardContent className="p-4">
              <div className="flex items-center justify-between">
                <div>
                  <p className="text-[11px] font-medium text-muted-foreground uppercase tracking-wider">
                    Completion Rate
                  </p>
                  <p className="text-3xl font-bold mt-1 tracking-tight text-emerald-500">
                    {dashboard?.completion_rate ?? 0}%
                  </p>
                  {/*
                    The two counts, because the percentage alone cannot be
                    checked against anything else on the screen. `complete` is
                    the runs `deriveRunState()` calls Complete, the same rule
                    the strip below uses, which is fewer than the rows the
                    chart draws under "Complete" whenever one of them finished
                    with a failed stage.
                  */}
                  <p className="text-[11px] text-muted-foreground mt-1">
                    {dashboard?.complete ?? 0} of {dashboard?.total ?? 0} runs finished cleanly
                  </p>
                  {/*
                    The runs that reached the end and then failed to publish,
                    named rather than quietly missing from the count above
                    (ledger item P5.2). The stalled ones are the card at the top
                    of this tab, which is where the post and the retry are; the
                    rest failed outright and say so on the post itself.
                  */}
                  {(dashboard?.publish_incomplete ?? 0) > 0 && (
                    <p className="text-[11px] text-amber-500 mt-0.5">
                      {dashboard?.publish_incomplete} more finished but never published
                    </p>
                  )}
                </div>
                <div className="h-10 w-10 rounded-lg bg-emerald-500/10 flex items-center justify-center">
                  <TrendingUp className="h-5 w-5 text-emerald-500" />
                </div>
              </div>
            </CardContent>
          </Card>

          <Card>
            <CardContent className="p-4">
              <div className="flex items-center justify-between">
                <div>
                  <p className="text-[11px] font-medium text-muted-foreground uppercase tracking-wider">
                    Avg Duration
                  </p>
                  <p className="text-3xl font-bold mt-1 tracking-tight">
                    {formatDuration(dashboard?.avg_duration_s ?? null)}
                  </p>
                </div>
                <div className="h-10 w-10 rounded-lg bg-muted/50 flex items-center justify-center">
                  <Timer className="h-5 w-5 text-muted-foreground" />
                </div>
              </div>
            </CardContent>
          </Card>

          <Card>
            <CardContent className="p-4">
              <div className="flex items-center justify-between">
                <div>
                  <p className="text-[11px] font-medium text-muted-foreground uppercase tracking-wider">
                    Posts Today
                  </p>
                  <p className="text-3xl font-bold mt-1 tracking-tight text-blue-500">
                    {dashboard?.posts_today ?? 0}
                  </p>
                </div>
                <div className="h-10 w-10 rounded-lg bg-blue-500/10 flex items-center justify-center">
                  <Zap className="h-5 w-5 text-blue-500" />
                </div>
              </div>
            </CardContent>
          </Card>
        </div>

        {/* Charts Row */}
        <div className="grid grid-cols-1 lg:grid-cols-2 gap-4">
          {/* Posts by Stage */}
          <Card>
            <CardHeader className="pb-2">
              <CardTitle className="text-sm font-medium">Posts by Stage</CardTitle>
              <CardDescription className="text-xs">
                Where each post&apos;s row sits in the pipeline, not what its run is doing
              </CardDescription>
            </CardHeader>
            <CardContent>
              {statusData.length > 0 ? (
                <ChartContainer config={statusChartConfig} className="h-[220px] w-full">
                  <BarChart data={statusData} layout="vertical" margin={{ left: 10 }}>
                    <YAxis
                      dataKey="status"
                      type="category"
                      tickLine={false}
                      axisLine={false}
                      width={70}
                      tickFormatter={(v) => statusChartConfig[v as keyof typeof statusChartConfig]?.label ?? v}
                      className="text-xs"
                    />
                    <XAxis type="number" hide />
                    <ChartTooltip content={<ChartTooltipContent hideLabel />} />
                    <Bar dataKey="count" radius={[0, 4, 4, 0]} />
                  </BarChart>
                </ChartContainer>
              ) : (
                <div className="flex items-center justify-center h-[220px] text-sm text-muted-foreground">
                  No data yet
                </div>
              )}
            </CardContent>
          </Card>

          {/* Posts Over Time */}
          <Card>
            <CardHeader className="pb-2">
              <CardTitle className="text-sm font-medium">Posts Over Time</CardTitle>
              <CardDescription className="text-xs">
                New posts created per day (last 30 days)
              </CardDescription>
            </CardHeader>
            <CardContent>
              {dashboard?.over_time && dashboard.over_time.length > 0 ? (
                <ChartContainer config={overTimeConfig} className="h-[220px] w-full">
                  <AreaChart data={dashboard.over_time} margin={{ top: 8, right: 8, bottom: 0, left: 0 }}>
                    <defs>
                      <linearGradient id="fillPosts" x1="0" y1="0" x2="0" y2="1">
                        <stop offset="5%" stopColor="var(--color-count)" stopOpacity={0.3} />
                        <stop offset="95%" stopColor="var(--color-count)" stopOpacity={0} />
                      </linearGradient>
                    </defs>
                    <CartesianGrid vertical={false} strokeDasharray="3 3" className="stroke-border/30" />
                    <XAxis
                      dataKey="date"
                      tickLine={false}
                      axisLine={false}
                      tickFormatter={(v) => new Date(v).toLocaleDateString(undefined, { month: "short", day: "numeric" })}
                      className="text-xs"
                    />
                    <YAxis tickLine={false} axisLine={false} width={30} className="text-xs" />
                    <ChartTooltip content={<ChartTooltipContent />} />
                    <Area
                      dataKey="count"
                      type="monotone"
                      fill="url(#fillPosts)"
                      stroke="var(--color-count)"
                      strokeWidth={2}
                    />
                  </AreaChart>
                </ChartContainer>
              ) : (
                <div className="flex items-center justify-center h-[220px] text-sm text-muted-foreground">
                  No data yet
                </div>
              )}
            </CardContent>
          </Card>
        </div>

        {/* Posts by Profile */}
        {dashboard?.by_profile && dashboard.by_profile.length > 0 && (
          <Card>
            <CardHeader className="pb-2">
              <CardTitle className="text-sm font-medium">Posts by Profile</CardTitle>
              <CardDescription className="text-xs">
                Top profiles by post count
              </CardDescription>
            </CardHeader>
            <CardContent>
              <ChartContainer config={profileConfig} className="h-[200px] w-full">
                <BarChart data={dashboard.by_profile} layout="vertical" margin={{ left: 10 }}>
                  <YAxis
                    dataKey="name"
                    type="category"
                    tickLine={false}
                    axisLine={false}
                    width={120}
                    className="text-xs"
                  />
                  <XAxis type="number" hide />
                  <ChartTooltip content={<ChartTooltipContent />} />
                  <Bar dataKey="count" fill="var(--color-count)" radius={[0, 4, 4, 0]} />
                </BarChart>
              </ChartContainer>
            </CardContent>
          </Card>
        )}

        </>
      )}

      {/* Queue Controls */}
      <Card>
        <CardHeader className="pb-3">
          <div className="flex items-center justify-between">
            <CardTitle className="text-sm font-medium">Queue Controls</CardTitle>
            <Button
              variant="ghost"
              size="icon"
              className="h-7 w-7"
              onClick={handleRefresh}
              disabled={refreshing}
              aria-label="Refresh overview"
            >
              <RefreshCw className={cn("h-3.5 w-3.5", refreshing && "animate-spin")} />
            </Button>
          </div>
        </CardHeader>
        <CardContent>
          <div className="flex flex-wrap items-center gap-4">
            <Button
              variant="outline"
              size="sm"
              onClick={handlePauseAll}
              disabled={pausableCount === 0}
              title={
                pausableCount === 0
                  ? "Nothing to pause. Runs waiting for you and runs that failed are left as they are."
                  : "Stops every run that is going, in front of its next stage. Runs waiting for you and runs that failed are left as they are."
              }
            >
              <Pause className="h-3.5 w-3.5 mr-1.5" />
              Pause All
              {pausableCount !== null && pausableCount > 0 ? ` (${pausableCount})` : ""}
            </Button>
            <Button
              variant="outline"
              size="sm"
              onClick={handleResumeAll}
              disabled={resumableCount === 0}
              title={
                resumableCount === 0
                  ? "Nothing is paused."
                  : "Starts every paused run again, from the stage it stopped at. A run that was paused after its last stage runs its finish instead."
              }
            >
              <Play className="h-3.5 w-3.5 mr-1.5" />
              Resume All
              {resumableCount !== null && resumableCount > 0 ? ` (${resumableCount})` : ""}
            </Button>
            <Separator orientation="vertical" className="h-6" />
            <div className="flex flex-wrap items-center gap-x-4 gap-y-2 text-xs text-muted-foreground">
              {QUEUE_LINES.map(({ label, kinds, icon: Icon, iconClass, valueClass, hideAtZero }) => {
                const value = kinds.reduce((sum, kind) => sum + (stats?.[kind] ?? 0), 0);
                if (hideAtZero && value === 0) return null;
                return (
                  <span key={label} className="flex items-center gap-1.5">
                    <Icon className={cn("h-3.5 w-3.5", iconClass)} />
                    {label}:{" "}
                    <span className={cn("font-medium", valueClass ?? "text-foreground")}>
                      {value}
                    </span>
                  </span>
                );
              })}
            </div>
          </div>
        </CardContent>
      </Card>

      {/* Recent Activity Feed */}
      <Card>
        <CardHeader className="pb-3">
          <div className="flex items-center justify-between">
            <CardTitle className="text-sm font-medium flex items-center gap-2">
              <Zap className="h-3.5 w-3.5" />
              Recent Activity
            </CardTitle>
            <Badge variant="outline" className="text-[10px] font-mono">
              {events.length} events
            </Badge>
          </div>
        </CardHeader>
        <CardContent>
          {events.length === 0 ? (
            <div className="flex flex-col items-center justify-center py-10 text-center">
              <AlertCircle className="h-7 w-7 text-muted-foreground/40 mb-2" />
              <p className="text-sm text-muted-foreground">No recent activity</p>
              <p className="text-xs text-muted-foreground/60 mt-0.5">
                Events will appear here as the pipeline runs
              </p>
            </div>
          ) : (
            <div className="space-y-1.5">
              {events.map((ev, i) => (
                <div
                  key={`${ev.timestamp}-${i}`}
                  className="flex items-center gap-3 rounded-md border border-border/50 px-3 py-2 text-sm hover:bg-muted/30 transition-colors"
                >
                  <span className="text-[10px] text-muted-foreground font-mono shrink-0 tabular-nums">
                    {formatTimestamp(ev.timestamp)}
                  </span>
                  {ev.post_id && (
                    <span className="text-[10px] font-mono text-muted-foreground/70 shrink-0">
                      {truncateId(ev.post_id)}
                    </span>
                  )}
                  <Badge
                    variant="secondary"
                    className={cn(
                      "text-[10px] shrink-0 px-1.5 py-0",
                      EVENT_COLORS[ev.event] ?? "bg-muted text-muted-foreground"
                    )}
                  >
                    {ev.event}
                  </Badge>
                  {ev.stage && (
                    <span className="text-xs text-muted-foreground">{ev.stage}</span>
                  )}
                  {ev.error && (
                    <span className="text-xs text-red-400 truncate ml-auto max-w-[200px]">
                      {ev.error}
                    </span>
                  )}
                </div>
              ))}
            </div>
          )}
        </CardContent>
      </Card>
    </div>
  );
}
