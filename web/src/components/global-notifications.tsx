"use client";

import { useSSE, type SSEEvent } from "@/hooks/use-sse";
import { authClient } from "@/lib/auth-client";
import { stageLabel } from "@/lib/stages";
import { usePathname } from "next/navigation";
import { toast } from "sonner";
import { useCallback } from "react";

/**
 * What the toast calls the post it is about, or nothing.
 *
 * This used to be the first eight characters of the post's uuid, a value no
 * reader has ever seen and which read "Post undefined..." on any frame that
 * carried no id. The endpoint now puts the post's `topic` on every frame
 * (`src/app/api/events/scope.ts`), so the toast can name the post the way the
 * posts list does. A frame without one says nothing rather than guessing:
 * `toast()` omits the description entirely when it is `undefined`.
 */
function describePost(event: SSEEvent): string | undefined {
  return event.topic || undefined;
}

/** The post, then what went wrong, with whichever of the two is known. */
function describeFailure(event: SSEEvent): string | undefined {
  const post = describePost(event);
  const reason = typeof event.error === "string" && event.error.length > 0 ? event.error : undefined;
  if (post && reason) return `${post}: ${reason}`;
  return post ?? reason;
}

export const GlobalNotifications = () => {
  // The route the reader is on. A "View" button pointing at the page they are
  // already looking at is an action that does nothing, and this component is
  // mounted on every route, the post's own page included.
  const pathname = usePathname();

  const handleEvent = useCallback(
    (event: SSEEvent) => {
      // The stage the event names, in the words every other surface uses. A
      // frame that carries no stage is not attributed to one: "unknown complete"
      // said less than saying nothing.
      const stage = event.stage ? stageLabel(event.stage) : "Stage";
      const postId = event.post_id;
      const action =
        postId && pathname !== `/posts/${postId}`
          ? {
              label: "View",
              onClick: () => {
                window.location.href = `/posts/${postId}`;
              },
            }
          : undefined;

      switch (event.event) {
        case "stage_complete":
          toast.success(`${stage} complete`, {
            description: describePost(event),
            action,
          });
          break;

        // A parked run is the one event that is waiting on the reader. The
        // action carries them to the page that can release it, which is what
        // makes the toast worth raising away from that page.
        case "stage_review":
          toast.info(`${stage} is waiting for your approval`, {
            description: describePost(event),
            action,
          });
          break;

        case "stage_error":
          toast.error(`${stage} failed`, {
            description: describeFailure(event),
            action,
          });
          break;

        case "pipeline_complete": {
          const post = describePost(event);
          toast.success("Pipeline complete", {
            description: post ? `${post} is ready for export` : "Ready for export",
            action,
          });
          break;
        }
      }
    },
    [pathname],
  );

  // Mounted from `providers.tsx`, which wraps every route including `/auth/*`.
  // `GET /api/events` is session-scoped, so opening the feed before sign-in
  // answers 401 and the hook's reconnect retries it forever. Gate on a
  // resolved session: a 401 here is not a transient failure.
  const { data: session, isPending } = authClient.useSession();

  useSSE(undefined, handleEvent, { enabled: !isPending && Boolean(session?.user) });

  return null;
};
