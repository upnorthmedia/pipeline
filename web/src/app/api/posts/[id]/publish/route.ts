/**
 * Port of `POST /api/posts/{post_id}/publish` in `api/src/api/posts.py`, the
 * `output_format == "wordpress"` half of it (ledger item 5.3c-iii-b-1-d).
 *
 * Python's shape was three checks and an enqueue: resolve the post against the
 * caller, refuse a post with nothing to publish, then dispatch on
 * `output_format`. The order matters and is preserved, because the content
 * check runs before the format check: a `both`-format post with no content is
 * the "No content to publish" 400, not the unsupported-format one.
 *
 * `not post.ready_content and not post.final_md_content` is Python truthiness,
 * so a post whose `ready_content` is `""` falls through to `final_md_content`
 * rather than counting as content, which is the same rule the exports use.
 *
 * The status write is `pending`, not `publishing`: `publishing` is what
 * `wordpressPublishStep` sets from inside the run, so the row spends the time
 * between this response and the worker picking the event up saying `pending`.
 * That is what the dashboard rendered before the port.
 *
 * **The `nextjs` branch is not here yet.** Python had a second branch that
 * enqueued `publish_to_nextjs`, and the workflow behind it does not exist:
 * `api/src/services/nextjs_publish.py` is still Python-only. Until ledger item
 * 5.3c-iii-b-2 ports it, an `output_format` of `nextjs` takes the trailing 400
 * below with every other unsupported format. That is a known, temporary
 * divergence from Python and the only one in this handler.
 *
 * Deviation shared with `/pause` and the other control endpoints: `updated_at`
 * is hand-stamped, where SQLAlchemy's `onupdate` emitted no `UPDATE` at all
 * when the assigned value matched the loaded one. Publishing an already
 * `pending` post bumps `updated_at` here and did not in Python.
 */
import { and, eq } from "drizzle-orm"

import { getDb, posts, websiteProfiles } from "@/db"
import { getRequestUser, unauthorized } from "@/lib/request-auth"
import { startWordPressPublish } from "@/mastra/start-wordpress-publish"

import { isUuid, ownedByCaller, postNotFound, unprocessableUuid } from "../../params"
import { badRequest } from "../../run-control"

export async function POST(
  request: Request,
  { params }: { params: Promise<{ id: string }> },
): Promise<Response> {
  const user = await getRequestUser(request)
  if (!user) return unauthorized()

  const { id } = await params
  if (!isUuid(id)) return unprocessableUuid(id)

  const db = getDb()
  const rows = await db
    .select({
      id: posts.id,
      readyContent: posts.readyContent,
      finalMdContent: posts.finalMdContent,
      outputFormat: posts.outputFormat,
    })
    .from(posts)
    .innerJoin(websiteProfiles, eq(posts.profileId, websiteProfiles.id))
    .where(and(eq(posts.id, id), eq(websiteProfiles.userId, user.id)))
    .limit(1)

  if (rows.length === 0) return postNotFound()
  const post = rows[0]

  if (!post.readyContent && !post.finalMdContent) {
    return badRequest("No content to publish")
  }

  if (post.outputFormat === "wordpress") {
    await db
      .update(posts)
      .set({ wpPublishStatus: "pending", updatedAt: new Date() })
      .where(ownedByCaller(id, user.id))

    await startWordPressPublish(post.id)

    // `str(post_id)` was the *parsed* UUID, so it came back lowercase however
    // the client cased the path. Echo the stored id, which is that same form.
    return Response.json({ status: "queued", post_id: post.id }, { status: 202 })
  }

  // The column is nullable, and Python interpolated the value straight into
  // the message, so a row with a null `output_format` said `'None'`.
  const format = post.outputFormat === null ? "None" : post.outputFormat
  return badRequest(`Publishing not supported for output_format '${format}'`)
}
