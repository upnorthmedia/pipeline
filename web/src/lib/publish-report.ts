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

/**
 * How long a publish may sit in `pending` or `publishing` before this app
 * stops calling it in flight.
 *
 * The number is `RECLAIM_IDLE_MS` in `src/mastra/index.ts`, and
 * `publish-stall-window.test.ts` fails if the two drift apart. That is the
 * idle time after which `RedisStreamsPubSub`'s reclaim loop `XAUTOCLAIM`s a
 * step message away from the consumer holding it, so inside the window a
 * publish that has gone quiet may still be running, or about to be
 * re-delivered to a worker that will finish it. Past the window either no
 * worker is alive to reclaim it or the reclaimed copy went quiet too, and in
 * both cases nothing is going to move the row without the reader.
 */
export const PUBLISH_STALL_AFTER_MS = 15 * 60_000;

/**
 * The `ts` of the most recent `publish_start` entry, which is when a worker
 * last said it had this post in hand. Null when no worker ever said so.
 */
export function lastPublishStartAt(executionLogs: unknown): string | null {
  if (!Array.isArray(executionLogs)) return null;

  for (let i = executionLogs.length - 1; i >= 0; i--) {
    const entry = executionLogs[i];
    if (!isEntry(entry) || entry.event !== "publish_start") continue;
    const ts = entry.ts;
    if (typeof ts !== "string" || Number.isNaN(Date.parse(ts))) return null;
    return ts;
  }

  return null;
}

/** A publish attempt that stopped moving, and what the reader is told about it. */
export interface PublishStall {
  /** True once a worker announced it had the post, false while it was only queued. */
  started: boolean;
  /** The sentence the banner and the badge tooltip carry. */
  reason: string;
}

/**
 * Whether the publish this row is carrying has gone quiet, and why that
 * reads the way it does.
 *
 * The clock is the later of `updated_at`, stamped when the publish was asked
 * for, and the last `publish_start` entry, written when a worker picked it up.
 * Nothing in a publish stamps `updated_at` after the request (the step's own
 * writes and `appendExecutionLog` both leave it alone), so those two are the
 * whole record of when the attempt was last known to be moving, and taking the
 * later of them is what keeps a slow but live publish out of this branch for
 * the whole window rather than only for the queueing part of it.
 */
export function publishStall(input: {
  status: string | null | undefined;
  updatedAt: string | null | undefined;
  executionLogs: unknown;
  now: number;
}): PublishStall | null {
  if (input.status !== "pending" && input.status !== "publishing") return null;

  const requestedAt = typeof input.updatedAt === "string" ? Date.parse(input.updatedAt) : NaN;
  const startedRaw = lastPublishStartAt(input.executionLogs);
  const startedAt = startedRaw === null ? NaN : Date.parse(startedRaw);

  // A row with neither timestamp has no clock, so it cannot be called stalled:
  // saying so would put the banner on every publish whose `updated_at` failed
  // to serialise rather than on the ones that stopped.
  if (Number.isNaN(requestedAt) && Number.isNaN(startedAt)) return null;

  const lastMoved = Math.max(
    Number.isNaN(requestedAt) ? -Infinity : requestedAt,
    Number.isNaN(startedAt) ? -Infinity : startedAt,
  );
  if (input.now - lastMoved < PUBLISH_STALL_AFTER_MS) return null;

  // `publish_start` is written before the destination is touched and after the
  // status column moves to `publishing`, so the two agree on every row a
  // worker actually reached, and the column alone is what decides here: an
  // entry from an earlier attempt is older than `updated_at` and so cannot be
  // the value `lastMoved` came from.
  const started = !Number.isNaN(startedAt) && startedAt >= requestedAt;

  // The window is named rather than the elapsed time, so the sentence is the
  // same on every render of a page that keeps re-deriving it.
  const windowText = `${PUBLISH_STALL_AFTER_MS / 60_000} minutes`;

  return {
    started,
    reason: started
      ? `A worker picked this publish up and then stopped reporting on it for over ${windowText}, ` +
        "which usually means the worker died partway through. Nothing will move it on its own."
      : `This publish has been queued for over ${windowText} and no worker has picked it up, ` +
        "which usually means no worker is running. Nothing will move it on its own.",
  };
}
