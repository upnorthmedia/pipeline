"use client";

import { useEffect, useRef, useState } from "react";
import { sseUrl } from "@/lib/api";
import { LAST_EVENT_ID_PARAM } from "@/app/api/events/anchor";

export interface SSEEvent {
  event: string;
  post_id?: string;
  stage?: string;
  status?: string;
  content?: string;
  error?: string;
  [key: string]: unknown;
}

type SSECallback = (event: SSEEvent) => void;

const NAMED_EVENTS = [
  "stage_start",
  "stage_complete",
  "stage_error",
  "pipeline_complete",
  "publish_start",
  "publish_complete",
  "publish_error",
  "log",
] as const;

export function useSSE(postId?: string, onEvent?: SSECallback) {
  const [connected, setConnected] = useState(false);
  const [lastEvent, setLastEvent] = useState<SSEEvent | null>(null);
  const callbackRef = useRef(onEvent);
  useEffect(() => {
    callbackRef.current = onEvent;
  }, [onEvent]);

  useEffect(() => {
    const url = postId ? sseUrl.post(postId) : sseUrl.global();
    let source: EventSource | null = null;
    let reconnectTimer: ReturnType<typeof setTimeout> | null = null;
    let disposed = false;
    // The `id:` of the last frame this feed delivered, or "" before the first
    // one. It is scoped to the effect on purpose: a postId change is a
    // different filter over the same topic, and replaying the new post's
    // backlog from the old post's position would open the page on a flood of
    // events the user never asked to re-read.
    let lastEventId = "";

    function handleData(data: SSEEvent) {
      setLastEvent(data);
      callbackRef.current?.(data);
    }

    /**
     * Records the frame's position before anything else looks at it.
     *
     * This runs even for a frame whose `data` will not parse, which is what
     * `EventSource`'s own `Last-Event-ID` buffer does: the spec advances it
     * from the `id:` field, and a frame this hook cannot read is still a frame
     * the server does not need to send again.
     */
    function trackAnchor(e: MessageEvent) {
      if (e.lastEventId) lastEventId = e.lastEventId;
    }

    function open() {
      if (disposed) return;
      // A fresh `EventSource` sends no `Last-Event-ID` header: the browser only
      // sets it when it reconnects an object it already owns, and `onerror`
      // below closes this one and builds another. So the anchor has to travel
      // on the URL, which `requestAnchor()` reads as the fallback behind the
      // header.
      source = new EventSource(
        lastEventId
          ? `${url}${url.includes("?") ? "&" : "?"}${LAST_EVENT_ID_PARAM}=${encodeURIComponent(lastEventId)}`
          : url
      );

      source.onopen = () => setConnected(true);

      source.onmessage = (e) => {
        trackAnchor(e);
        try {
          handleData(JSON.parse(e.data));
        } catch {
          // keepalive
        }
      };

      for (const eventType of NAMED_EVENTS) {
        source.addEventListener(eventType, (e) => {
          trackAnchor(e as MessageEvent);
          try {
            const data: SSEEvent = JSON.parse((e as MessageEvent).data);
            data.event = eventType;
            handleData(data);
          } catch {
            // ignore
          }
        });
      }

      source.onerror = () => {
        setConnected(false);
        source?.close();
        source = null;
        if (!disposed) {
          reconnectTimer = setTimeout(open, 3000);
        }
      };
    }

    open();

    return () => {
      disposed = true;
      source?.close();
      source = null;
      if (reconnectTimer) clearTimeout(reconnectTimer);
      setConnected(false);
    };
  }, [postId]);

  return { connected, lastEvent };
}
