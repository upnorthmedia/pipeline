"use client";

import type { Components } from "react-markdown";
import Markdown from "react-markdown";
import remarkGfm from "remark-gfm";
import { ScrollArea } from "@/components/ui/scroll-area";

const API_BASE = process.env.NEXT_PUBLIC_API_URL || "http://localhost:8000";

function resolveImageSrc(src: string | undefined): string {
  if (!src) return "";
  if (src.startsWith("/media/")) return `${API_BASE}${src}`;
  return src;
}

const markdownComponents: Components = {
  img: ({ src, alt }) => (
    // eslint-disable-next-line @next/next/no-img-element
    <img
      src={resolveImageSrc(typeof src === "string" ? src : undefined)}
      alt={alt || ""}
      className="rounded-lg my-8 w-full shadow-sm"
      loading="lazy"
    />
  ),
};

/**
 * Strip wrapping code fences (```markdown ... ```) and YAML frontmatter
 * so the markdown renders as formatted prose instead of raw text.
 */
function cleanMarkdown(raw: string): string {
  let s = raw.trim();
  // Remove wrapping code fence (e.g. ```markdown\n...\n```)
  const fenceRe = /^```(?:markdown|md|mdx)?\s*\n([\s\S]*?)\n```\s*$/;
  const fenceMatch = s.match(fenceRe);
  if (fenceMatch) s = fenceMatch[1];
  // Strip YAML frontmatter
  const fmRe = /^---\s*\n[\s\S]*?\n---\s*\n/;
  s = s.replace(fmRe, "");
  return s.trim();
}

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
        <div className="flex justify-center px-8 py-6">
          <div className="prose prose-neutral dark:prose-invert max-w-prose prose-headings:tracking-tight prose-p:leading-7 prose-img:rounded-lg prose-a:text-primary prose-a:no-underline hover:prose-a:underline prose-blockquote:border-primary/40 prose-code:before:content-none prose-code:after:content-none prose-code:bg-muted prose-code:rounded prose-code:px-1.5 prose-code:py-0.5 prose-code:text-sm">
            <Markdown remarkPlugins={[remarkGfm]} components={markdownComponents}>
              {cleanMarkdown(content)}
            </Markdown>
          </div>
        </div>
      </ScrollArea>
    </div>
  );
}
