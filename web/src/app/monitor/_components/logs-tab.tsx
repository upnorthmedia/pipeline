"use client";

import { useEffect, useState, useCallback } from "react";
import {
  Search,
  ChevronLeft,
  ChevronRight,
  RefreshCw,
  FileText,
  ChevronDown,
  ChevronUp,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Input } from "@/components/ui/input";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Skeleton } from "@/components/ui/skeleton";
import {
  analytics,
  profiles as profilesApi,
  STAGES,
  type PaginatedLogs,
  type LogEntry,
  type Profile,
} from "@/lib/api";
import { cn } from "@/lib/utils";
import { toast } from "sonner";
import Link from "next/link";

const LEVEL_COLORS: Record<string, string> = {
  info: "bg-blue-500/10 text-blue-500",
  warning: "bg-amber-500/10 text-amber-500",
  error: "bg-red-500/10 text-red-500",
};

const TIME_PRESETS = [
  { label: "1h", hours: 1 },
  { label: "24h", hours: 24 },
  { label: "7d", hours: 24 * 7 },
  { label: "30d", hours: 24 * 30 },
] as const;

function formatTimestamp(iso: string): string {
  const d = new Date(iso);
  return d.toLocaleString(undefined, {
    month: "short",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
  });
}

export function LogsTab() {
  const [data, setData] = useState<PaginatedLogs | null>(null);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [profileList, setProfileList] = useState<Profile[]>([]);
  const [expandedRow, setExpandedRow] = useState<number | null>(null);

  // Filters
  const [level, setLevel] = useState<string>("");
  const [stage, setStage] = useState<string>("");
  const [profileId, setProfileId] = useState<string>("");
  const [searchQuery, setSearchQuery] = useState<string>("");
  const [timePreset, setTimePreset] = useState<number>(24 * 7);
  const [page, setPage] = useState(1);

  const fetchLogs = useCallback(async () => {
    try {
      const since = new Date(Date.now() - timePreset * 60 * 60 * 1000).toISOString();
      const result = await analytics.logs({
        level: level || undefined,
        stage: stage || undefined,
        profile_id: profileId || undefined,
        q: searchQuery || undefined,
        since,
        page,
        per_page: 50,
      });
      setData(result);
    } catch {
      toast.error("Failed to load logs");
    } finally {
      setLoading(false);
    }
  }, [level, stage, profileId, searchQuery, timePreset, page]);

  useEffect(() => {
    profilesApi.list().then(setProfileList).catch(() => {});
  }, []);

  useEffect(() => {
    setLoading(true);
    fetchLogs();
  }, [fetchLogs]);

  const handleRefresh = async () => {
    setRefreshing(true);
    await fetchLogs();
    setRefreshing(false);
  };

  const handleSearch = (e: React.FormEvent) => {
    e.preventDefault();
    setPage(1);
  };

  const resetFilters = () => {
    setLevel("");
    setStage("");
    setProfileId("");
    setSearchQuery("");
    setTimePreset(24 * 7);
    setPage(1);
  };

  const hasActiveFilters = level || stage || profileId || searchQuery;

  return (
    <div className="space-y-4">
      {/* Filter Bar */}
      <Card>
        <CardContent className="p-4">
          <div className="flex flex-wrap items-center gap-3">
            {/* Time Presets */}
            <div className="flex items-center gap-1 rounded-lg bg-muted/50 p-0.5">
              {TIME_PRESETS.map((preset) => (
                <button
                  key={preset.hours}
                  onClick={() => { setTimePreset(preset.hours); setPage(1); }}
                  className={cn(
                    "px-2.5 py-1 text-xs font-medium rounded-md transition-colors",
                    timePreset === preset.hours
                      ? "bg-background text-foreground shadow-sm"
                      : "text-muted-foreground hover:text-foreground"
                  )}
                >
                  {preset.label}
                </button>
              ))}
            </div>

            {/* Level Filter */}
            <Select value={level} onValueChange={(v) => { setLevel(v === "all" ? "" : v); setPage(1); }}>
              <SelectTrigger className="w-[100px] h-8 text-xs">
                <SelectValue placeholder="Level" />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="all">All levels</SelectItem>
                <SelectItem value="info">Info</SelectItem>
                <SelectItem value="warning">Warning</SelectItem>
                <SelectItem value="error">Error</SelectItem>
              </SelectContent>
            </Select>

            {/* Stage Filter */}
            <Select value={stage} onValueChange={(v) => { setStage(v === "all" ? "" : v); setPage(1); }}>
              <SelectTrigger className="w-[110px] h-8 text-xs">
                <SelectValue placeholder="Stage" />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="all">All stages</SelectItem>
                {STAGES.map((s) => (
                  <SelectItem key={s} value={s}>
                    {s.charAt(0).toUpperCase() + s.slice(1)}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>

            {/* Profile Filter */}
            {profileList.length > 0 && (
              <Select value={profileId} onValueChange={(v) => { setProfileId(v === "all" ? "" : v); setPage(1); }}>
                <SelectTrigger className="w-[140px] h-8 text-xs">
                  <SelectValue placeholder="Profile" />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="all">All profiles</SelectItem>
                  {profileList.map((p) => (
                    <SelectItem key={p.id} value={p.id}>
                      {p.name}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            )}

            {/* Search */}
            <form onSubmit={handleSearch} className="flex items-center gap-1.5 flex-1 min-w-[180px]">
              <div className="relative flex-1">
                <Search className="absolute left-2.5 top-1/2 -translate-y-1/2 h-3.5 w-3.5 text-muted-foreground" />
                <Input
                  value={searchQuery}
                  onChange={(e) => setSearchQuery(e.target.value)}
                  placeholder="Search messages..."
                  className="h-8 pl-8 text-xs"
                />
              </div>
            </form>

            {/* Actions */}
            <div className="flex items-center gap-1.5">
              {hasActiveFilters && (
                <Button variant="ghost" size="sm" className="h-8 text-xs" onClick={resetFilters}>
                  Clear
                </Button>
              )}
              <Button
                variant="ghost"
                size="icon"
                className="h-8 w-8"
                onClick={handleRefresh}
                disabled={refreshing}
              >
                <RefreshCw className={cn("h-3.5 w-3.5", refreshing && "animate-spin")} />
              </Button>
            </div>
          </div>
        </CardContent>
      </Card>

      {/* Results */}
      <Card>
        <CardHeader className="pb-2">
          <div className="flex items-center justify-between">
            <CardTitle className="text-sm font-medium">
              {data ? `${data.total.toLocaleString()} log entries` : "Log Explorer"}
            </CardTitle>
            {data && data.pages > 1 && (
              <div className="flex items-center gap-2 text-xs text-muted-foreground">
                <span>
                  Page {data.page} of {data.pages}
                </span>
                <div className="flex items-center gap-1">
                  <Button
                    variant="ghost"
                    size="icon"
                    className="h-6 w-6"
                    disabled={page <= 1}
                    onClick={() => setPage((p) => Math.max(1, p - 1))}
                  >
                    <ChevronLeft className="h-3.5 w-3.5" />
                  </Button>
                  <Button
                    variant="ghost"
                    size="icon"
                    className="h-6 w-6"
                    disabled={page >= (data?.pages ?? 1)}
                    onClick={() => setPage((p) => p + 1)}
                  >
                    <ChevronRight className="h-3.5 w-3.5" />
                  </Button>
                </div>
              </div>
            )}
          </div>
        </CardHeader>
        <CardContent>
          {loading ? (
            <div className="space-y-2">
              {Array.from({ length: 8 }).map((_, i) => (
                <Skeleton key={i} className="h-10 w-full" />
              ))}
            </div>
          ) : !data || data.items.length === 0 ? (
            <div className="flex flex-col items-center justify-center py-12 text-center">
              <FileText className="h-8 w-8 text-muted-foreground/40 mb-2" />
              <p className="text-sm text-muted-foreground">No logs match your filters</p>
              <p className="text-xs text-muted-foreground/60 mt-0.5">
                Try adjusting the time range or clearing filters
              </p>
            </div>
          ) : (
            <div className="space-y-1">
              {data.items.map((entry, i) => (
                <LogRow
                  key={`${entry.post_id}-${entry.timestamp}-${i}`}
                  entry={entry}
                  expanded={expandedRow === i}
                  onToggle={() => setExpandedRow(expandedRow === i ? null : i)}
                />
              ))}
            </div>
          )}
        </CardContent>
      </Card>
    </div>
  );
}

function LogRow({
  entry,
  expanded,
  onToggle,
}: {
  entry: LogEntry;
  expanded: boolean;
  onToggle: () => void;
}) {
  const hasData = entry.data && Object.keys(entry.data).length > 0;

  return (
    <div className="group">
      <div
        className={cn(
          "flex items-center gap-3 rounded-md border border-border/40 px-3 py-2 text-sm transition-colors",
          hasData && "cursor-pointer hover:bg-muted/30",
          expanded && "bg-muted/20 border-border"
        )}
        onClick={hasData ? onToggle : undefined}
      >
        {/* Timestamp */}
        <span className="text-[10px] text-muted-foreground font-mono shrink-0 tabular-nums w-[130px]">
          {formatTimestamp(entry.timestamp)}
        </span>

        {/* Post link */}
        <Link
          href={`/posts/${entry.post_id}`}
          className="text-[11px] font-mono text-muted-foreground hover:text-foreground transition-colors shrink-0 max-w-[100px] truncate"
          onClick={(e) => e.stopPropagation()}
          title={entry.slug}
        >
          {entry.slug}
        </Link>

        {/* Stage */}
        {entry.stage && (
          <Badge variant="outline" className="text-[10px] px-1.5 py-0 shrink-0">
            {entry.stage}
          </Badge>
        )}

        {/* Level */}
        <Badge
          variant="secondary"
          className={cn(
            "text-[10px] px-1.5 py-0 shrink-0",
            LEVEL_COLORS[entry.level] ?? "bg-muted text-muted-foreground"
          )}
        >
          {entry.level}
        </Badge>

        {/* Event */}
        <span className="text-[10px] text-muted-foreground/70 shrink-0">
          {entry.event}
        </span>

        {/* Message */}
        <span className="text-xs text-muted-foreground truncate flex-1 min-w-0">
          {entry.message}
        </span>

        {/* Expand indicator */}
        {hasData && (
          <span className="shrink-0 text-muted-foreground/50">
            {expanded ? (
              <ChevronUp className="h-3.5 w-3.5" />
            ) : (
              <ChevronDown className="h-3.5 w-3.5" />
            )}
          </span>
        )}
      </div>

      {/* Expanded data */}
      {expanded && hasData && (
        <div className="ml-4 mr-2 mb-1 mt-0.5 rounded-md bg-muted/30 border border-border/30 p-3">
          <pre className="text-[11px] font-mono text-muted-foreground whitespace-pre-wrap break-all leading-relaxed">
            {JSON.stringify(entry.data, null, 2)}
          </pre>
        </div>
      )}
    </div>
  );
}
