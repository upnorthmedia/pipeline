"use client";

import { useEffect, useState, useCallback } from "react";
import {
  Activity,
  Play,
  Pause,
  Clock,
  CheckCircle2,
  AlertCircle,
  RefreshCw,
  Zap,
  Inbox,
  XCircle,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Skeleton } from "@/components/ui/skeleton";
import { Separator } from "@/components/ui/separator";
import { queue, type QueueStatus } from "@/lib/api";
import { useSSE, type SSEEvent } from "@/hooks/use-sse";
import { cn } from "@/lib/utils";
import { toast } from "sonner";

const EVENT_COLORS: Record<string, string> = {
  stage_start: "bg-blue-500/15 text-blue-400",
  stage_complete: "bg-emerald-500/15 text-emerald-400",
  stage_error: "bg-red-500/15 text-red-400",
  review_needed: "bg-violet-500/15 text-violet-400",
  pipeline_complete: "bg-emerald-500/15 text-emerald-400",
};

function StatCard({
  label,
  value,
  icon: Icon,
  color,
}: {
  label: string;
  value: number;
  icon: React.ComponentType<{ className?: string }>;
  color: string;
}) {
  return (
    <Card>
      <CardContent className="p-4">
        <div className="flex items-center justify-between">
          <div>
            <p className="text-xs font-medium text-muted-foreground uppercase tracking-wider">
              {label}
            </p>
            <p className={cn("text-3xl font-bold mt-1", color)}>{value}</p>
          </div>
          <Icon className={cn("h-8 w-8", color, "opacity-50")} />
        </div>
      </CardContent>
    </Card>
  );
}

