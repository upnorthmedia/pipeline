"use client";

import Markdown from "react-markdown";
import remarkGfm from "remark-gfm";
import { ScrollArea } from "@/components/ui/scroll-area";

interface ContentPreviewProps {
  content: string;
  className?: string;
  height?: string;
}

export function ContentPreview({
  content,
  className,
  height = "500px",
}: ContentPreviewProps) {
  if (!content) {
    return (
      <div
        className={className}
        style={{ height }}
        data-testid="content-preview"
      >
        <div className="flex items-center justify-center h-full text-muted-foreground text-sm">
          No content to preview
        </div>
      </div>
    );
  }

  return (
    <div className={className} data-testid="content-preview">
      <ScrollArea style={{ height }}>
        <div className="prose prose-sm prose-invert max-w-none p-4">
          <Markdown remarkPlugins={[remarkGfm]}>{content}</Markdown>
        </div>
      </ScrollArea>
    </div>
  );
}
