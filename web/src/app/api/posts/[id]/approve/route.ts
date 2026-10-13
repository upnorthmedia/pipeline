/**
 * `POST /api/posts/{post_id}/approve`: release the run this post is parked on.
 *
 * There is no Python original. Its pipeline had no resume at all: a gated stage
 * was a bare `return`, and the only way forward the dashboard offered started a
 * *new* run, which redid the chain and left the parked one in
 * `mastra_workflow_snapshot` forever. Ledger item P2.109 is that gap, and this
 * is the route half of it.
 *
 * Ordering, all of it load-bearing:
 *
 * 1. Ownership first, through the same inner join every other post route uses,
 *    so a run parked for somebody else is a 404 and not a 409 that would
 *    confirm the post exists.
 * 2. The resume second. Everything that can reject it for a reason the user
 *    caused happens before the engine publishes, so a rejection here is a real
 *    error and not a slow run.
 * 3. The row third, and only if the resume was accepted. `stage_status` still
 *    says `review` until the worker picks the run up, and the dashboard reads
 *    the row rather than the snapshot, so without this write the reviewer's
 *    next poll tells them their approval did nothing.
 *
 * 202, not 200: what was accepted is the resume, and the stage it releases runs
 * in the worker for minutes afterwards.
 */
import { and, eq } from "drizzle-orm"

import { getDb, posts, websiteProfiles } from "@/db"
import { getRequestUser, unauthorized } from "@/lib/request-auth"
import { withServerError } from "@/lib/route-error"
import { approvePipelineGate } from "@/mastra/approve-gate"
import { releaseStageFromReview } from "@/mastra/post-state"

import { isUuid, postNotFound, unprocessableUuid } from "../../params"

/**
 * Nothing is waiting. A second click on the same approval looks exactly like
 * this, and so does a post whose gate was released from another tab, so the
 * message names the state rather than accusing the caller of an error.
 */
function nothingWaiting(): Response {
  return Response.json(
    { detail: "This post is not waiting for approval." },
    { status: 409 },
  )
}

async function postHandler(
  request: Request,
  { params }: { params: Promise<{ id: string }> },
): Promise<Response> {
  const user = await getRequestUser(request)
  if (!user) return unauthorized()

  const { id } = await params
  if (!isUuid(id)) return unprocessableUuid(id)

  const db = getDb()
  const rows = await db
    .select({ id: posts.id })
    .from(posts)
    .innerJoin(websiteProfiles, eq(posts.profileId, websiteProfiles.id))
    .where(and(eq(posts.id, id), eq(websiteProfiles.userId, user.id)))
    .limit(1)

  if (rows.length === 0) return postNotFound()

  const gate = await approvePipelineGate(rows[0].id)
  if (!gate) return nothingWaiting()

  await releaseStageFromReview(rows[0].id, gate.stage)

  return Response.json(
    { status: "approved", stage: gate.stage, mode: gate.mode, post_id: rows[0].id },
    { status: 202 },
  )
}

export const POST = withServerError(postHandler)
