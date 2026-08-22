/**
 * The wire shape of a website profile, shared by every ported profile handler.
 *
 * This is `ProfileRead` from `api/src/models/schemas.py`, which is the
 * `Profile` interface in `web/src/lib/api.ts`. Two columns that exist on the
 * row are deliberately absent from it, `wp_app_password` and
 * `nextjs_webhook_secret`, both of which hold ciphertext: FastAPI dropped them
 * because `ProfileRead` never declared them, and the same must hold here or the
 * port would start leaking credentials the Python stack never returned.
 */
import type { StageSettingsJson, websiteProfiles } from "@/db"

type ProfileRow = typeof websiteProfiles.$inferSelect

/**
 * `null` appears here only where `ProfileRead` declared the field optional.
 * `created_at` and `updated_at` are the exception: Pydantic required them and
 * would have raised on a null, but the column is nullable in Postgres, so the
 * null is carried through rather than invented into a timestamp.
 */
export interface ProfileResponse {
  name: string
  website_url: string
  niche: string | null
  target_audience: string | null
  tone: string
  brand_voice: string | null
  word_count: number
  output_format: string
  image_style: string | null
  image_brand_colors: string[]
  image_exclude: string[]
  avoid: string | null
  required_mentions: string | null
  related_keywords: string[]
  default_stage_settings: StageSettingsJson
  recrawl_interval: string | null
  id: string
  sitemap_urls: string[]
  last_crawled_at: string | null
  crawl_status: string
  wp_url: string | null
  wp_username: string | null
  wp_default_author_id: number | null
  wp_default_category_id: number | null
  wp_default_status: string | null
  nextjs_webhook_url: string | null
  nextjs_frontmatter_map: Record<string, unknown> | null
  created_at: string | null
  updated_at: string | null
}

/**
 * The stage map `ProfileBase.default_stage_settings` falls back to. It is not
 * the column's server default, which Alembic wrote as a five-key `"review"`
 * map; a null column reached Pydantic as a missing value and picked up this
 * one instead, so this is what the dashboard actually saw.
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
 * Fields `ProfileRead` declared non-optional take their Pydantic default when
 * the column is null. Optional fields keep the null: `wp_default_status` is
 * `str | None = "publish"`, so a null column stayed null through FastAPI and
 * stays null here.
 */
export function serializeProfile(row: ProfileRow): ProfileResponse {
  return {
    name: row.name,
    website_url: row.websiteUrl,
    niche: row.niche,
    target_audience: row.targetAudience,
    tone: row.tone ?? "Conversational and friendly",
    brand_voice: row.brandVoice,
    word_count: row.wordCount ?? 2000,
    output_format: row.outputFormat ?? "markdown",
    image_style: row.imageStyle,
    image_brand_colors: row.imageBrandColors ?? [],
    image_exclude: row.imageExclude ?? [],
    avoid: row.avoid,
    required_mentions: row.requiredMentions,
    related_keywords: row.relatedKeywords ?? [],
    default_stage_settings: row.defaultStageSettings ?? DEFAULT_STAGE_SETTINGS,
    recrawl_interval: row.recrawlInterval,
    id: row.id,
    sitemap_urls: row.sitemapUrls ?? [],
    last_crawled_at: row.lastCrawledAt?.toISOString() ?? null,
    crawl_status: row.crawlStatus ?? "pending",
    wp_url: row.wpUrl,
    wp_username: row.wpUsername,
    wp_default_author_id: row.wpDefaultAuthorId,
    wp_default_category_id: row.wpDefaultCategoryId,
    wp_default_status: row.wpDefaultStatus,
    nextjs_webhook_url: row.nextjsWebhookUrl,
    nextjs_frontmatter_map: row.nextjsFrontmatterMap,
    created_at: row.createdAt?.toISOString() ?? null,
    updated_at: row.updatedAt?.toISOString() ?? null,
  }
}
