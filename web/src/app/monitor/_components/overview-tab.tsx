"use client";

import { useEffect, useState, useCallback } from "react";
import {
  Activity,
  Play,
  Pause,
  Clock,
  AlertCircle,
  RefreshCw,
  Zap,
  XCircle,
  TrendingUp,
  FileText,
  Timer,
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
import {
  queue,
  analytics,
  type QueueStatus,
  type DashboardStats,
} from "@/lib/api";
import { useSSE, type SSEEvent } from "@/hooks/use-sse";
import { cn } from "@/lib/utils";
import { toast } from "sonner";

const EVENT_COLORS: Record<string, string> = {
  stage_start: "bg-blue-500/15 text-blue-400",
  stage_complete: "bg-emerald-500/15 text-emerald-400",
  stage_error: "bg-red-500/15 text-red-400",
  pipeline_complete: "bg-emerald-500/15 text-emerald-400",
};

const statusChartConfig = {
  count: { label: "Posts" },
  pending: { label: "Pending", color: "hsl(210, 70%, 55%)" },
  research: { label: "Research", color: "hsl(200, 65%, 50%)" },
  outline: { label: "Outline", color: "hsl(270, 55%, 55%)" },
  write: { label: "Write", color: "hsl(35, 85%, 55%)" },
  edit: { label: "Edit", color: "hsl(45, 90%, 50%)" },
  images: { label: "Images", color: "hsl(330, 60%, 55%)" },
  ready: { label: "Ready", color: "hsl(160, 60%, 45%)" },
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

export function OverviewTab() {
  const [stats, setStats] = useState<QueueStatus | null>(null);
  const [dashboard, setDashboard] = useState<DashboardStats | null>(null);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [events, setEvents] = useState<(SSEEvent & { timestamp: string })[]>([]);

  const fetchData = useCallback(async () => {
    try {
      const [queueData, dashData] = await Promise.all([
        queue.status(),
        analytics.dashboard(),
      ]);
      setStats(queueData);
      setDashboard(dashData);
    } catch {
      toast.error("Failed to load overview data");
    } finally {
      setLoading(false);
    }
  }, []);

  useSSE(undefined, (event) => {
    setEvents((prev) => [
      { ...event, timestamp: new Date().toISOString() },
      ...prev.slice(0, 19),
    ]);
    fetchData();
  });

  useEffect(() => {
    fetchData();
  }, [fetchData]);

  useEffect(() => {
    const interval = setInterval(fetchData, 10000);
    return () => clearInterval(interval);
  }, [fetchData]);

  const handleRefresh = async () => {
    setRefreshing(true);
    await fetchData();
    setRefreshing(false);
  };

  const handlePauseAll = async () => {
    try {
      const result = await queue.pauseAll();
      toast.success(`Paused ${result.count} jobs`);
      fetchData();
    } catch {
      toast.error("Failed to pause jobs");
    }
  };

  const handleResumeAll = async () => {
    try {
      const result = await queue.resumeAll();
      toast.success(`Resumed ${result.count} jobs`);
      fetchData();
    } catch {
      toast.error("Failed to resume jobs");
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

  return (
    <div className="space-y-6">
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
        {/* Posts by Status */}
        <Card>
          <CardHeader className="pb-2">
            <CardTitle className="text-sm font-medium">Posts by Status</CardTitle>
            <CardDescription className="text-xs">
              Distribution across pipeline stages
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
            >
              <RefreshCw className={cn("h-3.5 w-3.5", refreshing && "animate-spin")} />
            </Button>
          </div>
        </CardHeader>
        <CardContent>
          <div className="flex flex-wrap items-center gap-4">
            <Button variant="outline" size="sm" onClick={handlePauseAll}>
              <Pause className="h-3.5 w-3.5 mr-1.5" />
              Pause All
            </Button>
            <Button variant="outline" size="sm" onClick={handleResumeAll}>
              <Play className="h-3.5 w-3.5 mr-1.5" />
              Resume All
            </Button>
            <Separator orientation="vertical" className="h-6" />
            <div className="flex items-center gap-4 text-xs text-muted-foreground">
              <span className="flex items-center gap-1.5">
                <Activity className="h-3.5 w-3.5 text-amber-500" />
                Running: <span className="font-medium text-foreground">{stats?.running ?? 0}</span>
              </span>
              <span className="flex items-center gap-1.5">
                <Clock className="h-3.5 w-3.5 text-blue-500" />
                Pending: <span className="font-medium text-foreground">{stats?.pending ?? 0}</span>
              </span>
              <span className="flex items-center gap-1.5">
                <Pause className="h-3.5 w-3.5" />
                Paused: <span className="font-medium text-foreground">{stats?.paused ?? 0}</span>
              </span>
              <span className="flex items-center gap-1.5">
                <XCircle className="h-3.5 w-3.5 text-red-500" />
                Failed: <span className="font-medium text-red-500">{stats?.failed ?? 0}</span>
              </span>
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
