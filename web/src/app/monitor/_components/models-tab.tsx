"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import { RefreshCw, Cpu, Plus } from "lucide-react";
import { Bar, BarChart, CartesianGrid, XAxis, YAxis } from "recharts";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Skeleton } from "@/components/ui/skeleton";
import {
  ChartContainer,
  ChartTooltip,
  ChartTooltipContent,
  type ChartConfig,
} from "@/components/ui/chart";
import { analytics, apiErrorMessage, type ModelAnalytics } from "@/lib/api";
import { cn } from "@/lib/utils";
import { TabError, TabEmpty } from "./tab-states";

// Named per model rather than per provider: ledger item 6.1 moved Anthropic and
// Gemini onto new models, so runs recorded before and after the change sit in
// the same table and both have to stay selectable.
const MODEL_FILTERS = [
  { label: "All Models", value: "" },
  { label: "Perplexity sonar-pro", value: "sonar-pro" },
  { label: "Claude Opus 5", value: "claude-opus-5" },
  { label: "Claude Opus 4.6", value: "claude-opus-4-6" },
  { label: "Gemini 3 Pro Image", value: "gemini-3-pro-image" },
  { label: "Gemini 3.1 Flash Image", value: "gemini-3.1-flash-image-preview" },
] as const;

const durationChartConfig = {
  avg_duration_s: { label: "Avg Duration (s)", color: "hsl(35, 85%, 55%)" },
} satisfies ChartConfig;

function formatTokens(value: number): string {
  if (value >= 1_000_000) return `${(value / 1_000_000).toFixed(1)}M`;
  if (value >= 1_000) return `${(value / 1_000).toFixed(1)}K`;
  return String(Math.round(value));
}

function formatCost(value: number): string {
  if (value === 0) return "$0.00";
  if (value < 0.01) return `$${value.toFixed(4)}`;
  return `$${value.toFixed(2)}`;
}

function formatDuration(seconds: number): string {
  if (seconds < 1) return `${Math.round(seconds * 1000)}ms`;
  if (seconds < 60) return `${seconds.toFixed(1)}s`;
  return `${Math.round(seconds / 60)}m ${Math.round(seconds % 60)}s`;
}

