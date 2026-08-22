/**
 * Port of `GET /api/queue/dead-letter` in `api/src/api/queue.py`.
 *
 * Python read a Redis list and returned it verbatim: `{entries, count}` with
 * `post_id`, `stage`, `error`, `attempts` and `failed_at` per entry, newest
 * first. The list is not ported (see `src/mastra/dead-letter.ts`); the entries
 * are read off Mastra's own failed run rows instead, which carry the same
 * facts and are written by the engine rather than by a second code path.
 *
 * Three deliberate deviations from Python, all closing holes rather than
 * transcribing them:
 *
 * - **The list is scoped to the caller.** Python's DLQ had no user dimension at
 *   all, so every authenticated user was shown every tenant's failures,
 *   including their post ids and error text. The entries are joined to `posts`
 *   through `website_profiles.user_id`, the same way every other Phase 5
 *   handler scopes. A run whose post has since been deleted, or which belongs
 *   to another user, is not reported.
 * - **`stage` is populated for a full pipeline run.** Python set it to
 *   `target_stages[0] if len(target_stages) == 1 else ""`, so the common case
 *   recorded nothing. The snapshot names the step that threw.
 * - **A retired entry drops out.** Item 5.4d-iii made `stage_logs._error` the
 *   acknowledgement Python's Redis list was, so a retried post's runs stop
 *   being listed even though their run rows survive. `listDeadLetterEntries`
 *   carries the reasoning.
 */
import { getRequestUser, unauthorized } from "@/lib/request-auth"
import { listDeadLetterEntries } from "@/mastra/dead-letter"
import { clearFailureMarkers } from "@/mastra/post-state"

export async function GET(request: Request): Promise<Response> {
  const user = await getRequestUser(request)
  if (!user) return unauthorized()

  const entries = (await listDeadLetterEntries(user.id)).map((run) => ({
    post_id: run.postId,
    stage: run.stage,
    error: run.error,
    attempts: run.attempts,
    failed_at: run.failedAt,
  }))

  return Response.json({ entries, count: entries.length })
}

/**
 * Port of `DELETE /api/queue/dead-letter` in `api/src/api/queue.py:202`.
 *
 * Python read `llen(DLQ_KEY)`, deleted the key and returned
 * `{status: "cleared", count}`. There is no key here, so clearing is retiring
 * the caller's entries: popping `_error` off each post that currently has one,
 * which is the same acknowledgement `POST /dead-letter/{post_id}/retry` makes,
 * minus the retry.
 *
 * Three consequences, all deliberate:
 *
 * - **The clear is scoped to the caller.** Python deleted one global list, so
 *   any authenticated user could wipe every tenant's dead-letter queue. Only
 *   posts reached through `website_profiles.user_id` are touched.
 * - **`current_stage` is untouched, and so is the run row.** A cleared post
 *   stays `failed` and keeps counting in `GET /api/queue`'s `failed` bucket,
 *   which is what Python's clear did too: it deleted a Redis list and never
 *   wrote a post. The failed run also stays in Mastra's storage, so the history
 *   Studio shows survives being acknowledged.
 * - **`count` is entries, not posts.** Python's `count` was the list length,
 *   which is exactly the `count` `GET` reported a moment earlier, so the same
 *   invariant is kept here: `DELETE` returns what `GET` would have. A post with
 *   two failed runs contributes two entries and one write, for the reason
 *   `listDeadLetterEntries` records.
 */
export async function DELETE(request: Request): Promise<Response> {
  const user = await getRequestUser(request)
  if (!user) return unauthorized()

  const entries = await listDeadLetterEntries(user.id)
  await clearFailureMarkers([...new Set(entries.map((entry) => entry.postId))])

  return Response.json({ status: "cleared", count: entries.length })
}
