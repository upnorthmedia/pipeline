"use client";

import { useEffect, useRef, useState } from "react";
import { sseUrl } from "@/lib/api";

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
  "review_needed",
  "stage_review",
  "pipeline_complete",
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

    function handleData(data: SSEEvent) {
      setLastEvent(data);
      callbackRef.current?.(data);
    }

    function open() {
      if (disposed) return;
      source = new EventSource(url);

      source.onopen = () => setConnected(true);

      source.onmessage = (e) => {
        try {
          handleData(JSON.parse(e.data));
        } catch {
          // keepalive
        }
      };

      for (const eventType of NAMED_EVENTS) {
        source.addEventListener(eventType, (e) => {
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
