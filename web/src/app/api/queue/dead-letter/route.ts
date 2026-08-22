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
