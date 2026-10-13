"use client";

import type { LucideIcon } from "lucide-react";
import { AlertCircle, RefreshCw } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";

/**
 * The four tabs on `/monitor` each read one analytics endpoint, so they all
 * need the same failure and absence blocks. Keeping them here is what stops the
 * four from drifting into four different ways of saying the request failed.
 */

export function TabError({
  title,
  message,
  retryLabel,
  onRetry,
}: {
  title: string;
  message: string;
  /** Distinguishes the four tabs' retries from one another for a screen reader. */
  retryLabel: string;
  onRetry: () => void;
}) {
  return (
    <Card>
      <CardContent className="py-10 text-center">
        <AlertCircle className="mx-auto h-5 w-5 text-destructive" />
        <p className="mt-2 text-sm font-medium">{title}</p>
        <p className="mx-auto mt-1 max-w-md text-sm text-muted-foreground">
          {message}
        </p>
        <Button
          variant="outline"
          size="sm"
          className="mt-3"
          onClick={onRetry}
          aria-label={retryLabel}
        >
          <RefreshCw className="h-3.5 w-3.5 mr-1.5" />
          Retry
        </Button>
      </CardContent>
    </Card>
  );
}

export function TabEmpty({
  icon: Icon,
  title,
  description,
  children,
}: {
  icon: LucideIcon;
  title: string;
  description: string;
  /** The action that fills the tab: a link to the form, or a filter reset. */
  children?: React.ReactNode;
}) {
  return (
    <Card>
      <CardContent className="py-12">
        <div className="flex flex-col items-center justify-center text-center">
          <Icon className="h-8 w-8 text-muted-foreground/40 mb-2" />
          <p className="text-sm font-medium">{title}</p>
          <p className="mx-auto mt-1 max-w-md text-xs text-muted-foreground">
            {description}
          </p>
          {children && <div className="mt-3">{children}</div>}
        </div>
      </CardContent>
    </Card>
  );
}

/**
 * A refresh that fails after a good render must not throw away what is on
 * screen: the numbers stay, with a line saying they are the previous ones.
 */
export function StaleBanner({ message }: { message: string }) {
  return (
    <div className="flex items-start gap-2 rounded-md border border-destructive/40 bg-destructive/5 px-3 py-2 text-sm">
      <AlertCircle className="mt-0.5 h-4 w-4 shrink-0 text-destructive" />
      <p className="text-muted-foreground">
        <span className="font-medium text-foreground">Showing the last good data.</span>{" "}
        {message}
      </p>
    </div>
  );
}
