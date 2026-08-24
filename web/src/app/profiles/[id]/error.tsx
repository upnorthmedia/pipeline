"use client";

import Link from "next/link";
import { ArrowLeft } from "lucide-react";
import { Button } from "@/components/ui/button";
import { RouteError } from "@/components/route-error";

export default function Error({
  error,
  reset,
}: {
  error: Error & { digest?: string };
  reset: () => void;
}) {
  return (
    <RouteError
      error={error}
      reset={reset}
      title="This profile could not be displayed"
      actions={
        <Button asChild variant="outline">
          <Link href="/profiles">
            <ArrowLeft className="h-4 w-4 mr-1.5" />
            Back to Profiles
          </Link>
        </Button>
      }
    />
  );
}
