/**
 * Drizzle description of the database Alembic revisions 001-011 already produced.
 *
 * This file does not own the schema: it mirrors it. Generated with
 * `drizzle-kit pull` against the migrated dev database and then annotated by
 * hand with JSONB element types. Column names, types, defaults, indexes and
 * constraints must stay byte-compatible with the live database.
 */
import {
  foreignKey,
  index,
  integer,
  json,
  jsonb,
  pgTable,
  text,
  timestamp,
  unique,
  uuid,
  varchar,
} from "drizzle-orm/pg-core"

/** The six pipeline stages, in execution order (mirrors `STAGES` in api/src/pipeline/state.py). */
export const PIPELINE_STAGES = [
  "research",
  "outline",
  "write",
  "edit",
  "images",
  "ready",
] as const
export type PipelineStage = (typeof PIPELINE_STAGES)[number]

/** Per-stage gate mode, as written by the API today ("auto"; older rows carry "review"). */
export type StageSettingsJson = Partial<Record<PipelineStage, string>>
/** Per-stage status (mirrors STATUS_* in api/src/pipeline/state.py). */
export type StageStatusJson = Partial<
  Record<PipelineStage, "pending" | "running" | "complete" | "failed">
>

/**
 * Alembic's own bookkeeping table. Owned by Alembic, never written from
 * TypeScript, but described here so the parity check sees a complete database.
 */
export const alembicVersion = pgTable("alembic_version", {
  versionNum: varchar("version_num", { length: 32 }).primaryKey().notNull(),
})

export const websiteProfiles = pgTable(
  "website_profiles",
  {
    id: uuid().defaultRandom().primaryKey().notNull(),
    name: varchar({ length: 255 }).notNull(),
    websiteUrl: text("website_url").notNull(),
    sitemapUrls: jsonb("sitemap_urls").$type<string[]>().default([]),
    niche: text(),
    targetAudience: text("target_audience"),
    tone: text().default("Conversational and friendly"),
    brandVoice: text("brand_voice"),
    wordCount: integer("word_count").default(2000),
    outputFormat: varchar("output_format", { length: 20 }).default("both"),
    imageStyle: text("image_style"),
    imageBrandColors: jsonb("image_brand_colors").$type<string[]>().default([]),
    imageExclude: jsonb("image_exclude").$type<string[]>().default([]),
    avoid: text(),
    requiredMentions: text("required_mentions"),
    relatedKeywords: jsonb("related_keywords").$type<string[]>().default([]),
    defaultStageSettings: jsonb("default_stage_settings")
      .$type<StageSettingsJson>()
      .default({
        edit: "review",
        write: "review",
        images: "review",
        outline: "review",
        research: "review",
      }),
    lastCrawledAt: timestamp("last_crawled_at", { withTimezone: true, mode: "date" }),
    crawlStatus: varchar("crawl_status", { length: 20 }).default("pending"),
    createdAt: timestamp("created_at", { withTimezone: true, mode: "date" }).defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true, mode: "date" }).defaultNow(),
    recrawlInterval: varchar("recrawl_interval", { length: 20 }),
    wpUrl: text("wp_url"),
    wpUsername: text("wp_username"),
    wpAppPassword: text("wp_app_password"),
    wpDefaultAuthorId: integer("wp_default_author_id"),
    wpDefaultCategoryId: integer("wp_default_category_id"),
    wpDefaultStatus: varchar("wp_default_status", { length: 20 }).default("publish"),
    userId: varchar("user_id"),
    nextjsWebhookUrl: text("nextjs_webhook_url"),
    nextjsWebhookSecret: text("nextjs_webhook_secret"),
    // json, not jsonb: Alembic 011 created this one as `json`.
    nextjsFrontmatterMap: json("nextjs_frontmatter_map").$type<Record<string, string>>(),
  },
  (table) => [
    index("ix_website_profiles_user_id").using(
      "btree",
      table.userId.asc().nullsLast().op("text_ops"),
    ),
  ],
)

