"use client";

import { useState } from "react";
import type { ReactNode } from "react";

interface ImageWithFallbackProps {
  src: string;
  alt: string;
  className?: string;
  loading?: "eager" | "lazy";
  /** Rendered in place of the image once the browser reports it cannot load. */
  fallback: ReactNode;
  /** Called once, when the load fails, so a parent can count the failure. */
  onFailure?: () => void;
}

/**
 * An `<img>` that never leaves a broken-image glyph on screen.
 *
 * Every generated image is served from this app's own `/media/<post_id>/<file>`
 * route, which answers `404` for a file that is not on disk. Those files go
 * missing in ordinary ways: the images stage recorded an entry whose write
 * failed, or the run happened in the compose stack while the page is being read
 * against the repo directory (`todo.md`, 2026-08-23). The manifest cannot tell
 * the difference, because it stores the url the stage intended to write, so the
 * only thing that knows is the load itself.
 */
export function ImageWithFallback({
  src,
  alt,
  className,
  loading,
  fallback,
  onFailure,
}: ImageWithFallbackProps) {
  // The src that failed, rather than a flag: a re-run of the images stage
  // writes a new file under a new name, and the new one has to get its own
  // chance to load rather than inheriting the previous one's verdict.
  const [failedSrc, setFailedSrc] = useState<string | null>(null);

  if (failedSrc === src) return <>{fallback}</>;

  return (
    // eslint-disable-next-line @next/next/no-img-element
    <img
      src={src}
      alt={alt}
      className={className}
      loading={loading}
      onError={() => {
        setFailedSrc(src);
        onFailure?.();
      }}
    />
  );
}
