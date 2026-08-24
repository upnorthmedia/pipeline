"use client";

import { useState } from "react";
import { AlertTriangle, Image as ImageIcon, RefreshCw } from "lucide-react";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { ImageWithFallback } from "@/components/image-with-fallback";

interface ImageEntry {
  id?: string;
  type?: string;
  prompt?: string;
  alt_text?: string;
  filename?: string;
  url?: string;
  placement?: { location?: string; after_section?: string | null };
  image_size?: string;
  aspect_ratio?: string;
  size_bytes?: number;
  generated?: boolean;
  error?: string;
  context?: string;
  negative_prompt?: string;
  [key: string]: unknown;
}

interface ImageManifest {
  model?: string;
  version?: string;
  images?: ImageEntry[];
  style_brief?: {
    overall_style?: string;
    mood?: string;
    color_palette?: string[];
    [key: string]: unknown;
  };
  total_generated?: number;
  total_failed?: number;
  [key: string]: unknown;
}

interface ImagePreviewProps {
  manifest: ImageManifest | null;
  className?: string;
  /**
   * Re-runs the images stage. Optional because the component is also rendered
   * where there is nothing to run against; the retry only appears when both a
   * failure and a handler exist.
   */
  onRetry?: () => void;
}

/**
 * `generateOneImage` records this exact string on an entry the writing model
 * gave no prompt for (`NO_PROMPT_ERROR` in `mastra/images/generate-one.ts`).
 * It is an internal token rather than a provider message, so it is the one
 * reason worth saying in the user's terms; every other value on `error` is the
 * provider's own text and is shown verbatim.
 */
const NO_PROMPT_ERROR = "no prompt";

/**
 * Why this entry has no image, or `null` if it has one.
 *
 * The manifest is the images stage's own record: `generateOneImage` writes
 * `generated: false` with the reason on `error` for both of its failure exits,
 * and `generated: true` with a `url` for the one success exit. An entry with
 * neither key is a manifest the stage never got as far as annotating, which is
 * not a failure and is drawn as the placeholder it always was.
 */
function failureReason(entry: ImageEntry): string | null {
  const error = typeof entry.error === "string" ? entry.error.trim() : "";
  if (error === NO_PROMPT_ERROR) {
    return "This image was planned but no prompt was written for it, so nothing was generated.";
  }
  if (error) return error;
  if (entry.generated === false) {
    return "The image generator reported a failure but recorded no reason.";
  }
  return null;
}

/** The card heading, and the key the missing-file set is held under. */
function entryLabel(entry: ImageEntry, index: number): string {
  return entry.id || entry.type || `image-${index}`;
}

/** The reason shown for an entry whose file the media route cannot serve. */
const MISSING_FILE_REASON =
  "The image file is missing from the server, so there is nothing to show.";

/** The failure block that stands where the image would have been. */
function ImageFailure({ reason }: { reason: string }) {
  return (
    <div className="flex flex-col items-center justify-center gap-2 aspect-video overflow-hidden rounded-md border border-destructive/30 bg-destructive/5 px-4 text-center">
      <AlertTriangle className="h-6 w-6 shrink-0 text-destructive" />
      {/* A provider message can be one long unbroken token, and a flex child's
          width is shrink-to-fit, so the width has to be pinned to the card for
          `break-words` to have anything to wrap inside. */}
      <p className="w-full overflow-y-auto text-xs text-destructive break-words">
        {reason}
      </p>
    </div>
  );
}

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

