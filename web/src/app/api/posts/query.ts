/**
 * The query string of `GET /api/posts`, as FastAPI declared it.
 *
 * `Query(1, ge=1)` and `Query(50, ge=1, le=200)` were doing validation a route
 * handler does not get for free, and they answered a bad value with a 422
 * carrying pydantic's `int_parsing` / `greater_than_equal` /
 * `less_than_equal` shapes. Those are reproduced here, including FastAPI's
 * habit of reporting every bad parameter in one response rather than the first.
 */
import { posts } from "@/db"
import type { PgColumn } from "drizzle-orm/pg-core"

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

export interface ListPostsQuery {
  status: string | null
  stage: string | null
  profileId: string | null
  q: string | null
  sort: PgColumn
  order: string
  page: number
  perPage: number
}

interface QueryIssue {
  type: string
  loc: [string, string]
  msg: string
  input: string
  ctx?: Record<string, number>
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
 * Pydantic's lax int parsing for a query string: a bare integer, optionally
 * surrounded by whitespace and optionally signed. A float literal such as
 * `1.5` is `int_parsing`, not a truncation.
 */
function parseInt422(
  raw: string,
  name: string,
  fallback: number,
  ge: number,
  le: number | null,
  issues: QueryIssue[],
): number {
  if (!/^\s*[+-]?\d+\s*$/.test(raw)) {
    issues.push({
      type: "int_parsing",
      loc: ["query", name],
      msg: "Input should be a valid integer, unable to parse string as an integer",
      input: raw,
    })
    return fallback
  }
  const value = Number(raw.trim())
  if (value < ge) {
    issues.push({
      type: "greater_than_equal",
      loc: ["query", name],
      msg: `Input should be greater than or equal to ${ge}`,
      input: raw,
      ctx: { ge },
    })
    return fallback
  }
  if (le !== null && value > le) {
    issues.push({
      type: "less_than_equal",
      loc: ["query", name],
      msg: `Input should be less than or equal to ${le}`,
      input: raw,
      ctx: { le },
    })
    return fallback
  }
  return value
}

export function unprocessableQuery(issues: QueryIssue[]): Response {
  return Response.json({ detail: issues }, { status: 422 })
}

/**
 * Returns the parsed query, or a 422 `Response` when any parameter fails the
 * way FastAPI's would have.
 */
export function parseListPostsQuery(url: URL): ListPostsQuery | Response {
  const params = url.searchParams
  const issues: QueryIssue[] = []

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

  if (issues.length > 0) return unprocessableQuery(issues)

  const sort = params.get("sort") ?? "created_at"
  return {
    status: params.get("status"),
    stage: params.get("stage"),
    profileId,
    q: params.get("q"),
    sort: SORT_COLUMNS.get(sort) ?? posts.createdAt,
    order: params.get("order") ?? "desc",
    page,
    perPage,
  }
}

export { SORT_COLUMNS }
