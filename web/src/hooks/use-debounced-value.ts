"use client";

import { useEffect, useState } from "react";

/**
 * The value, held back until it has stopped changing for `delayMs`.
 *
 * Every search box on a list here drives a server request through the effect
 * that reads it, so a typed word was one request per keystroke: five requests
 * for `bread`, four of them already superseded by the time they answered. The
 * caller reads the raw value for what it shows the typist and this one for
 * what it asks the server.
 *
 * The first value is not held back, so a mount does not wait `delayMs` for its
 * first read.
 */
/**
 * How long a search box waits for the typist to stop before it asks the
 * server. One value for every list here so the three of them feel the same.
 */
export const SEARCH_DEBOUNCE_MS = 300;

export function useDebouncedValue<T>(value: T, delayMs: number): T {
  const [settled, setSettled] = useState(value);

  useEffect(() => {
    const timer = setTimeout(() => setSettled(value), delayMs);
    return () => clearTimeout(timer);
  }, [value, delayMs]);

  return settled;
}
