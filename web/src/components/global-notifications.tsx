"use client";

import { useSSE, type SSEEvent } from "@/hooks/use-sse";
import { authClient } from "@/lib/auth-client";
import { toast } from "sonner";
import { useCallback } from "react";

export const GlobalNotifications = () => {
  const handleEvent = useCallback((event: SSEEvent) => {
    const stage = event.stage || "unknown";
    const postId = event.post_id;

    switch (event.event) {
      case "stage_complete":
        toast.success(`${stage} complete`, {
          description: `Post ${postId?.slice(0, 8)}...`,
          action: postId
            ? {
                label: "View",
                onClick: () => {
                  window.location.href = `/posts/${postId}`;
                },
              }
            : undefined,
        });
        break;

      case "stage_error":
        toast.error(`${stage} failed`, {
          description: event.error || `Post ${postId?.slice(0, 8)}...`,
          action: postId
            ? {
                label: "View",
                onClick: () => {
                  window.location.href = `/posts/${postId}`;
                },
              }
            : undefined,
        });
        break;

      case "pipeline_complete":
        toast.success("Pipeline complete", {
          description: `Post ${postId?.slice(0, 8)}... is ready for export`,
          action: postId
            ? {
                label: "View",
                onClick: () => {
                  window.location.href = `/posts/${postId}`;
                },
              }
            : undefined,
        });
        break;
    }
  }, []);

  // Mounted from `providers.tsx`, which wraps every route including `/auth/*`.
  // `GET /api/events` is session-scoped, so opening the feed before sign-in
  // answers 401 and the hook's reconnect retries it forever. Gate on a
  // resolved session: a 401 here is not a transient failure.
  const { data: session, isPending } = authClient.useSession();

  useSSE(undefined, handleEvent, { enabled: !isPending && Boolean(session?.user) });

  return null;
};
