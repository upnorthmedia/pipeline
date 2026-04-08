"use client";

import { useSSE, type SSEEvent } from "@/hooks/use-sse";
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

  useSSE(undefined, handleEvent);

  return null;
};