export function ModelsTab() {
  const [data, setData] = useState<ModelAnalytics | null>(null);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [modelFilter, setModelFilter] = useState("");
  const [error, setError] = useState<string | null>(null);

  const fetchData = async (m: string) => {
    try {
      const result = await analytics.models({ model: m || undefined });
      setData(result);
      setError(null);
    } catch (err) {
      setData(null);
      setError(apiErrorMessage(err, "Could not load model analytics."));
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    setLoading(true);
    fetchData(modelFilter);
  }, [modelFilter]);

  const handleRefresh = async () => {
    setRefreshing(true);
    await fetchData(modelFilter);
    setRefreshing(false);
  };

  const stageDurationData = data?.stage_performance.map((s) => ({
    stage: s.stage.charAt(0).toUpperCase() + s.stage.slice(1),
    avg_duration_s: s.avg_duration_s,
    runs: s.runs,
  })) ?? [];

  const activeModelLabel =
    MODEL_FILTERS.find((m) => m.value === modelFilter)?.label ?? modelFilter;

  if (loading) {
    return (
      <div className="space-y-6">
        <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
          {Array.from({ length: 3 }).map((_, i) => (
            <Card key={i}>
              <CardContent className="p-5">
                <Skeleton className="h-4 w-32 mb-3" />
                <Skeleton className="h-20 w-full" />
              </CardContent>
            </Card>
          ))}
        </div>
      </div>
    );
  }

  const controls = (
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-1 rounded-lg bg-muted/50 p-0.5">
          {MODEL_FILTERS.map((mf) => (
            <button
              key={mf.value}
              onClick={() => setModelFilter(mf.value)}
              className={cn(
                "px-3 py-1 text-xs font-medium rounded-md transition-colors",
                modelFilter === mf.value
                  ? "bg-background text-foreground shadow-sm"
                  : "text-muted-foreground hover:text-foreground"
              )}
            >
              {mf.label}
            </button>
          ))}
        </div>
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
  );

  if (error) {
    return (
      <div className="space-y-6">
        {controls}
        <TabError
          title="Could not load model analytics"
          message={error}
          retryLabel="Retry models"
          onRetry={() => {
            setLoading(true);
            fetchData(modelFilter);
          }}
        />
      </div>
    );
  }

  return (
    <div className="space-y-6">
      {controls}

      {/* Model Cards */}
      {data?.models && data.models.length > 0 ? (
        <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-4">
          {data.models.map((model) => (
            <Card key={model.model}>
              <CardContent className="p-5">
                <div className="flex items-start justify-between mb-4">
                  <div>
                    <p className="text-sm font-medium leading-none">{model.model}</p>
                    <p className="text-xs text-muted-foreground mt-1">
                      {model.call_count} calls
                    </p>
                  </div>
                  <div className="h-9 w-9 rounded-lg bg-muted/50 flex items-center justify-center shrink-0">
                    <Cpu className="h-4 w-4 text-muted-foreground" />
                  </div>
                </div>

                <div className="grid grid-cols-2 gap-3">
                  <div className="space-y-0.5">
                    <p className="text-[10px] font-medium text-muted-foreground uppercase tracking-wider">
                      Avg Tokens In
                    </p>
                    <p className="text-sm font-semibold tabular-nums">
                      {formatTokens(model.avg_tokens_in)}
                    </p>
                  </div>
                  <div className="space-y-0.5">
                    <p className="text-[10px] font-medium text-muted-foreground uppercase tracking-wider">
                      Avg Tokens Out
                    </p>
                    <p className="text-sm font-semibold tabular-nums">
                      {formatTokens(model.avg_tokens_out)}
                    </p>
                  </div>
                  <div className="space-y-0.5">
                    <p className="text-[10px] font-medium text-muted-foreground uppercase tracking-wider">
                      Avg Duration
                    </p>
                    <p className="text-sm font-semibold tabular-nums">
                      {formatDuration(model.avg_duration_s)}
                    </p>
                  </div>
                  <div className="space-y-0.5">
                    <p className="text-[10px] font-medium text-muted-foreground uppercase tracking-wider">
                      Total Cost
                    </p>
                    <p className="text-sm font-semibold tabular-nums">
                      {formatCost(model.total_cost)}
                    </p>
                  </div>
                </div>
              </CardContent>
            </Card>
          ))}
        </div>
      ) : modelFilter ? (
        <TabEmpty
          icon={Cpu}
          title={`No calls recorded for ${activeModelLabel}`}
          description="Another model may have served these stages. Clear the filter to see every model this account has billed."
        >
          <Button
            variant="outline"
            size="sm"
            onClick={() => setModelFilter("")}
            aria-label="Clear model filter"
          >
            Clear filter
          </Button>
        </TabEmpty>
      ) : (
        <TabEmpty
          icon={Cpu}
          title="No model data yet"
          description="Token counts, durations and per-model cost appear here once a pipeline run has called a provider."
        >
          <Button asChild variant="outline" size="sm">
            <Link href="/posts/new">
              <Plus className="h-3.5 w-3.5 mr-1.5" />
              New post
            </Link>
          </Button>
        </TabEmpty>
      )}

      {/* Stage Duration Chart */}
      {stageDurationData.length > 0 && (
        <Card>
          <CardHeader className="pb-2">
            <CardTitle className="text-sm font-medium">Stage Duration</CardTitle>
            <CardDescription className="text-xs">
              Average execution time per stage
            </CardDescription>
          </CardHeader>
          <CardContent>
            <ChartContainer config={durationChartConfig} className="h-[220px] w-full">
              <BarChart data={stageDurationData} margin={{ top: 8 }}>
                <CartesianGrid vertical={false} strokeDasharray="3 3" className="stroke-border/30" />
                <XAxis
                  dataKey="stage"
                  tickLine={false}
                  axisLine={false}
                  className="text-xs"
                />
                <YAxis
                  tickLine={false}
                  axisLine={false}
                  width={40}
                  tickFormatter={(v) => `${v}s`}
                  className="text-xs"
                />
                <ChartTooltip
                  content={
                    <ChartTooltipContent
                      formatter={(value) => `${Number(value).toFixed(1)}s`}
                    />
                  }
                />
                <Bar dataKey="avg_duration_s" fill="var(--color-avg_duration_s)" radius={[4, 4, 0, 0]} />
              </BarChart>
            </ChartContainer>
          </CardContent>
        </Card>
      )}

      {/* Stage Success Rates Table */}
      {data?.stage_success_rates && data.stage_success_rates.some((s) => s.total > 0) && (
        <Card>
          <CardHeader className="pb-2">
            <CardTitle className="text-sm font-medium">Stage Success Rates</CardTitle>
            <CardDescription className="text-xs">
              Completion vs failure rates per stage
            </CardDescription>
          </CardHeader>
          <CardContent>
            <div className="overflow-x-auto">
              <table className="w-full text-sm">
                <thead>
                  <tr className="border-b border-border/50">
                    <th className="text-left text-[11px] font-medium text-muted-foreground uppercase tracking-wider py-2 pr-4">
                      Stage
                    </th>
                    <th className="text-right text-[11px] font-medium text-muted-foreground uppercase tracking-wider py-2 px-4">
                      Total
                    </th>
                    <th className="text-right text-[11px] font-medium text-muted-foreground uppercase tracking-wider py-2 px-4">
                      Complete
                    </th>
                    <th className="text-right text-[11px] font-medium text-muted-foreground uppercase tracking-wider py-2 px-4">
                      Failed
                    </th>
                    <th className="text-right text-[11px] font-medium text-muted-foreground uppercase tracking-wider py-2 pl-4">
                      Success Rate
                    </th>
                  </tr>
                </thead>
                <tbody>
                  {data.stage_success_rates.map((stage) => (
                    <tr key={stage.stage} className="border-b border-border/30 last:border-0">
                      <td className="py-2.5 pr-4 font-medium capitalize">
                        {stage.stage}
                      </td>
                      <td className="py-2.5 px-4 text-right tabular-nums text-muted-foreground">
                        {stage.total}
                      </td>
                      <td className="py-2.5 px-4 text-right tabular-nums text-emerald-500">
                        {stage.complete}
                      </td>
                      <td className="py-2.5 px-4 text-right tabular-nums text-red-500">
                        {stage.failed}
                      </td>
                      <td className="py-2.5 pl-4 text-right">
                        <Badge
                          variant="secondary"
                          className={cn(
                            "text-[10px] font-mono px-1.5 py-0",
                            stage.success_rate >= 90
                              ? "bg-emerald-500/10 text-emerald-500"
                              : stage.success_rate >= 70
                                ? "bg-amber-500/10 text-amber-500"
                                : stage.total === 0
                                  ? "bg-muted text-muted-foreground"
                                  : "bg-red-500/10 text-red-500"
                          )}
                        >
                          {stage.total === 0 ? "--" : `${stage.success_rate}%`}
                        </Badge>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </CardContent>
        </Card>
      )}
    </div>
  );
}
