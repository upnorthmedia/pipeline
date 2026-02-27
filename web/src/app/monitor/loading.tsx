import { Skeleton } from "@/components/ui/skeleton";

export default function Loading() {
  return (
    <div className="p-6 space-y-6">
      {/* Header */}
      <div className="flex items-center justify-between">
        <div className="space-y-2">
          <Skeleton className="h-7 w-36" />
          <Skeleton className="h-4 w-48" />
        </div>
        <Skeleton className="h-9 w-9" />
      </div>

      {/* Stats Row */}
      <div className="grid grid-cols-2 lg:grid-cols-4 gap-4">
        {Array.from({ length: 4 }).map((_, i) => (
          <div key={i} className="rounded-md border border-border p-4">
            <div className="flex items-center justify-between">
              <div className="space-y-2">
                <Skeleton className="h-3 w-20" />
                <Skeleton className="h-8 w-12" />
              </div>
              <Skeleton className="h-8 w-8 rounded" />
            </div>
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
