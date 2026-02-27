import { Skeleton } from "@/components/ui/skeleton";

export default function Loading() {
  return (
    <div className="p-6 space-y-6">
      {/* Header */}
      <div className="flex items-start justify-between gap-4">
        <div className="flex items-start gap-3">
          <Skeleton className="h-9 w-9 mt-1" />
          <div className="space-y-2">
            <Skeleton className="h-6 w-64" />
            <div className="flex items-center gap-2">
              <Skeleton className="h-4 w-32" />
              <Skeleton className="h-5 w-16" />
            </div>
          </div>
        </div>
        <div className="flex items-center gap-2">
          <Skeleton className="h-8 w-24" />
          <Skeleton className="h-8 w-24" />
          <Skeleton className="h-8 w-20" />
        </div>
      </div>

      {/* Pipeline Progress Card */}
      <div className="rounded-md border border-border p-4">
        <div className="flex items-center justify-center gap-3">
          {Array.from({ length: 5 }).map((_, i) => (
            <div key={i} className="flex items-center gap-2">
              <Skeleton className="h-6 w-6 rounded-full" />
              <Skeleton className="h-3 w-14" />
              {i < 4 && <Skeleton className="h-0.5 w-8" />}
            </div>
          ))}
        </div>
      </div>

      {/* Tabs */}
      <div className="space-y-4">
        <div className="flex items-center justify-between">
          <div className="flex gap-1">
            {Array.from({ length: 5 }).map((_, i) => (
              <Skeleton key={i} className="h-9 w-20" />
            ))}
          </div>
          <div className="flex gap-2">
            <Skeleton className="h-8 w-16" />
            <Skeleton className="h-8 w-18" />
          </div>
        </div>

        {/* Editor/Preview split pane */}
        <div className="rounded-md border border-border">
          <div className="border-b border-border px-4 py-3 flex items-center justify-between">
            <Skeleton className="h-5 w-32" />
          </div>
          <div className="grid grid-cols-1 lg:grid-cols-2 divide-y lg:divide-y-0 lg:divide-x divide-border">
            <div className="space-y-2 p-4">
              <Skeleton className="h-4 w-16" />
              <Skeleton className="h-[450px] w-full" />
            </div>
            <div className="space-y-2 p-4">
              <Skeleton className="h-4 w-16" />
              <Skeleton className="h-[450px] w-full" />
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}
