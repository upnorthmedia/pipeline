/**
 * Port of `GET /api/posts/{post_id}/export/markdown` in `api/src/api/posts.py`.
 *
 * `ready_content` wins over `final_md_content`, which is the same preference
 * `ExportButton` already applies client-side; when neither column holds
 * anything the answer is a 404 with its own detail string, distinct from the
 * "Post not found" the ownership lookup raises. Note that `or` treats an empty
 * string as absent, so a post whose `ready_content` is `""` falls through to
 * `final_md_content` rather than exporting nothing.
 *
 * The body is the stripped, URL-rewritten markdown, served as a `.mdx`
 * attachment named after the post's slug. Starlette appends `charset=utf-8` to
 * any `text/*` media type, so the content type is spelled out here in full.
 */
import { and, eq } from "drizzle-orm"

import { getDb, posts, websiteProfiles } from "@/db"
import { getRequestUser, unauthorized } from "@/lib/request-auth"

import { rewriteMediaUrls, stripLeadingH1 } from "../../../export-content"
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
    .select({
      slug: posts.slug,
      readyContent: posts.readyContent,
      finalMdContent: posts.finalMdContent,
    })
    .from(posts)
    .innerJoin(websiteProfiles, eq(posts.profileId, websiteProfiles.id))
    .where(and(eq(posts.id, id), eq(websiteProfiles.userId, user.id)))
    .limit(1)

  if (rows.length === 0) return postNotFound()
  const post = rows[0]

  const content = post.readyContent || post.finalMdContent
  if (!content) {
    return Response.json({ detail: "No markdown content available" }, { status: 404 })
  }

  return new Response(rewriteMediaUrls(stripLeadingH1(content), id), {
    status: 200,
    headers: {
      "Content-Type": "text/markdown; charset=utf-8",
      "Content-Disposition": `attachment; filename="${post.slug}.mdx"`,
    },
  })
}
