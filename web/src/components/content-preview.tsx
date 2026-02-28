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
  h1: ({ children }) => (
    <h1 className="text-3xl font-bold tracking-tight mt-10 mb-4">{children}</h1>
  ),
  h2: ({ children }) => (
    <h2 className="text-2xl font-semibold tracking-tight mt-8 mb-3">{children}</h2>
  ),
  h3: ({ children }) => (
    <h3 className="text-xl font-semibold mt-6 mb-2">{children}</h3>
  ),
  h4: ({ children }) => (
    <h4 className="text-lg font-semibold mt-5 mb-2">{children}</h4>
  ),
  p: ({ children }) => <p className="mb-4 leading-7">{children}</p>,
  a: ({ href, children }) => (
    <a
      href={href}
      className="text-primary underline underline-offset-4 hover:text-primary/80"
      target="_blank"
      rel="noopener noreferrer"
    >
      {children}
    </a>
  ),
  ul: ({ children }) => (
    <ul className="mb-4 ml-6 list-disc space-y-1">{children}</ul>
  ),
  ol: ({ children }) => (
    <ol className="mb-4 ml-6 list-decimal space-y-1">{children}</ol>
  ),
  li: ({ children }) => <li className="leading-7">{children}</li>,
  blockquote: ({ children }) => (
    <blockquote className="mb-4 border-l-4 border-primary/40 pl-4 italic text-muted-foreground">
      {children}
    </blockquote>
  ),
  hr: () => <hr className="my-8 border-border" />,
  code: ({ children, className }) => {
    const isBlock = className?.includes("language-");
    if (isBlock) {
      return (
        <code className={className}>{children}</code>
      );
    }
    return (
      <code className="rounded bg-muted px-1.5 py-0.5 text-sm font-mono">
        {children}
      </code>
    );
  },
  pre: ({ children }) => (
    <pre className="mb-4 overflow-x-auto rounded-lg bg-muted p-4 text-sm">
      {children}
    </pre>
  ),
  img: ({ src, alt }) => (
    // eslint-disable-next-line @next/next/no-img-element
    <img
      src={resolveImageSrc(typeof src === "string" ? src : undefined)}
      alt={alt || ""}
      className="rounded-lg my-8 w-full shadow-sm"
      loading="lazy"
    />
  ),
  table: ({ children }) => (
    <div className="mb-4 overflow-x-auto">
      <table className="w-full border-collapse text-sm">{children}</table>
    </div>
  ),
  th: ({ children }) => (
    <th className="border border-border bg-muted px-3 py-2 text-left font-semibold">
      {children}
    </th>
  ),
  td: ({ children }) => (
    <td className="border border-border px-3 py-2">{children}</td>
  ),
  strong: ({ children }) => <strong className="font-bold">{children}</strong>,
  em: ({ children }) => <em className="italic">{children}</em>,
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
          <div className="max-w-prose text-base text-foreground">
            <Markdown remarkPlugins={[remarkGfm]} components={markdownComponents}>
              {cleanMarkdown(content)}
            </Markdown>
          </div>
        </div>
      </ScrollArea>
    </div>
  );
}
