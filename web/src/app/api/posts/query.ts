/**
 * The query string of `GET /api/posts`, as FastAPI declared it.
 *
 * `Query(1, ge=1)` and `Query(50, ge=1, le=200)` were doing validation a route
 * handler does not get for free, and they answered a bad value with a 422
 * carrying pydantic's `int_parsing` / `greater_than_equal` /
 * `less_than_equal` shapes. Those are reproduced here, including FastAPI's
 * habit of reporting every bad parameter in one response rather than the first.
 *
 * `awaiting_review` is the one parameter FastAPI never declared. It is the
 * server side of the dashboard's gate queue: `status` and `stage` both filter
 * `current_stage`, which says which stage a run reached and not whether it is
 * parked in front of a person, so neither can answer "what is waiting for me".
 * Only the literal string `true` turns it on, so a stray `awaiting_review=` or
 * `awaiting_review=0` leaves the list as it was rather than emptying it.
 */
import { posts } from "@/db"
import type { PgColumn } from "drizzle-orm/pg-core"

import { parseInt422, unprocessableRequest, type ValidationErrorDetail } from "../pydantic"

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

export interface ListPostsQuery {
  status: string | null
  stage: string | null
  /** Only the posts holding at a review gate. Not a Python parameter: see the header. */
  awaitingReview: boolean
  profileId: string | null
  q: string | null
  sort: PgColumn
  order: string
  page: number
  perPage: number
}

/**
 * `getattr(Post, sort, Post.created_at)` accepted any mapped column name and
 * fell back to `created_at` for anything else, so the accepted set is exactly
 * the mapper's column attributes. A handful of non-column attribute names
 * (`metadata`, `registry`, the `profile` relationship) instead raised inside
 * SQLAlchemy and surfaced as a 500; here they take the `created_at` fallback
 * with the rest, which removes an error path rather than adding one.
 */
const SORT_COLUMNS = new Map<string, PgColumn>([
  ["profile_id", posts.profileId],
  ["slug", posts.slug],
  ["topic", posts.topic],
  ["target_audience", posts.targetAudience],
  ["niche", posts.niche],
  ["intent", posts.intent],
  ["word_count", posts.wordCount],
  ["tone", posts.tone],
  ["output_format", posts.outputFormat],
  ["website_url", posts.websiteUrl],
  ["related_keywords", posts.relatedKeywords],
  ["competitor_urls", posts.competitorUrls],
  ["image_style", posts.imageStyle],
  ["image_brand_colors", posts.imageBrandColors],
  ["image_exclude", posts.imageExclude],
  ["brand_voice", posts.brandVoice],
  ["avoid", posts.avoid],
  ["required_mentions", posts.requiredMentions],
  ["article_type", posts.articleType],
  ["additional_info", posts.additionalInfo],
  ["research_content", posts.researchContent],
  ["outline_content", posts.outlineContent],
  ["draft_content", posts.draftContent],
  ["final_md_content", posts.finalMdContent],
  ["final_html_content", posts.finalHtmlContent],
  ["image_manifest", posts.imageManifest],
  ["ready_content", posts.readyContent],
  ["wp_category_id", posts.wpCategoryId],
  ["wp_author_id", posts.wpAuthorId],
  ["wp_post_id", posts.wpPostId],
  ["wp_post_url", posts.wpPostUrl],
  ["wp_publish_status", posts.wpPublishStatus],
  ["nextjs_publish_status", posts.nextjsPublishStatus],
  ["nextjs_published_at", posts.nextjsPublishedAt],
  ["stage_logs", posts.stageLogs],
  ["execution_logs", posts.executionLogs],
  ["current_stage", posts.currentStage],
  ["stage_settings", posts.stageSettings],
  ["stage_status", posts.stageStatus],
  ["priority", posts.priority],
  ["completed_at", posts.completedAt],
  ["id", posts.id],
  ["created_at", posts.createdAt],
  ["updated_at", posts.updatedAt],
])

/**
 * Returns the parsed query, or a 422 `Response` when any parameter fails the
 * way FastAPI's would have.
 */
export function parseListPostsQuery(url: URL): ListPostsQuery | Response {
  const params = url.searchParams
  const issues: ValidationErrorDetail[] = []

  const profileId = params.get("profile_id")
  if (profileId !== null && !UUID_PATTERN.test(profileId)) {
    issues.push({
      type: "uuid_parsing",
      loc: ["query", "profile_id"],
      msg: "Input should be a valid UUID",
      input: profileId,
    })
  }

  const rawPage = params.get("page")
  const page = rawPage === null ? 1 : parseInt422(rawPage, "page", 1, 1, null, issues)
  const rawPerPage = params.get("per_page")
  const perPage =
    rawPerPage === null ? 50 : parseInt422(rawPerPage, "per_page", 50, 1, 200, issues)

  if (issues.length > 0) return unprocessableRequest(issues)

  const sort = params.get("sort") ?? "created_at"
  return {
    status: params.get("status"),
    stage: params.get("stage"),
    awaitingReview: params.get("awaiting_review") === "true",
    profileId,
    q: params.get("q"),
    sort: SORT_COLUMNS.get(sort) ?? posts.createdAt,
    order: params.get("order") ?? "desc",
    page,
    perPage,
  }
}

export { SORT_COLUMNS }
