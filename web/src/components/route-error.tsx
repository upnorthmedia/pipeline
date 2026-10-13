"use client";

import { useEffect, type ReactNode } from "react";
import { Button } from "@/components/ui/button";

/**
 * The body every route error boundary renders.
 *
 * A boundary here only ever receives a programming error. Every request the
 * dashboard makes goes through `request()` in `src/lib/api.ts`, and every page
 * that makes one catches the throw and shows the server's own complaint
 * through `apiErrorMessage()`; nothing routes a failed fetch to a boundary.
 * What is left is a render-time exception, and V8 words those for whoever is
 * reading the stack ("input.entries is not iterable"), not for whoever is
 * trying to publish a blog post.
 *
 * So the exception is never the copy. The body says what happened and what it
 * did not affect, and the message goes under a disclosure with the digest,
 * where it is one click away from anyone who has to report it. That is the
 * same call `apiErrorMessage()` already makes for a response that is not JSON.
 */
export function RouteError({
  error,
  reset,
  title,
  actions,
}: {
  error: Error & { digest?: string };
  reset: () => void;
  /** What could not be displayed, in the user's terms. */
  title: string;
  /** Any way back that is more specific than retrying, rendered before it. */
  actions?: ReactNode;
}) {
  useEffect(() => {
    console.error(error);
  }, [error]);

  return (
    <div className="flex min-h-[50vh] flex-col items-center justify-center gap-4 px-4">
      <div className="text-center">
        <h2 className="text-xl font-semibold">{title}</h2>
        <p className="mt-2 max-w-md text-sm text-muted-foreground">
          This is a display failure, so nothing has been changed or lost. Try again,
          and if it keeps happening the technical details below are what to report.
        </p>
      </div>
      <div className="flex items-center gap-2">
        {actions}
        <Button onClick={reset} variant="outline">
          Try again
        </Button>
      </div>
      <details className="w-full max-w-md rounded-md border bg-muted/40 px-3 py-2">
        <summary className="cursor-pointer text-xs font-medium text-muted-foreground">
          Technical details
        </summary>
        <p className="mt-2 break-words font-mono text-xs text-muted-foreground">
          {technicalDetail(error)}
        </p>
        {error.digest ? (
          <p className="mt-1 break-words font-mono text-xs text-muted-foreground">
            Digest: {error.digest}
          </p>
        ) : null}
      </details>
    </div>
  );
}

/**
 * The one line worth reporting about an exception.
 *
 * `name` carries as much as the message often does (a bare `RangeError` says
 * more than nothing), and an error thrown with an empty message would
 * otherwise render as a blank line or, if the message were read off a plain
 * object, the string "undefined".
 */
export function technicalDetail(error: Error): string {
  const name = error.name || "Error";
  return error.message ? `${name}: ${error.message}` : name;
}