export const posts = pgTable(
  "posts",
  {
    id: uuid().defaultRandom().primaryKey().notNull(),
    profileId: uuid("profile_id"),
    slug: varchar({ length: 255 }).notNull(),
    topic: text().notNull(),
    targetAudience: text("target_audience"),
    niche: text(),
    intent: text(),
    wordCount: integer("word_count").default(2000),
    tone: text().default("Conversational and friendly"),
    outputFormat: varchar("output_format", { length: 20 }).default("both"),
    websiteUrl: text("website_url"),
    relatedKeywords: jsonb("related_keywords").$type<string[]>().default([]),
    competitorUrls: jsonb("competitor_urls").$type<string[]>().default([]),
    imageStyle: text("image_style"),
    imageBrandColors: jsonb("image_brand_colors").$type<string[]>().default([]),
    imageExclude: jsonb("image_exclude").$type<string[]>().default([]),
    brandVoice: text("brand_voice"),
    avoid: text(),
    requiredMentions: text("required_mentions"),
    // Stage content, one column per stage via STAGE_CONTENT_MAP.
    researchContent: text("research_content"),
    outlineContent: text("outline_content"),
    draftContent: text("draft_content"),
    finalMdContent: text("final_md_content"),
    finalHtmlContent: text("final_html_content"),
    imageManifest: jsonb("image_manifest").$type<Record<string, unknown>>(),
    stageLogs: jsonb("stage_logs").$type<Record<string, unknown>>().default({}),
    currentStage: varchar("current_stage", { length: 20 }).default("pending"),
    stageSettings: jsonb("stage_settings")
      .$type<StageSettingsJson>()
      .default({
        edit: "review",
        write: "review",
        images: "review",
        outline: "review",
        research: "review",
      }),
    stageStatus: jsonb("stage_status").$type<StageStatusJson>().default({}),
    priority: integer().default(0),
    createdAt: timestamp("created_at", { withTimezone: true, mode: "date" }).defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true, mode: "date" }).defaultNow(),
    completedAt: timestamp("completed_at", { withTimezone: true, mode: "date" }),
    readyContent: text("ready_content"),
    executionLogs: jsonb("execution_logs")
      .$type<Record<string, unknown>[]>()
      .default([])
      .notNull(),
    wpCategoryId: integer("wp_category_id"),
    wpAuthorId: integer("wp_author_id"),
    wpPostId: integer("wp_post_id"),
    wpPostUrl: text("wp_post_url"),
    wpPublishStatus: varchar("wp_publish_status", { length: 20 }),
    articleType: text("article_type"),
    additionalInfo: text("additional_info"),
    nextjsPublishStatus: varchar("nextjs_publish_status", { length: 20 }),
    nextjsPublishedAt: timestamp("nextjs_published_at", {
      withTimezone: true,
      mode: "date",
    }),
  },
  (table) => [
    foreignKey({
      columns: [table.profileId],
      foreignColumns: [websiteProfiles.id],
      name: "posts_profile_id_fkey",
    }),
    unique("uq_posts_profile_slug").on(table.profileId, table.slug),
  ],
)

export const internalLinks = pgTable(
  "internal_links",
  {
    id: uuid().defaultRandom().primaryKey().notNull(),
    profileId: uuid("profile_id").notNull(),
    url: text().notNull(),
    title: text(),
    slug: varchar({ length: 255 }),
    source: varchar({ length: 20 }).default("sitemap"),
    postId: uuid("post_id"),
    keywords: jsonb().$type<string[]>().default([]),
    createdAt: timestamp("created_at", { withTimezone: true, mode: "date" }).defaultNow(),
  },
  (table) => [
    index("idx_internal_links_profile").using(
      "btree",
      table.profileId.asc().nullsLast().op("uuid_ops"),
    ),
    foreignKey({
      columns: [table.profileId],
      foreignColumns: [websiteProfiles.id],
      name: "internal_links_profile_id_fkey",
    }).onDelete("cascade"),
    foreignKey({
      columns: [table.postId],
      foreignColumns: [posts.id],
      name: "internal_links_post_id_fkey",
    }).onDelete("set null"),
    unique("uq_internal_links_profile_url").on(table.profileId, table.url),
  ],
)

/**
 * Key/value application settings, including the encrypted provider API keys.
 * Note the primary key is `key` alone: `user_id` is an index, not part of the
 * key, so settings rows are global per key today.
 */
export const settings = pgTable(
  "settings",
  {
    key: varchar({ length: 255 }).primaryKey().notNull(),
    value: jsonb().notNull(),
    updatedAt: timestamp("updated_at", { withTimezone: true, mode: "date" }).defaultNow(),
    userId: varchar("user_id"),
  },
  (table) => [
    index("ix_settings_user_id").using("btree", table.userId.asc().nullsLast().op("text_ops")),
  ],
)

export type Post = typeof posts.$inferSelect
export type NewPost = typeof posts.$inferInsert
export type WebsiteProfile = typeof websiteProfiles.$inferSelect
export type NewWebsiteProfile = typeof websiteProfiles.$inferInsert
export type InternalLink = typeof internalLinks.$inferSelect
export type NewInternalLink = typeof internalLinks.$inferInsert
export type Setting = typeof settings.$inferSelect
export type NewSetting = typeof settings.$inferInsert
