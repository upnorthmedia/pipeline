import { Skeleton } from "@/components/ui/skeleton";

export default function Loading() {
  return (
    <div className="p-6 max-w-3xl mx-auto space-y-6">
      {/* Header */}
      <div className="flex items-center gap-3">
        <Skeleton className="h-6 w-6" />
        <div className="space-y-1.5">
          <Skeleton className="h-7 w-24" />
          <Skeleton className="h-4 w-64" />
        </div>
      </div>

      {/* API Keys Card */}
      <div className="rounded-md border border-border">
        <div className="p-6 space-y-1.5">
          <Skeleton className="h-5 w-24" />
          <Skeleton className="h-4 w-64" />
        </div>
        <div className="px-6 pb-6 space-y-4">
          {Array.from({ length: 3 }).map((_, i) => (
            <div key={i} className="space-y-2">
              <Skeleton className="h-4 w-40" />
              <div className="flex gap-2">
                <Skeleton className="h-10 flex-1" />
                <Skeleton className="h-10 w-10" />
              </div>
            </div>
          ))}
          <Skeleton className="h-px w-full" />
          <div className="flex justify-end">
            <Skeleton className="h-9 w-32" />
          </div>
        </div>
      </div>

      {/* Worker Config Card */}
      <div className="rounded-md border border-border">
        <div className="p-6 space-y-1.5">
          <Skeleton className="h-5 w-40" />
          <Skeleton className="h-4 w-56" />
        </div>
        <div className="px-6 pb-6 space-y-4">
          <div className="space-y-2">
            <Skeleton className="h-4 w-32" />
            <Skeleton className="h-10 w-40" />
            <Skeleton className="h-3 w-64" />
          </div>
          <Skeleton className="h-px w-full" />
          <div className="flex justify-end">
            <Skeleton className="h-9 w-20" />
          </div>
        </div>
      </div>

      {/* Rule Files Card */}
      <div className="rounded-md border border-border">
        <div className="p-6 space-y-1.5">
          <Skeleton className="h-5 w-24" />
          <Skeleton className="h-4 w-64" />
        </div>
        <div className="px-6 pb-6 space-y-4">
          <div className="flex gap-2">
            {Array.from({ length: 5 }).map((_, i) => (
              <Skeleton key={i} className="h-8 w-28" />
            ))}
          </div>
          <Skeleton className="h-[400px] w-full" />
          <Skeleton className="h-px w-full" />
          <div className="flex justify-end">
            <Skeleton className="h-9 w-36" />
          </div>
        </div>
      </div>
    </div>
  );
}
