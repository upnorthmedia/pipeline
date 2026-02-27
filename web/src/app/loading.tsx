import { Skeleton } from "@/components/ui/skeleton";

export default function Loading() {
  return (
    <div className="p-6 space-y-6">
      {/* Header */}
      <div className="flex items-center justify-between">
        <div className="space-y-2">
          <Skeleton className="h-7 w-32" />
          <Skeleton className="h-4 w-24" />
        </div>
        <div className="flex items-center gap-2">
          <Skeleton className="h-9 w-9" />
          <Skeleton className="h-9 w-24" />
          <Skeleton className="h-9 w-28" />
        </div>
      </div>

      {/* Filters */}
      <div className="flex items-center gap-3">
        <Skeleton className="h-9 w-64" />
        <Skeleton className="h-9 w-[140px]" />
        <Skeleton className="h-9 w-[180px]" />
      </div>

      {/* Table */}
      <div className="rounded-md border border-border">
        <div className="border-b border-border px-4 py-3 flex items-center gap-4">
          <Skeleton className="h-4 w-4" />
          <Skeleton className="h-4 w-16" />
          <Skeleton className="h-4 w-14 ml-auto" />
          <Skeleton className="h-4 w-20" />
          <Skeleton className="h-4 w-8" />
          <Skeleton className="h-4 w-16" />
          <Skeleton className="h-4 w-4" />
        </div>
        {Array.from({ length: 5 }).map((_, i) => (
          <div
            key={i}
            className="border-b border-border px-4 py-3 flex items-center gap-4 last:border-b-0"
          >
            <Skeleton className="h-4 w-4" />
            <div className="flex-1 space-y-1.5">
              <Skeleton className="h-4 w-48" />
              <Skeleton className="h-3 w-32" />
            </div>
            <Skeleton className="h-5 w-16" />
            <Skeleton className="h-4 w-24" />
            <Skeleton className="h-4 w-6" />
            <Skeleton className="h-4 w-14" />
            <Skeleton className="h-4 w-4" />
          </div>
        ))}
      </div>
    </div>
  );
}
