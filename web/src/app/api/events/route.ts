/**
 * Port of `GET /api/events` in `api/src/api/events.py`, the queue-wide SSE feed
 * `useSSE()` opens with no post id: `global-notifications.tsx` toasts from it
 * and the monitor's overview tab refreshes its counts from it.
 *
 * Python subscribed the request to `pipeline:global`, the second channel every
 * `publish_event()` call wrote to. There is one topic now and the per-post feed
 * is a filter on it (ledger 5.5a), so the global feed is that same topic with
 * the filter replaced by an ownership test rather than a different channel.
 *
 * **Deviation, deliberate, and the reason this endpoint was split out from the
 * per-post one:** `global_events()` took no parameters and no session, so every
 * caller received every tenant's pipeline. Scoping it is not a transcription,
 * because the endpoint has no single post to resolve: see `scope.ts` for why
 * ownership is resolved per event rather than snapshotted at connect time.
 */
import { getRequestUser, unauthorized } from "@/lib/request-auth"

import { ownedByUser } from "./scope"
import { pipelineEventStream } from "./stream"

export async function GET(request: Request): Promise<Response> {
  const user = await getRequestUser(request)
  if (!user) return unauthorized()

  return pipelineEventStream(request, ownedByUser(user.id))
}
