"use client";

import { useCallback, useRef } from "react";

/**
 * A sequencer for a read that can be in flight more than once.
 *
 * Calling the returned function starts a request and invalidates every request
 * started before it. The handle it returns answers whether that request is
 * still the newest one, which is what a fetch has to ask before it writes
 * anything: two searches race, the older one answers last, and without this
 * the stale rows win because they were the last to call `setState`.
 */
export function useLatestRequest(): () => () => boolean {
  const sequence = useRef(0);

  return useCallback(() => {
    const id = ++sequence.current;
    return () => id === sequence.current;
  }, []);
}
