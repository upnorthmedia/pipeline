"use client";

import { Image as ImageIcon } from "lucide-react";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";

const API_BASE = process.env.NEXT_PUBLIC_API_URL || "http://localhost:8000";

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
}

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

export function ImagePreview({ manifest, className }: ImagePreviewProps) {
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

  const { images, model, version, style_brief, total_generated, total_failed } =
    manifest;

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
              {total_generated ?? images.length} generated
              {total_failed ? (
                <span className="text-red-500 ml-1">
                  ({total_failed} failed)
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

      {/* Image cards */}
      <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-3">
        {images.map((entry, i) => {
          const label = entry.id || entry.type || `image-${i}`;
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
                  {entry.generated === false && (
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
                {entry.url ? (
                  <div className="relative aspect-video rounded-md overflow-hidden bg-muted">
                    {/* eslint-disable-next-line @next/next/no-img-element */}
                    <img
                      src={`${API_BASE}${entry.url}`}
                      alt={entry.alt_text || label}
                      className="object-cover w-full h-full"
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
