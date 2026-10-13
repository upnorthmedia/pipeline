/**
 * The `posts.execution_logs` writer, ported from `append_execution_log()` in
 * `api/src/pipeline/helpers.py`.
 *
 * This column is the run's own audit trail: the same events the dashboard
 * receives over SSE, but kept on the row so a browser that was not open while
 * the run executed can still read what happened. `GET /api/posts/{id}/logs`
 * and `GET /api/analytics/logs` both read it, and the analytics query orders
 * and filters on the entries' `ts` in SQL, which is why the timestamp's exact
 * shape is part of the contract rather than a detail (see `nowIso` below).
 *
 * Kept out of `post-state.ts`, which owns the columns that describe where a run
 * is. This one describes what a run did, is append-only, and has a wire shape
 * two route handlers already parse.
 */
import { eq, sql } from "drizzle-orm"

import { getDb, posts } from "../db"
import { pythonRound } from "./analytics/python-round"
import { MODEL_COSTS } from "./model-costs"
import type { Stage } from "./state"

/**
 * The three values Python passed, and the ones `GET /logs` filters on. A
 * narrower type than Python's bare `str` because every call site in the port is
 * in this repository; nothing accepts a level from a client.
 */
export type LogLevel = "info" | "warning" | "error"

/**
 * One entry, minus the timestamp the writer stamps.
 *
 * An object rather than Python's five positional strings: `(post_id, stage,
 * level, event, message)` is four interchangeable strings in a row, and
 * transposing two of them is a silent defect that only shows up as a log line
 * nobody filters correctly.
 *
 * `stage` is `""` for the two entries that are about the run rather than about
 * a stage, which is the empty string Python passed for `pipeline_start` and
 * `pipeline_complete`.
 */
export interface ExecutionLogEntry {
  stage: Stage | ""
  level: LogLevel
  /** The event name, which is the SSE event name for the entries that have one. */
  event: string
  message: string
  /** Omitted from the stored entry when absent or empty, per Python's `if data:`. */
  data?: Record<string, unknown>
}

/**
 * Python's `datetime.now(UTC).isoformat()`, which is what the existing rows in
 * this column carry.
 *
 * The offset form matters and the precision does not. `api/src/api/analytics.py`
 * compares `log_entry->>'ts'` against a `since`/`until` bound and orders by it,
 * both as plain string comparisons in SQL, so entries written by the two stacks
 * have to sort against each other. `toISOString()` ends in `Z`, which sorts
 * above every digit and above `+`, so a `Z` entry would sort after every
 * `+00:00` entry recorded in the same second. Rewriting the suffix removes
 * that.
 *
 * JavaScript's clock is milliseconds where Python's is microseconds, so a
 * TypeScript entry has three fractional digits against Python's six. That is
 * left as it is rather than padded with zeros: the padding would claim
 * precision the runtime does not have, and its only effect on the string
 * comparison is to move an entry within the millisecond it was already in.
 *
 * Exported because `publishStageLog()` stamps the same shape into its SSE
 * payload's `timestamp`: Python called `datetime.now(UTC).isoformat()` in both
 * places, so an entry and the event announcing it carry the same rendering of
 * the clock even though they read it twice.
 */
export function nowIso(): string {
  return new Date().toISOString().replace("Z", "+00:00")
}

/**
 * Append one entry to a post's `execution_logs`.
 *
 * The append is done in SQL, as `execution_logs || '[entry]'::jsonb`, which is
 * Python's statement and Python's reason for it: a read-modify-write over this
 * column loses whatever another stage appended between the read and the write,
 * and a full pipeline run has six stages plus the run's own bookkeeping all
 * writing to the one array. `coalesce` is not needed and Python did not use it,
 * because the column is `NOT NULL DEFAULT '[]'`.
 *
 * `updated_at` is deliberately not stamped. Python issued this as raw
 * `text(...)` SQL, which bypasses SQLAlchemy's `onupdate`, so appending a log
 * line never moved the post in the dashboard's "recently updated" ordering.
 * Stamping it here would make every run reorder the posts list six times per
 * stage for entries no reader treats as a change to the post.
 *
 * Throws on a database error rather than swallowing it, as Python's did: the
 * one call site that wanted a failure to be non-fatal wrapped it itself, and
 * that wrapper is `publish_stage_log()`.
 */