export function ImagePreview({ manifest, className, onRetry }: ImagePreviewProps) {
  // Labels of entries the manifest calls generated whose file the media route
  // would not serve. Only the load knows, so it is state rather than a read of
  // the manifest, and it has to be declared before the empty-manifest return.
  const [missingFiles, setMissingFiles] = useState<string[]>([]);

  if (!manifest || !manifest.images || manifest.images.length === 0) {
    return (
      <Card className={className}>
        <CardContent className="py-12 text-center">
          <ImageIcon className="mx-auto h-8 w-8 text-muted-foreground/40 mb-3" />
          <p className="text-muted-foreground text-sm">
            No images generated yet
          </p>
        </CardContent>
      </Card>
    );
  }

  const { images, model, version, style_brief } = manifest;

  // Counted off the entries rather than read from `total_generated` and
  // `total_failed`, so that the summary agrees with the cards below it: a file
  // that has gone missing since the run is a failure the stage's own totals
  // cannot know about.
  const reasons = images.map((entry, i) => {
    const label = entryLabel(entry, i);
    return failureReason(entry) ?? (missingFiles.includes(label) ? MISSING_FILE_REASON : null);
  });
  const failedCount = reasons.filter((reason) => reason !== null).length;

  return (
    <div className={className} data-testid="image-preview">
      {/* Summary row */}
      <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-3 mb-4">
        <Card>
          <CardHeader className="pb-2">
            <CardTitle className="text-sm">Model</CardTitle>
          </CardHeader>
          <CardContent>
            <p className="text-sm font-mono">{model || "Unknown"}</p>
          </CardContent>
        </Card>
        <Card>
          <CardHeader className="pb-2">
            <CardTitle className="text-sm">Images</CardTitle>
          </CardHeader>
          <CardContent>
            <p className="text-sm">
              {images.length - failedCount} generated
              {failedCount ? (
                <span className="text-destructive ml-1">
                  ({failedCount} failed)
                </span>
              ) : null}
            </p>
          </CardContent>
        </Card>
        <Card>
          <CardHeader className="pb-2">
            <CardTitle className="text-sm">Version</CardTitle>
          </CardHeader>
          <CardContent>
            <p className="text-sm font-mono">{version || "—"}</p>
          </CardContent>
        </Card>
      </div>

      {/* Style brief */}
      {style_brief && (
        <Card className="mb-4">
          <CardHeader className="pb-2">
            <CardTitle className="text-sm">Style Brief</CardTitle>
          </CardHeader>
          <CardContent className="space-y-2">
            {style_brief.overall_style && (
              <p className="text-xs text-muted-foreground">
                <span className="font-medium">Style:</span>{" "}
                {style_brief.overall_style}
              </p>
            )}
            {style_brief.mood && (
              <p className="text-xs text-muted-foreground">
                <span className="font-medium">Mood:</span> {style_brief.mood}
              </p>
            )}
            {style_brief.color_palette && style_brief.color_palette.length > 0 && (
              <div className="flex items-center gap-2">
                <span className="text-xs font-medium text-muted-foreground">
                  Palette:
                </span>
                {style_brief.color_palette.map((color) => (
                  <div
                    key={color}
                    className="h-5 w-5 rounded border border-border"
                    style={{ backgroundColor: color }}
                    title={color}
                  />
                ))}
              </div>
            )}
          </CardContent>
        </Card>
      )}

      {/* What failed, and the one action that can fix it */}
      {failedCount > 0 && (
        <Card className="mb-4 border-destructive/40">
          <CardContent className="flex flex-wrap items-center justify-between gap-3 py-4">
            <div className="flex items-start gap-2">
              <AlertTriangle className="h-4 w-4 mt-0.5 text-destructive shrink-0" />
              <div>
                <p className="text-sm font-medium">
                  {failedCount} of {images.length} images could not be generated
                </p>
                <p className="text-xs text-muted-foreground">
                  Retrying runs the images stage again for the whole set.
                </p>
              </div>
            </div>
            {onRetry && (
              <Button variant="outline" size="sm" onClick={onRetry}>
                <RefreshCw className="h-3.5 w-3.5 mr-1.5" />
                Retry images
              </Button>
            )}
          </CardContent>
        </Card>
      )}

      {/* Image cards */}
      <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-3">
        {images.map((entry, i) => {
          const label = entryLabel(entry, i);
          const reason = reasons[i];
          const placement = typeof entry.placement === "object"
            ? entry.placement?.after_section || entry.placement?.location
            : entry.placement;

          return (
            <Card key={label}>
              <CardHeader className="pb-2">
                <div className="flex items-center justify-between">
                  <CardTitle className="text-sm capitalize">
                    {label.replace(/[_-]/g, " ")}
                  </CardTitle>
                  {reason !== null && (
                    <Badge variant="destructive" className="text-[10px]">
                      Failed
                    </Badge>
                  )}
                </div>
                {placement && (
                  <CardDescription className="text-xs">
                    {String(placement)}
                  </CardDescription>
                )}
              </CardHeader>
              <CardContent className="space-y-2">
                {reason !== null ? (
                  <ImageFailure reason={reason} />
                ) : entry.url ? (
                  <div className="relative aspect-video rounded-md overflow-hidden bg-muted">
                    <ImageWithFallback
                      src={entry.url}
                      alt={entry.alt_text || label}
                      className="object-cover w-full h-full"
                      fallback={<ImageFailure reason={MISSING_FILE_REASON} />}
                      onFailure={() =>
                        setMissingFiles((labels) =>
                          labels.includes(label) ? labels : [...labels, label]
                        )
                      }
                    />
                  </div>
                ) : (
                  <div className="flex items-center justify-center aspect-video rounded-md bg-muted">
                    <ImageIcon className="h-8 w-8 text-muted-foreground/30" />
                  </div>
                )}
                {entry.alt_text && (
                  <p className="text-xs text-muted-foreground">
                    <span className="font-medium">Alt:</span> {entry.alt_text}
                  </p>
                )}
                {entry.prompt && (
                  <p className="text-xs text-muted-foreground line-clamp-3">
                    <span className="font-medium">Prompt:</span> {entry.prompt}
                  </p>
                )}
                <div className="flex flex-wrap gap-1">
                  {entry.aspect_ratio && (
                    <Badge variant="outline" className="text-[10px]">
                      {entry.aspect_ratio}
                    </Badge>
                  )}
                  {entry.image_size && (
                    <Badge variant="outline" className="text-[10px]">
                      {entry.image_size}
                    </Badge>
                  )}
                  {entry.size_bytes && (
                    <Badge variant="outline" className="text-[10px]">
                      {formatBytes(entry.size_bytes)}
                    </Badge>
                  )}
                </div>
              </CardContent>
            </Card>
          );
        })}
      </div>
    </div>
  );
}
