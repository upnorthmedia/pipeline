"use client";

import { useEffect, useState } from "react";
import {
  DollarSign,
  Coins,
  TrendingDown,
  RefreshCw,
  ArrowUpRight,
} from "lucide-react";
import {
  Bar,
  BarChart,
  CartesianGrid,
  Line,
  LineChart,
  XAxis,
  YAxis,
} from "recharts";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from "@/components/ui/card";
import { Skeleton } from "@/components/ui/skeleton";
import {
  ChartContainer,
  ChartTooltip,
  ChartTooltipContent,
  type ChartConfig,
} from "@/components/ui/chart";
import { analytics, type CostAnalytics } from "@/lib/api";
import { cn } from "@/lib/utils";
import { toast } from "sonner";

const TIME_RANGES = [
  { label: "7d", days: 7 },
  { label: "30d", days: 30 },
  { label: "90d", days: 90 },
  { label: "All", days: 365 },
] as const;

const MODEL_FILTERS = [
  { label: "All Models", value: "" },
  { label: "Perplexity", value: "sonar-pro" },
  { label: "Anthropic", value: "claude-opus-4-6" },
  { label: "Gemini", value: "gemini-3.1-flash-image-preview" },
] as const;

const modelChartConfig = {
  cost_usd: { label: "Cost ($)", color: "hsl(160, 60%, 45%)" },
} satisfies ChartConfig;

const stageChartConfig = {
  cost_usd: { label: "Cost ($)", color: "hsl(210, 70%, 55%)" },
} satisfies ChartConfig;

const timeChartConfig = {
  cost_usd: { label: "Cost ($)", color: "hsl(160, 60%, 45%)" },
} satisfies ChartConfig;

const profileCostConfig = {
  cost_usd: { label: "Cost ($)", color: "hsl(270, 55%, 55%)" },
} satisfies ChartConfig;

function formatCost(value: number): string {
  if (value === 0) return "$0.00";
  if (value < 0.01) return `$${value.toFixed(4)}`;
  return `$${value.toFixed(2)}`;
}

function formatTokens(value: number): string {
  if (value >= 1_000_000) return `${(value / 1_000_000).toFixed(1)}M`;
  if (value >= 1_000) return `${(value / 1_000).toFixed(1)}K`;
  return String(value);
}

