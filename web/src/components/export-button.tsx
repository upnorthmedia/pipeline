"use client";

import { Copy, Download, ExternalLink } from "lucide-react";
import { Button } from "@/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { posts } from "@/lib/api";
import { toast } from "sonner";

interface ExportButtonProps {
  postId: string;
  hasMd: boolean;
  hasHtml: boolean;
  mdContent?: string | null;
  htmlContent?: string | null;
}

export function ExportButton({
  postId,
  hasMd,
  hasHtml,
  mdContent,
  htmlContent,
}: ExportButtonProps) {
  if (!hasMd && !hasHtml) return null;

  const copyToClipboard = (text: string, label: string) => {
    navigator.clipboard.writeText(text);
    toast.success(`${label} copied to clipboard`);
  };

  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <Button variant="outline" size="sm" data-testid="export-button">
          <Download className="h-3.5 w-3.5 mr-1.5" />
          Export
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end">
        {hasMd && mdContent && (
          <DropdownMenuItem
            onClick={() => copyToClipboard(mdContent, "Markdown")}
          >
            <Copy className="h-3.5 w-3.5 mr-2" />
            Copy Markdown
          </DropdownMenuItem>
        )}
        {hasMd && (
          <DropdownMenuItem asChild>
            <a
              href={posts.exportMarkdown(postId)}
              target="_blank"
              rel="noreferrer"
            >
              <Download className="h-3.5 w-3.5 mr-2" />
              Download .md
            </a>
          </DropdownMenuItem>
        )}
        {hasHtml && htmlContent && (
          <DropdownMenuItem
            onClick={() => copyToClipboard(htmlContent, "HTML")}
          >
            <Copy className="h-3.5 w-3.5 mr-2" />
            Copy HTML
          </DropdownMenuItem>
        )}
        {hasHtml && (
          <DropdownMenuItem asChild>
            <a
              href={posts.exportHtml(postId)}
              target="_blank"
              rel="noreferrer"
            >
              <Download className="h-3.5 w-3.5 mr-2" />
              Download .html
            </a>
          </DropdownMenuItem>
        )}
        <DropdownMenuItem asChild>
          <a
            href={posts.exportAll(postId)}
            target="_blank"
            rel="noreferrer"
          >
            <ExternalLink className="h-3.5 w-3.5 mr-2" />
            Download ZIP
          </a>
        </DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