function StatsSkeleton() {
  return (
    <div className="grid grid-cols-2 lg:grid-cols-4 gap-4">
      {Array.from({ length: 4 }).map((_, i) => (
        <Card key={i}>
          <CardContent className="p-4">
            <div className="flex items-center justify-between">
              <div className="space-y-2">
                <Skeleton className="h-3 w-20" />
                <Skeleton className="h-8 w-12" />
              </div>
              <Skeleton className="h-8 w-8 rounded" />
            </div>
          </CardContent>
        </Card>
      ))}
    </div>
  );
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

export default function MonitorPage() {
  const [stats, setStats] = useState<QueueStatus | null>(null);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [events, setEvents] = useState<(SSEEvent & { timestamp: string })[]>(
    []
  );

  const fetchStats = useCallback(async () => {
    try {
      const data = await queue.status();
      setStats(data);
    } catch {
      toast.error("Failed to load queue status");
    } finally {
      setLoading(false);
    }
  }, []);

  useSSE(undefined, (event) => {
    setEvents((prev) => [
      { ...event, timestamp: new Date().toISOString() },
      ...prev.slice(0, 19),
    ]);
    fetchStats();
  });

  useEffect(() => {
    fetchStats();
  }, [fetchStats]);

  useEffect(() => {
    const interval = setInterval(fetchStats, 10000);
    return () => clearInterval(interval);
  }, [fetchStats]);

  const handleRefresh = async () => {
    setRefreshing(true);
    await fetchStats();
    setRefreshing(false);
  };

  const handlePauseAll = async () => {
    try {
      const result = await queue.pauseAll();
      toast.success(`Paused ${result.count} jobs`);
      fetchStats();
    } catch {
      toast.error("Failed to pause jobs");
    }
  };

  const handleResumeAll = async () => {
    try {
      const result = await queue.resumeAll();
      toast.success(`Resumed ${result.count} jobs`);
      fetchStats();
    } catch {
      toast.error("Failed to resume jobs");
    }
  };

  return (
    <div className="p-6 space-y-6">
      {/* Header */}
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-semibold tracking-tight">
            Queue Monitor
          </h1>
          <p className="text-sm text-muted-foreground mt-1">
            Auto-refreshes every 10 seconds
          </p>
        </div>
        <Button
          variant="outline"
          size="icon"
          onClick={handleRefresh}
          disabled={refreshing}
        >
          <RefreshCw
            className={cn("h-4 w-4", refreshing && "animate-spin")}
          />
        </Button>
      </div>

      {/* Stats Row */}
      {loading ? (
        <StatsSkeleton />
      ) : stats ? (
        <div className="grid grid-cols-2 lg:grid-cols-4 gap-4">
          <StatCard
            label="Running"
            value={stats.running}
            icon={Activity}
            color="text-amber-500"
          />
          <StatCard
            label="Pending"
            value={stats.pending}
            icon={Clock}
            color="text-blue-500"
          />
          <StatCard
            label="Awaiting Review"
            value={stats.review}
            icon={Inbox}
            color="text-violet-500"
          />
          <StatCard
            label="Completed"
            value={stats.complete}
            icon={CheckCircle2}
            color="text-green-500"
          />
        </div>
      ) : null}

      {/* Controls */}
      <Card>
        <CardHeader>
          <CardTitle className="text-base">Queue Controls</CardTitle>
        </CardHeader>
        <CardContent>
          <div className="flex flex-wrap items-center gap-4">
            <Button variant="outline" onClick={handlePauseAll}>
              <Pause className="h-4 w-4 mr-2" />
              Pause All
            </Button>
            <Button variant="outline" onClick={handleResumeAll}>
              <Play className="h-4 w-4 mr-2" />
              Resume All
            </Button>
            <Separator orientation="vertical" className="h-8" />
            <div className="flex items-center gap-2 text-sm text-muted-foreground">
              <Pause className="h-4 w-4" />
              <span>
                Paused:{" "}
                <span className="font-medium text-foreground">
                  {stats?.paused ?? 0}
                </span>
              </span>
            </div>
            <div className="flex items-center gap-2 text-sm text-muted-foreground">
              <XCircle className="h-4 w-4 text-red-500" />
              <span>
                Failed:{" "}
                <span className="font-medium text-red-500">
                  {stats?.failed ?? 0}
                </span>
              </span>
            </div>
          </div>
        </CardContent>
      </Card>

      {/* Recent Activity Feed */}
      <Card>
        <CardHeader>
          <div className="flex items-center justify-between">
            <CardTitle className="text-base flex items-center gap-2">
              <Zap className="h-4 w-4" />
              Recent Activity
            </CardTitle>
            <Badge variant="outline" className="text-xs">
              {events.length} events
            </Badge>
          </div>
        </CardHeader>
        <CardContent>
          {events.length === 0 ? (
            <div className="flex flex-col items-center justify-center py-12 text-center">
              <AlertCircle className="h-8 w-8 text-muted-foreground/50 mb-3" />
              <p className="text-sm text-muted-foreground">
                No recent activity
              </p>
              <p className="text-xs text-muted-foreground mt-1">
                Events will appear here as the pipeline runs
              </p>
            </div>
          ) : (
            <div className="space-y-2">
              {events.map((ev, i) => (
                <div
                  key={`${ev.timestamp}-${i}`}
                  className="flex items-center gap-3 rounded-md border border-border px-3 py-2 text-sm"
                >
                  <span className="text-xs text-muted-foreground font-mono shrink-0">
                    {formatTimestamp(ev.timestamp)}
                  </span>
                  {ev.post_id && (
                    <span className="text-xs font-mono text-muted-foreground shrink-0">
                      {truncateId(ev.post_id)}
                    </span>
                  )}
                  <Badge
                    variant="secondary"
                    className={cn(
                      "text-[11px] shrink-0",
                      EVENT_COLORS[ev.event] ?? "bg-muted text-muted-foreground"
                    )}
                  >
                    {ev.event}
                  </Badge>
                  {ev.stage && (
                    <span className="text-xs text-muted-foreground">
                      {ev.stage}
                    </span>
                  )}
                  {ev.error && (
                    <span className="text-xs text-red-400 truncate ml-auto">
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
