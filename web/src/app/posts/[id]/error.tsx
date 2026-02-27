"use client";

import { useEffect } from "react";
import Link from "next/link";
import { ArrowLeft } from "lucide-react";
import { Button } from "@/components/ui/button";

export default function Error({
  error,
  reset,
}: {
  error: Error & { digest?: string };
  reset: () => void;
}) {
  useEffect(() => {
    console.error(error);
  }, [error]);

  return (
    <div className="flex min-h-[50vh] flex-col items-center justify-center gap-4 px-4">
      <div className="text-center">
        <h2 className="text-xl font-semibold">Failed to load post</h2>
        <p className="mt-2 text-sm text-muted-foreground">
          {error.message || "An unexpected error occurred."}
        </p>
      </div>
      <div className="flex items-center gap-2">
        <Button asChild variant="outline">
          <Link href="/">
            <ArrowLeft className="h-4 w-4 mr-1.5" />
            Back to Posts
          </Link>
        </Button>
        <Button onClick={reset} variant="outline">
          Try again
        </Button>
      </div>
    </div>
  );
}
