/**
 * The wire shape of a post, shared by every ported post handler.
 *
 * This is `PostRead` from `api/src/models/schemas.py`, which the dashboard
 * consumes as the `Post` interface in `web/src/lib/api.ts`. Two facts about
 * that interface were stale and are corrected alongside this port: `PostRead`
 * has never declared `thread_id` (Alembic 005 dropped the column), and it has
 * always declared `execution_logs`, which the interface was missing.
 */
import type { StageSettingsJson, StageStatusJson, posts } from "@/db"

import { toPydanticIso } from "../pydantic"

type PostRow = typeof posts.$inferSelect

export interface PostResponse {
  slug: string
  topic: string
  profile_id: string | null
  target_audience: string | null
  niche: string | null
  intent: string | null
  word_count: number
  tone: string
  output_format: string
  website_url: string | null
  related_keywords: string[]
  competitor_urls: string[]
  image_style: string | null
  image_brand_colors: string[]
  image_exclude: string[]
  brand_voice: string | null
  avoid: string | null
  required_mentions: string | null
  article_type: string | null
  additional_info: string | null
  stage_settings: StageSettingsJson
  id: string
  current_stage: string
  stage_status: StageStatusJson
  stage_logs: Record<string, unknown>
  execution_logs: Record<string, unknown>[]
  priority: number
  research_content: string | null
  outline_content: string | null
  draft_content: string | null
  final_md_content: string | null
  final_html_content: string | null
  image_manifest: Record<string, unknown> | null
  ready_content: string | null
  wp_category_id: number | null
  wp_author_id: number | null
  wp_post_id: number | null
  wp_post_url: string | null
  wp_publish_status: string | null
  nextjs_publish_status: string | null
  nextjs_published_at: string | null
  created_at: string | null
  updated_at: string | null
  completed_at: string | null
}

/**
 * `PostBase.stage_settings`'s pydantic default. Like the profile one it is not
 * the column's server default, which Alembic wrote as a five-key `"review"`
 * map.
 */
const DEFAULT_STAGE_SETTINGS: StageSettingsJson = {
  research: "auto",
  outline: "auto",
  write: "auto",
  edit: "auto",
  images: "auto",
  ready: "auto",
}

/**
 * A field `PostRead` declared non-optional falls back to its pydantic default
 * when the column is null.
 *
 * This is a deliberate, narrow divergence. Pydantic does not substitute a
 * default for an attribute that is present and `None`: it raises, so FastAPI
 * answered such a row with a 500 rather than a `PostRead`. Every one of these
 * columns carries a server default, so only a row written with an explicit
 * null reaches the branch, and returning the declared default is strictly more
 * useful than a 500. `created_at`/`updated_at` are the exception: pydantic
 * required them and there is no default to invent, so the null carries through.
 */
export function serializePost(row: PostRow): PostResponse {
  return {
    slug: row.slug,
    topic: row.topic,
    profile_id: row.profileId,
    target_audience: row.targetAudience,
    niche: row.niche,
    intent: row.intent,
    word_count: row.wordCount ?? 2000,
    tone: row.tone ?? "Conversational and friendly",
    output_format: row.outputFormat ?? "markdown",
    website_url: row.websiteUrl,
    related_keywords: row.relatedKeywords ?? [],
    competitor_urls: row.competitorUrls ?? [],
    image_style: row.imageStyle,
    image_brand_colors: row.imageBrandColors ?? [],
    image_exclude: row.imageExclude ?? [],
    brand_voice: row.brandVoice,
    avoid: row.avoid,
    required_mentions: row.requiredMentions,
    article_type: row.articleType,
    additional_info: row.additionalInfo,
    stage_settings: row.stageSettings ?? DEFAULT_STAGE_SETTINGS,
    id: row.id,
    current_stage: row.currentStage ?? "pending",
    stage_status: row.stageStatus ?? {},
    stage_logs: row.stageLogs ?? {},
    execution_logs: row.executionLogs ?? [],
    priority: row.priority ?? 0,
    research_content: row.researchContent,
    outline_content: row.outlineContent,
    draft_content: row.draftContent,
    final_md_content: row.finalMdContent,
    final_html_content: row.finalHtmlContent,
    image_manifest: row.imageManifest ?? null,
    ready_content: row.readyContent,
    wp_category_id: row.wpCategoryId,
    wp_author_id: row.wpAuthorId,
    wp_post_id: row.wpPostId,
    wp_post_url: row.wpPostUrl,
    wp_publish_status: row.wpPublishStatus,
    nextjs_publish_status: row.nextjsPublishStatus,
    nextjs_published_at: toPydanticIso(row.nextjsPublishedAt),
    created_at: toPydanticIso(row.createdAt),
    updated_at: toPydanticIso(row.updatedAt),
    completed_at: toPydanticIso(row.completedAt),
  }
}
