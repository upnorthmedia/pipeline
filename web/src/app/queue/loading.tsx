import { Skeleton } from "@/components/ui/skeleton";

export default function Loading() {
  return (
    <div className="p-6 space-y-6">
      {/* Header */}
      <div className="flex items-center justify-between">
        <div className="space-y-2">
          <Skeleton className="h-7 w-36" />
          <Skeleton className="h-4 w-40" />
        </div>
        <Skeleton className="h-9 w-9" />
      </div>

      {/* Review cards grid */}
      <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-4">
        {Array.from({ length: 6 }).map((_, i) => (
          <div key={i} className="rounded-md border border-border flex flex-col">
            <div className="p-6 space-y-2">
              <Skeleton className="h-5 w-3/4" />
              <Skeleton className="h-3 w-1/2" />
            </div>
            <div className="px-6 pb-4 space-y-3 flex-1">
              <div className="flex items-center gap-2">
                <Skeleton className="h-5 w-16" />
                <Skeleton className="h-2 w-24" />
              </div>
              <Skeleton className="h-16 w-full rounded-md" />
            </div>
            <div className="px-6 pb-6 flex gap-2">
              <Skeleton className="h-8 w-24" />
              <Skeleton className="h-8 w-28" />
              <Skeleton className="h-8 w-20" />
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}
