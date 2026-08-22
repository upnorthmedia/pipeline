/**
 * Port of `GET /api/posts/{post_id}/analytics` in `api/src/api/posts.py`.
 *
 * The computation itself is `compute_analytics`, already ported to
 * `web/src/mastra/analytics`; what lives here is the wiring the endpoint does
 * around it, all of which is easy to get wrong by reading:
 *
 * * the content is `final_md_content or draft_content or ""`. `ready_content`
 *   is deliberately not consulted, unlike the export endpoints, so the numbers
 *   describe the edited draft rather than the assembled article.
 * * `related_keywords[0]` is the primary keyword only when it is a string,
 *   otherwise the primary is empty; the remaining entries are the secondaries
 *   with the non-strings dropped. The two rules differ, so a list starting
 *   with a number loses its head without promoting the next entry.
 * * `topic` and `website_url` fall back to the empty string, which turns off
 *   the title check and the internal/external link split respectively.
 *
 * The response is the seven snake_case keys `PostAnalytics` in
 * `web/src/lib/api.ts` declares.
 */
import { and, eq } from "drizzle-orm"

import { getDb, posts, websiteProfiles } from "@/db"
import { getRequestUser, unauthorized } from "@/lib/request-auth"
import { computeAnalytics } from "@/mastra/analytics"

import { isUuid, postNotFound, unprocessableUuid } from "../../params"

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
      topic: posts.topic,
      websiteUrl: posts.websiteUrl,
      relatedKeywords: posts.relatedKeywords,
      draftContent: posts.draftContent,
      finalMdContent: posts.finalMdContent,
    })
    .from(posts)
    .innerJoin(websiteProfiles, eq(posts.profileId, websiteProfiles.id))
    .where(and(eq(posts.id, id), eq(websiteProfiles.userId, user.id)))
    .limit(1)

  if (rows.length === 0) return postNotFound()
  const post = rows[0]

  const keywords: unknown[] = Array.isArray(post.relatedKeywords) ? post.relatedKeywords : []
  const primaryKeyword = typeof keywords[0] === "string" ? keywords[0] : ""
  const secondaryKeywords = keywords.slice(1).filter((k): k is string => typeof k === "string")

  const analytics = computeAnalytics(post.finalMdContent || post.draftContent || "", {
    primaryKeyword,
    secondaryKeywords,
    title: post.topic || "",
    websiteUrl: post.websiteUrl || "",
  })

  return Response.json({
    word_count: analytics.wordCount,
    sentence_count: analytics.sentenceCount,
    paragraph_count: analytics.paragraphCount,
    avg_sentence_length: analytics.avgSentenceLength,
    flesch_reading_ease: analytics.fleschReadingEase,
    keyword_density: analytics.keywordDensity,
    seo_checklist: analytics.seoChecklist,
  })
}
