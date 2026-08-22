/**
 * Port of `GET /api/posts/{post_id}/export/html` in `api/src/api/posts.py`.
 *
 * The simplest of the three exports: `final_html_content` verbatim, with no H1
 * strip and no media URL rewrite. Those two transformations exist to make an
 * MDX file portable into a blog repository, and the HTML export is pasted into
 * a CMS that still serves the images from this app, so Python applied neither.
 */
import { and, eq } from "drizzle-orm"

import { getDb, posts, websiteProfiles } from "@/db"
import { getRequestUser, unauthorized } from "@/lib/request-auth"

import { isUuid, postNotFound, unprocessableUuid } from "../../../params"

export async function GET(
  request: Request,
  { params }: { params: Promise<{ id: string }> },
): Promise<Response> {
  const user = await getRequestUser(request)
  if (!user) return unauthorized()

  const { id } = await params
  if (!isUuid(id)) return unprocessableUuid(id)

  const rows = await getDb()
    .select({ slug: posts.slug, finalHtmlContent: posts.finalHtmlContent })
    .from(posts)
    .innerJoin(websiteProfiles, eq(posts.profileId, websiteProfiles.id))
    .where(and(eq(posts.id, id), eq(websiteProfiles.userId, user.id)))
    .limit(1)

  if (rows.length === 0) return postNotFound()
  const post = rows[0]

  if (!post.finalHtmlContent) {
    return Response.json({ detail: "No HTML content available" }, { status: 404 })
  }

  return new Response(post.finalHtmlContent, {
    status: 200,
    headers: {
      "Content-Type": "text/html; charset=utf-8",
      "Content-Disposition": `attachment; filename="${post.slug}.html"`,
    },
  })
}
