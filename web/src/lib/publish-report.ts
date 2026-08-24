/**
 * What a finished publish attempt left behind, read off the post row.
 *
 * A publish runs in the worker, so the browser learns about it twice: once
 * live, through the `publish_error` event on the SSE stream, and once for
 * every page load after that, through `posts.execution_logs`. The event is
 * gone the moment it is delivered. The log entry is the only durable record,
 * and it is what a user who came back to the tab an hour later has.
 *
 * Both publish steps write that entry through `appendExecutionLog` with the
 * same shape and a prefix naming their destination, because the entry is also
 * served by `GET /api/posts/{id}/logs`, where the destination is not otherwise
 * visible. The screen showing the reason already knows which destination
 * failed, from the status column it is rendering, so the prefix is noise there
 * and comes off.
 */
import { plainMessage } from "@/lib/plain-message";

/**
 * `steps/wordpress-publish.ts` and `steps/nextjs-publish.ts` respectively. A
 * message carrying neither is kept whole rather than guessed at.
 */
const FAILURE_PREFIXES = ["WordPress publish failed: ", "Next.js publish failed: "];

function isEntry(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * The reason the most recent publish attempt failed, or null when there is no
 * such attempt on the row. Callers must gate on the publish status column:
 * a successful retry leaves the earlier failure's entry in place, and this
 * function has no way to tell that it has been superseded.
 */
export function lastPublishError(executionLogs: unknown): string | null {
  if (!Array.isArray(executionLogs)) return null;

  for (let i = executionLogs.length - 1; i >= 0; i--) {
    const entry = executionLogs[i];
    if (!isEntry(entry) || entry.event !== "publish_error") continue;

    const message = entry.message;
    if (typeof message !== "string") return null;

    const prefix = FAILURE_PREFIXES.find((candidate) => message.startsWith(candidate));
    const reason = plainMessage(prefix ? message.slice(prefix.length) : message);
    return reason.length > 0 ? reason : null;
  }

  return null;
}
