/**
 * The badge a row gets when its publish has stopped moving.
 *
 * It is one component rather than one per screen because the posts list and
 * the post page show it side by side in a normal session: an operator sees the
 * badge on the list, clicks the row, and has to find the same words there.
 * The derivation comes with it, so neither screen can decide differently which
 * destination the row publishes to or when its window closed.
 *
 * The clock is the caller's, because the two screens tick at different times:
 * a stall appears with no event behind it, so each page owns the interval that
 * makes the render happen at all.
 */
import { AlertCircle } from "lucide-react";

import { Badge } from "@/components/ui/badge";
import { rowPublishStall, type PostPublishRow } from "@/lib/publish-report";

export function PublishStallBadge({ post, now }: { post: PostPublishRow; now: number }) {
  const stall = rowPublishStall(post, now);
  if (stall === null) return null;
  return (
    <Badge variant="outline" className="text-amber-600 border-amber-600" title={stall.reason}>
      <AlertCircle className="h-3 w-3 mr-1" />
      Publish stalled
    </Badge>
  );
}
