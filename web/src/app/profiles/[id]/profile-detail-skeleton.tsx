import { Skeleton } from "@/components/ui/skeleton";

/**
 * Shaped like the Site tab, which is the tab the page opens on: the tab bar,
 * the Site card's two field rows and the Voice card's row, textarea and field.
 * Anything else would move the real content sideways the moment it arrives.
 */
export function ProfileDetailSkeleton() {
  return (
    <div className="p-6 max-w-3xl mx-auto space-y-6">
      {/* Header */}
      <div className="flex items-start gap-3">
        <Skeleton className="h-9 w-9 mt-1" />
        <div className="space-y-2">
          <Skeleton className="h-6 w-48" />
          <Skeleton className="h-4 w-64" />
        </div>
      </div>

      {/* Tab bar */}
      <Skeleton className="h-9 w-[26rem]" />

      {/* Site card */}
      <div className="rounded-md border border-border">
        <div className="p-6 space-y-1.5">
          <Skeleton className="h-5 w-16" />
          <Skeleton className="h-4 w-72" />
        </div>
        <div className="px-6 pb-6 space-y-4">
          {Array.from({ length: 2 }).map((_, i) => (
            <div key={i} className="grid grid-cols-2 gap-4">
              <div className="space-y-2">
                <Skeleton className="h-4 w-12" />
                <Skeleton className="h-10 w-full" />
              </div>
              <div className="space-y-2">
                <Skeleton className="h-4 w-24" />
                <Skeleton className="h-10 w-full" />
              </div>
            </div>
          ))}
        </div>
      </div>

      {/* Voice card */}
      <div className="rounded-md border border-border">
        <div className="p-6 space-y-1.5">
          <Skeleton className="h-5 w-20" />
          <Skeleton className="h-4 w-80" />
        </div>
        <div className="px-6 pb-6 space-y-4">
          <div className="grid grid-cols-2 gap-4">
            <div className="space-y-2">
              <Skeleton className="h-4 w-10" />
              <Skeleton className="h-10 w-full" />
            </div>
            <div className="space-y-2">
              <Skeleton className="h-4 w-14" />
              <Skeleton className="h-10 w-full" />
            </div>
          </div>
          <div className="space-y-2">
            <Skeleton className="h-4 w-24" />
            <Skeleton className="h-20 w-full" />
          </div>
          <div className="space-y-2">
            <Skeleton className="h-4 w-32" />
            <Skeleton className="h-10 w-full" />
          </div>
        </div>
      </div>

      {/* Save bar */}
      <div className="flex justify-end">
        <Skeleton className="h-9 w-32" />
      </div>
    </div>
  );
}
