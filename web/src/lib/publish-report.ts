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
import type { PublishTarget } from "@/lib/publishing";

/**
 * Every message prefix the two publish steps write, and the destination each
 * one names. It is a table rather than two lists because the prefix is also
 * the only thing that identifies the destination on an entry stored before
 * those steps began writing `data.target`, and a row can carry entries from
 * both destinations: nothing clears the other one's status column.
 *
 * A message carrying no prefix is kept whole rather than guessed at.
 */
const MESSAGE_PREFIXES: { prefix: string; target: PublishTarget; failure: boolean }[] = [
  { prefix: "WordPress publish failed: ", target: "wordpress", failure: true },
  { prefix: "Next.js publish failed: ", target: "nextjs", failure: true },
  { prefix: "Published to WordPress: ", target: "wordpress", failure: false },
  { prefix: "Publishing to WordPress...", target: "wordpress", failure: false },
];

const FAILURE_PREFIXES = MESSAGE_PREFIXES.filter((row) => row.failure).map((row) => row.prefix);

/**
 * The destination a stored entry names, read off its message. Only for the
 * entries that predate `data.target`; a caller with that field should prefer
 * it, since it is the step's own word rather than a prefix match.
 */
export function publishTargetOfMessage(message: unknown): PublishTarget | null {
  if (typeof message !== "string") return null;
  return MESSAGE_PREFIXES.find((row) => message.startsWith(row.prefix))?.target ?? null;
}

/**
 * One `publish_error` message as a reason a person can read: the destination
 * prefix off the front, because the screen showing it already says where the
 * publish was going, and WordPress's markup decoded by `plainMessage`.
 */
export function publishFailureReason(message: unknown): string | null {
  if (typeof message !== "string") return null;
  const prefix = FAILURE_PREFIXES.find((candidate) => message.startsWith(candidate));
  const reason = plainMessage(prefix ? message.slice(prefix.length) : message);
  return reason.length > 0 ? reason : null;
}

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
    return publishFailureReason(entry.message);
  }

  return null;
}
