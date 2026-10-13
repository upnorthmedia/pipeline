import { Skeleton } from "@/components/ui/skeleton";

/**
 * The loading state of the post detail screen.
 *
 * It is used twice: by `loading.tsx` while Next.js resolves the route, and by
 * the page itself while its client fetch is in flight. Those are two different
 * waits for the same screen, and before this component they looked nothing
 * alike (the route had a full layout mirror, the page had three grey bars), so
 * a normal load flashed one and then the other.
 */
export function PostDetailSkeleton() {
  return (
    <div className="mx-auto max-w-6xl space-y-6 p-6">
      {/* Header */}
      <div className="flex items-start justify-between gap-4">
        <div className="flex items-start gap-3">
          <Skeleton className="mt-1 h-9 w-9" />
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

      {/* Pipeline progress */}
      <div className="rounded-md border border-border p-4">
        <div className="flex items-center justify-center gap-3">
          {Array.from({ length: 6 }).map((_, i) => (
            <div key={i} className="flex items-center gap-2">
              <Skeleton className="h-9 w-9 rounded-full" />
              <Skeleton className="h-3 w-14" />
              {i < 5 && <Skeleton className="h-0.5 w-8" />}
            </div>
          ))}
        </div>
      </div>

      {/* Run trace */}
      <div className="rounded-md border border-border">
        <div className="flex items-center justify-between border-b border-border px-4 py-3">
          <Skeleton className="h-5 w-24" />
          <div className="flex items-center gap-2">
            <Skeleton className="h-4 w-20" />
            <Skeleton className="h-4 w-12" />
            <Skeleton className="h-4 w-14" />
          </div>
        </div>
        <div className="space-y-3 p-4">
          {Array.from({ length: 6 }).map((_, i) => (
            <Skeleton key={i} className="h-4 w-full" />
          ))}
        </div>
      </div>

      {/* Tabs */}
      <div className="space-y-4">
        <div className="flex items-center justify-between">
          <div className="flex gap-1">
            {Array.from({ length: 6 }).map((_, i) => (
              <Skeleton key={i} className="h-9 w-20" />
            ))}
          </div>
          <Skeleton className="h-8 w-16" />
        </div>

        {/* Editor / preview split pane */}
        <div className="rounded-md border border-border">
          <div className="flex items-center justify-between border-b border-border px-4 py-3">
            <Skeleton className="h-5 w-32" />
          </div>
          <div className="grid grid-cols-1 divide-y divide-border lg:grid-cols-2 lg:divide-x lg:divide-y-0">
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
