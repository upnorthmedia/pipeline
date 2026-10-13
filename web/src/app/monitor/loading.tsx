import { Skeleton } from "@/components/ui/skeleton";

/**
 * Mirrors the first paint of `page.tsx`: the heading, the four-tab strip and
 * the Overview tab's own loading shape. It is a hand-maintained copy, so a
 * block added to the page belongs here too.
 */
export default function Loading() {
  return (
    <div className="p-6 space-y-6">
      {/* Header */}
      <div className="space-y-2">
        <Skeleton className="h-7 w-40" />
        <Skeleton className="h-4 w-72" />
      </div>

      {/* Tab strip */}
      <div className="flex items-center gap-6 border-b border-border pb-2">
        {Array.from({ length: 4 }).map((_, i) => (
          <Skeleton key={i} data-testid="monitor-tab-skeleton" className="h-4 w-20" />
        ))}
      </div>

      {/* Stats Row */}
      <div className="grid grid-cols-2 lg:grid-cols-4 gap-4">
        {Array.from({ length: 4 }).map((_, i) => (
          <div
            key={i}
            data-testid="monitor-stat-skeleton"
            className="rounded-md border border-border p-4"
          >
            <div className="flex items-center justify-between">
              <div className="space-y-2">
                <Skeleton className="h-3 w-20" />
                <Skeleton className="h-8 w-12" />
              </div>
              <Skeleton className="h-10 w-10 rounded-lg" />
            </div>
          </div>
        ))}
      </div>

      {/* Charts Row */}
      <div className="grid grid-cols-1 lg:grid-cols-2 gap-4">
        {Array.from({ length: 2 }).map((_, i) => (
          <div
            key={i}
            data-testid="monitor-chart-skeleton"
            className="rounded-md border border-border p-6"
          >
            <Skeleton className="h-48 w-full" />
          </div>
        ))}
      </div>

      {/* Queue Controls Card */}
      <div className="rounded-md border border-border">
        <div className="p-6 space-y-1.5">
          <Skeleton className="h-5 w-32" />
        </div>
        <div className="px-6 pb-6 flex items-center gap-4">
          <Skeleton className="h-9 w-28" />
          <Skeleton className="h-9 w-32" />
          <Skeleton className="h-8 w-px" />
          <Skeleton className="h-4 w-24" />
          <Skeleton className="h-4 w-20" />
        </div>
      </div>

      {/* Activity Feed Card */}
      <div className="rounded-md border border-border">
        <div className="p-6 flex items-center justify-between">
          <Skeleton className="h-5 w-32" />
          <Skeleton className="h-5 w-20" />
        </div>
        <div className="px-6 pb-6 space-y-2">
          {Array.from({ length: 5 }).map((_, i) => (
            <div
              key={i}
              className="flex items-center gap-3 rounded-md border border-border px-3 py-2"
            >
              <Skeleton className="h-4 w-20" />
              <Skeleton className="h-4 w-16" />
              <Skeleton className="h-5 w-24" />
              <Skeleton className="h-4 w-14" />
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}
