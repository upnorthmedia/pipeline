/**
 * The `text/event-stream` wire format the two `/api/events` handlers write,
 * ported from what `sse_starlette` 3.2.0 put on the socket for
 * `EventSourceResponse` in `api/src/api/events.py`.
 *
 * Python never built these bytes itself: it yielded `{"event": ..., "data": ...}`
 * dicts and `ServerSentEvent.encode()` framed them. Replacing that library with
 * a Next.js `ReadableStream` means the framing is now this repo's job, so the
 * three details that are load-bearing are pinned here rather than left to a
 * template literal at each call site:
 *
 * - **`\r\n`, not `\n`.** `EventSourceResponse.DEFAULT_SEPARATOR` is `"\r\n"`
 *   and the module only accepts `\r\n`, `\r` or `\n`. The spec treats all three
 *   as line terminators so a browser cannot tell, but a test that asserts on
 *   raw bytes can, and keeping the byte stream identical is what makes such a
 *   test meaningful.
 * - **The blank line terminates the event.** `encode()` writes one trailing
 *   separator after the last field; without it `EventSource` buffers the event
 *   forever and `use-sse.ts` looks connected while receiving nothing.
 * - **Data is split on line breaks into repeated `data:` lines.** The payloads
 *   here are `JSON.stringify` output, which contains no raw newline, but the
 *   splitting is what makes that safe rather than accidental.
 */

/** `EventSourceResponse.DEFAULT_SEPARATOR`. */
export const SSE_SEPARATOR = "\r\n"

/** `EventSourceResponse.DEFAULT_PING_INTERVAL`, in milliseconds. */
export const SSE_PING_INTERVAL_MS = 15_000

/**
 * The response headers `EventSourceResponse` set.
 *
 * `Content-Type` gains the charset the same way Starlette's `init_headers()`
 * appends one for any `text/*` media type. `X-Accel-Buffering: no` is the one
 * that matters in deployment: without it an nginx in front of the app buffers
 * the stream and the dashboard receives a run's events all at once when it
 * finishes.
 */
export const SSE_HEADERS: Record<string, string> = {
  "Content-Type": "text/event-stream; charset=utf-8",
  "Cache-Control": "no-store",
  Connection: "keep-alive",
  "X-Accel-Buffering": "no",
}

/** Strips the line breaks `encode()` removes from a field that cannot wrap. */
function singleLine(value: string): string {
  return value.replace(/\r\n|\r|\n/g, "")
}

/**
 * One named event: an optional `id: <id>`, then `event: <name>`, then one
 * `data:` line per line of `data`, then the blank line that ends the frame.
 *
 * The field order and the omission of `id:` when no id is given are
 * `ServerSentEvent.encode()`'s, which writes `id` before `event` and guards it
 * with `if self.id is not None`. Python never passed one, so no frame this port
 * replaces carried an id; the argument exists because the replay anchor of
 * ledger item 5.5e has to travel on the wire somewhere, and `id:` is the field
 * `EventSource` already tracks and echoes back as `Last-Event-ID`.
 */
export function encodeSseEvent(name: string, data: unknown, id?: string): string {
  const body = JSON.stringify(data)
  const lines = body.split(/\r\n|\r|\n/)
  return (
    (id === undefined ? "" : `id: ${singleLine(id)}${SSE_SEPARATOR}`) +
    `event: ${singleLine(name)}${SSE_SEPARATOR}` +
    lines.map((line) => `data: ${line}${SSE_SEPARATOR}`).join("") +
    SSE_SEPARATOR
  )
}

/**
 * The keepalive comment `EventSourceResponse._ping()` emitted every 15s.
 *
 * Deviation, deliberate: Python interpolated `datetime.now(timezone.utc)`,
 * whose `str()` is `2026-08-22 12:34:56.789012+00:00`, and this writes the ISO
 * 8601 form instead. The line is an SSE comment, so `EventSource` discards it
 * before any listener runs and `use-sse.ts` never sees either spelling; what
 * the frame is for is keeping proxies from timing an idle connection out.
 */
export function encodeSsePing(now: Date): string {
  return `: ping - ${now.toISOString()}${SSE_SEPARATOR}${SSE_SEPARATOR}`
}