export async function appendExecutionLog(
  postId: string,
  entry: ExecutionLogEntry,
): Promise<void> {
  const stored: Record<string, unknown> = {
    ts: nowIso(),
    stage: entry.stage,
    level: entry.level,
    event: entry.event,
    message: entry.message,
  }
  // Python's `if data:`, which is false for an empty dict as well as for None,
  // so a stage with no meta stored no `data` key at all rather than an empty
  // object.
  if (entry.data && Object.keys(entry.data).length > 0) stored.data = entry.data

  await getDb()
    .update(posts)
    .set({
      executionLogs: sql`${posts.executionLogs} || ${JSON.stringify([stored])}::jsonb`,
    })
    .where(eq(posts.id, postId))
}

/**
 * Price one stage's token counts, for the `cost_usd` on its `stage_complete`
 * entry.
 *
 * `api/src/worker.py:244` hardcoded 15.0 and 75.0 here, which are Anthropic's
 * Opus prices, and applied them to every stage: the Perplexity call in
 * `research` and the Gemini calls in `images` were both billed as Opus in what
 * `GET /api/analytics/logs` and the run trace report. The port reproduced that
 * verbatim and it is ledger item P2.38. The rates now come from `MODEL_COSTS`,
 * keyed by the model the stage reported, which is the table Python's own
 * per-model pricer used and the same one `GET /api/analytics/costs` ships as
 * `model_costs_reference`, so the number a stage is priced at and the number
 * the dashboard says it was priced at agree.
 *
 * A model with no row prices at zero, which is Python's
 * `MODEL_COSTS.get(model, {"input": 0.0, "output": 0.0})` and the honest answer
 * for a rate nobody has published: the alternative is to invent one, which is
 * exactly what the Opus constants did. `model-costs.test.ts` keeps that from
 * mattering in practice by failing when a model on `STAGE_MODEL_ALLOWLIST` has
 * no price. It does still mean a provider that starts echoing a model id the
 * table does not carry reports $0.00 rather than a wrong number; the entry
 * stores the id it priced against beside the cost, so the two are checkable.
 *
 * Historical entries are untouched: this column is append-only and every row
 * already in it keeps the number it was written with.
 *
 * `reportedCostUsd` is a price the provider itself put on the call, and it
 * wins when there is one. Only Perplexity's Agent API reports one today, and
 * it is the only provider here whose bill this table cannot reconstruct:
 * `web_search` is charged per invocation on top of the tokens, so on the
 * recorded grounded call the table's $0.001553 is a 2.6x understatement of a
 * $0.00405 bill. Adding a per-invocation fee column instead would mean
 * counting tool calls here and guessing a rate, when the answer is in the
 * response. A reported `0` is a measurement and is used; only `undefined`
 * means nothing was reported. Ledger item P2.71b-ii.
 */
export function stageCostUsd(
  tokensIn: number,
  tokensOut: number,
  model: string,
  reportedCostUsd?: number,
): number {
  // Rounded like the estimate rather than passed through, so one stage cannot
  // carry more decimal places into a run total than the others.
  if (reportedCostUsd !== undefined) return pythonRound(reportedCostUsd, 6)
  const cost = MODEL_COSTS[model] ?? { input: 0, output: 0 }
  // Python's `round(..., 6)` over the same two terms in the same order.
  return pythonRound(
    (tokensIn / 1_000_000) * cost.input + (tokensOut / 1_000_000) * cost.output,
    6,
  )
}
