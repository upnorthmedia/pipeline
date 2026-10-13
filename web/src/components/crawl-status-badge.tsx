import { Loader2 } from "lucide-react";

import { Badge } from "@/components/ui/badge";

/**
 * What a profile's `crawl_status` says, in the reader's terms.
 *
 * The column is a bare `varchar` written by three lines in
 * `src/mastra/steps/sitemap-crawl.ts` (`crawling`, `complete`, `failed`) and
 * defaulted to `pending` by `serializeProfile()`. `/profiles` has named all
 * four since it was written; `/profiles/[id]` printed the stored value, so the
 * two surfaces showed a different word for the same row. This is the one copy
 * both read.
 *
 * An unrecognised value falls back to `Pending`, which is what the list has
 * always done: the column has no `NOT NULL` and no check constraint, so an
 * empty one is the state a profile that has never been crawled is in.
 */
export function CrawlStatusBadge({ status }: { status: string }) {
  switch (status) {
    case "crawling":
      return (
        <Badge variant="outline" className="text-amber-600 border-amber-300">
          <Loader2 className="h-3 w-3 mr-1 animate-spin" />
          Crawling
        </Badge>
      );
    case "complete":
      return (
        <Badge className="bg-green-100 text-green-700 hover:bg-green-100 border-green-300">
          Complete
        </Badge>
      );
    case "failed":
      return <Badge variant="destructive">Failed</Badge>;
    default:
      return <Badge variant="secondary">Pending</Badge>;
  }
}