export function CostsTab() {
  const [data, setData] = useState<CostAnalytics | null>(null);
  const [loading, setLoading] = useState(true);
  const [days, setDays] = useState(30);
  const [modelFilter, setModelFilter] = useState("");
  const [refreshing, setRefreshing] = useState(false);

  const fetchData = async (d: number, m: string) => {
    try {
      const result = await analytics.costs({ days: d, model: m || undefined });
      setData(result);
    } catch {
      toast.error("Failed to load cost analytics");
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    setLoading(true);
    fetchData(days, modelFilter);
  }, [days, modelFilter]);

  const handleRefresh = async () => {
    setRefreshing(true);
    await fetchData(days, modelFilter);
    setRefreshing(false);
  };

  // Prepare chart data
  const modelData = data
    ? Object.entries(data.by_model)
        .map(([model, info]) => ({
          model: model.replace(/-/g, " ").replace(/\b\w/g, (c) => c.toUpperCase()),
          cost_usd: info.cost_usd,
          calls: info.calls,
          tokens_in: info.tokens_in,
          tokens_out: info.tokens_out,
        }))
        .sort((a, b) => b.cost_usd - a.cost_usd)
    : [];

  const stageData = data
    ? Object.entries(data.by_stage)
        .map(([stage, info]) => ({
          stage: stage.charAt(0).toUpperCase() + stage.slice(1),
          cost_usd: info.cost_usd,
          calls: info.calls,
        }))
    : [];

  if (loading) {
    return (
      <div className="space-y-6">
        <div className="grid grid-cols-2 lg:grid-cols-4 gap-4">
          {Array.from({ length: 4 }).map((_, i) => (
            <Card key={i}>
              <CardContent className="p-4">
                <Skeleton className="h-3 w-20 mb-2" />
                <Skeleton className="h-8 w-24" />
              </CardContent>
            </Card>
          ))}
        </div>
        <Card>
          <CardContent className="p-6">
            <Skeleton className="h-64 w-full" />
          </CardContent>
        </Card>
      </div>
    );
  }

  return (
    <div className="space-y-6">
      {/* Time Range + Model Filter + Refresh */}
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-3">
          <div className="flex items-center gap-1 rounded-lg bg-muted/50 p-0.5">
            {TIME_RANGES.map((range) => (
              <button
                key={range.days}
                onClick={() => setDays(range.days)}
                className={cn(
                  "px-3 py-1 text-xs font-medium rounded-md transition-colors",
                  days === range.days
                    ? "bg-background text-foreground shadow-sm"
                    : "text-muted-foreground hover:text-foreground"
                )}
              >
                {range.label}
              </button>
            ))}
          </div>
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

      {/* Summary Cards */}
      <div className="grid grid-cols-2 lg:grid-cols-4 gap-4">
        <Card>
          <CardContent className="p-4">
            <div className="flex items-center justify-between">
              <div>
                <p className="text-[11px] font-medium text-muted-foreground uppercase tracking-wider">
                  Total Spend
                </p>
                <p className="text-2xl font-bold mt-1 tracking-tight">
                  {formatCost(data?.total_cost ?? 0)}
                </p>
              </div>
              <div className="h-10 w-10 rounded-lg bg-emerald-500/10 flex items-center justify-center">
                <DollarSign className="h-5 w-5 text-emerald-500" />
              </div>
            </div>
          </CardContent>
        </Card>

        <Card>
          <CardContent className="p-4">
            <div className="flex items-center justify-between">
              <div>
                <p className="text-[11px] font-medium text-muted-foreground uppercase tracking-wider">
                  Total Tokens
                </p>
                <p className="text-2xl font-bold mt-1 tracking-tight">
                  {formatTokens((data?.total_tokens_in ?? 0) + (data?.total_tokens_out ?? 0))}
                </p>
                <p className="text-[10px] text-muted-foreground mt-0.5">
                  {formatTokens(data?.total_tokens_in ?? 0)} in / {formatTokens(data?.total_tokens_out ?? 0)} out
                </p>
              </div>
              <div className="h-10 w-10 rounded-lg bg-blue-500/10 flex items-center justify-center">
                <Coins className="h-5 w-5 text-blue-500" />
              </div>
            </div>
          </CardContent>
        </Card>

        <Card>
          <CardContent className="p-4">
            <div className="flex items-center justify-between">
              <div>
                <p className="text-[11px] font-medium text-muted-foreground uppercase tracking-wider">
                  Avg Cost/Post
                </p>
                <p className="text-2xl font-bold mt-1 tracking-tight">
                  {formatCost(data?.avg_cost_per_post ?? 0)}
                </p>
              </div>
              <div className="h-10 w-10 rounded-lg bg-amber-500/10 flex items-center justify-center">
                <TrendingDown className="h-5 w-5 text-amber-500" />
              </div>
            </div>
          </CardContent>
        </Card>

        <Card>
          <CardContent className="p-4">
            <div className="flex items-center justify-between">
              <div>
                <p className="text-[11px] font-medium text-muted-foreground uppercase tracking-wider">
                  Models Used
                </p>
                <p className="text-2xl font-bold mt-1 tracking-tight">
                  {Object.keys(data?.by_model ?? {}).length}
                </p>
              </div>
              <div className="h-10 w-10 rounded-lg bg-muted/50 flex items-center justify-center">
                <ArrowUpRight className="h-5 w-5 text-muted-foreground" />
              </div>
            </div>
          </CardContent>
        </Card>
      </div>

      {/* Charts Row */}
      <div className="grid grid-cols-1 lg:grid-cols-2 gap-4">
        {/* Cost by Model */}
        <Card>
          <CardHeader className="pb-2">
            <CardTitle className="text-sm font-medium">Cost by Model</CardTitle>
            <CardDescription className="text-xs">
              Total spend per LLM provider
            </CardDescription>
          </CardHeader>
          <CardContent>
            {modelData.length > 0 ? (
              <ChartContainer config={modelChartConfig} className="h-[220px] w-full">
                <BarChart data={modelData} layout="vertical" margin={{ left: 10 }}>
                  <YAxis
                    dataKey="model"
                    type="category"
                    tickLine={false}
                    axisLine={false}
                    width={140}
                    className="text-xs"
                  />
                  <XAxis type="number" hide />
                  <ChartTooltip
                    content={
                      <ChartTooltipContent
                        formatter={(value) => formatCost(Number(value))}
                      />
                    }
                  />
                  <Bar dataKey="cost_usd" fill="var(--color-cost_usd)" radius={[0, 4, 4, 0]} />
                </BarChart>
              </ChartContainer>
            ) : (
              <div className="flex items-center justify-center h-[220px] text-sm text-muted-foreground">
                No cost data yet
              </div>
            )}
          </CardContent>
        </Card>

        {/* Cost by Stage */}
        <Card>
          <CardHeader className="pb-2">
            <CardTitle className="text-sm font-medium">Cost by Stage</CardTitle>
            <CardDescription className="text-xs">
              Spend breakdown across pipeline stages
            </CardDescription>
          </CardHeader>
          <CardContent>
            {stageData.length > 0 ? (
              <ChartContainer config={stageChartConfig} className="h-[220px] w-full">
                <BarChart data={stageData} margin={{ top: 8 }}>
                  <CartesianGrid vertical={false} strokeDasharray="3 3" className="stroke-border/30" />
                  <XAxis
                    dataKey="stage"
                    tickLine={false}
                    axisLine={false}
                    className="text-xs"
                  />
                  <YAxis tickLine={false} axisLine={false} width={50} className="text-xs" />
                  <ChartTooltip
                    content={
                      <ChartTooltipContent
                        formatter={(value) => formatCost(Number(value))}
                      />
                    }
                  />
                  <Bar dataKey="cost_usd" fill="var(--color-cost_usd)" radius={[4, 4, 0, 0]} />
                </BarChart>
              </ChartContainer>
            ) : (
              <div className="flex items-center justify-center h-[220px] text-sm text-muted-foreground">
                No cost data yet
              </div>
            )}
          </CardContent>
        </Card>
      </div>

      {/* Cost Over Time */}
      {data?.cost_over_time && data.cost_over_time.length > 0 && (
        <Card>
          <CardHeader className="pb-2">
            <CardTitle className="text-sm font-medium">Cost Over Time</CardTitle>
            <CardDescription className="text-xs">
              Daily spend trend
            </CardDescription>
          </CardHeader>
          <CardContent>
            <ChartContainer config={timeChartConfig} className="h-[220px] w-full">
              <LineChart data={data.cost_over_time} margin={{ top: 8, right: 8, bottom: 0, left: 0 }}>
                <CartesianGrid vertical={false} strokeDasharray="3 3" className="stroke-border/30" />
                <XAxis
                  dataKey="date"
                  tickLine={false}
                  axisLine={false}
                  tickFormatter={(v) => new Date(v).toLocaleDateString(undefined, { month: "short", day: "numeric" })}
                  className="text-xs"
                />
                <YAxis
                  tickLine={false}
                  axisLine={false}
                  width={50}
                  tickFormatter={(v) => `$${v}`}
                  className="text-xs"
                />
                <ChartTooltip
                  content={
                    <ChartTooltipContent
                      formatter={(value) => formatCost(Number(value))}
                    />
                  }
                />
                <Line
                  dataKey="cost_usd"
                  type="monotone"
                  stroke="var(--color-cost_usd)"
                  strokeWidth={2}
                  dot={false}
                  activeDot={{ r: 4 }}
                />
              </LineChart>
            </ChartContainer>
          </CardContent>
        </Card>
      )}

      {/* Cost by Profile */}
      {data?.by_profile && data.by_profile.length > 0 && (
        <Card>
          <CardHeader className="pb-2">
            <CardTitle className="text-sm font-medium">Cost by Profile</CardTitle>
            <CardDescription className="text-xs">
              Spend per website profile
            </CardDescription>
          </CardHeader>
          <CardContent>
            <ChartContainer config={profileCostConfig} className="h-[200px] w-full">
              <BarChart data={data.by_profile} layout="vertical" margin={{ left: 10 }}>
                <YAxis
                  dataKey="name"
                  type="category"
                  tickLine={false}
                  axisLine={false}
                  width={120}
                  className="text-xs"
                />
                <XAxis type="number" hide />
                <ChartTooltip
                  content={
                    <ChartTooltipContent
                      formatter={(value) => formatCost(Number(value))}
                    />
                  }
                />
                <Bar dataKey="cost_usd" fill="var(--color-cost_usd)" radius={[0, 4, 4, 0]} />
              </BarChart>
            </ChartContainer>
          </CardContent>
        </Card>
      )}
    </div>
  );
}
