/**
 * Port of `POST /api/posts/{post_id}/publish` in `api/src/api/posts.py`
 * (ledger items 5.3c-iii-b-1-d and 5.3c-iii-b-2-e).
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
 * `wordpressPublishStep` and `nextjsPublishStep` set from inside the run, so
 * the row spends the time between this response and the worker picking the
 * event up saying `pending`. That is what the dashboard rendered before the
 * port.
 *
 * Both branches write their own column and leave the other one alone, which is
 * what Python did: a post can carry a `wp_publish_status` from an earlier
 * WordPress run and still publish to Next.js without disturbing it.
 *
 * The trailing refusal answers three different situations and says which one
 * it is, because the person reading it has to decide something different in
 * each. Python interpolated the raw column value into one sentence naming the
 * column, which told a user nothing they could act on. The `both` case it was
 * written for is no longer storable: `../../../output-format.ts` closed the
 * vocabulary at the write boundaries, so the only rows that reach the last
 * branch are ones written before `drizzle/0003` ran (ledger item P2.68).
 *
 * Deviation shared with `/pause` and the other control endpoints: `updated_at`
 * is hand-stamped, where SQLAlchemy's `onupdate` emitted no `UPDATE` at all
 * when the assigned value matched the loaded one. Publishing an already
 * `pending` post bumps `updated_at` here and did not in Python.
 */
import { and, eq } from "drizzle-orm"

import { getDb, posts, websiteProfiles } from "@/db"
import { getRequestUser, unauthorized } from "@/lib/request-auth"
import { withServerError } from "@/lib/route-error"
import { startNextjsPublish } from "@/mastra/start-nextjs-publish"
import { startWordPressPublish } from "@/mastra/start-wordpress-publish"

import { isUuid, ownedByCaller, postNotFound, unprocessableUuid } from "../../params"
import { badRequest } from "../../run-control"

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

  if (post.outputFormat === "nextjs") {
    await db
      .update(posts)
      .set({ nextjsPublishStatus: "pending", updatedAt: new Date() })
      .where(ownedByCaller(id, user.id))

    await startNextjsPublish(post.id)

    return Response.json({ status: "queued", post_id: post.id }, { status: 202 })
  }

  if (post.outputFormat === "markdown") {
    // Not a misconfiguration: the format does what it says, and the post page
    // has the button that does it.
    return badRequest(
      "This post's output format is Markdown, which is exported rather than published. " +
        "Use Export to download it.",
    )
  }

  // The column is nullable, and an empty string reads as unset everywhere else
  // in the app, so both take the same sentence.
  if (!post.outputFormat) {
    return badRequest("This post has no output format, so there is nowhere to publish it.")
  }

  return badRequest(
    `This post's output format, "${post.outputFormat}", is not one this app can publish.`,
  )
}

export const POST = withServerError(postHandler)
