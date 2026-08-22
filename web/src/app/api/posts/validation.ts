/**
 * Request-body validation for the post write endpoints, standing in for
 * `PostCreate` and `PostUpdate` in `api/src/models/schemas.py`.
 *
 * The declared defaults are not decoration here: `create_post` decides whether
 * to prefill a field from the profile by comparing the submitted value against
 * the schema default, so each default below is load-bearing for what ends up in
 * the row. They are exported as `POST_CREATE_DEFAULTS` for exactly that reason
 * and asserted against the values pydantic reports.
 */
import { z } from "zod"

import type { StageSettingsJson, posts } from "@/db"

import { jsonObject, pydanticInt, pydanticUuid } from "../pydantic"

/** `PostBase.stage_settings`, spelled exactly as pydantic spelled it. */
const DEFAULT_STAGE_SETTINGS: StageSettingsJson = {
  research: "auto",
  outline: "auto",
  write: "auto",
  edit: "auto",
  images: "auto",
  ready: "auto",
}

/**
 * One entry per field, in `PostCreate`'s declaration order. `slug` and `topic`
 * are the only required ones; every other field carries the default
 * `model_dump()` would have supplied.
 */
export const postCreateSchema = z.object({
  slug: z.string(),
  topic: z.string(),
  profile_id: pydanticUuid.nullable().default(null),
  target_audience: z.string().nullable().default(null),
  niche: z.string().nullable().default(null),
  intent: z.string().nullable().default(null),
  word_count: pydanticInt.default(2000),
  tone: z.string().default("Conversational and friendly"),
  output_format: z.string().default("markdown"),
  website_url: z.string().nullable().default(null),
  related_keywords: z.array(z.string()).default([]),
  competitor_urls: z.array(z.string()).default([]),
  image_style: z.string().nullable().default(null),
  image_brand_colors: z.array(z.string()).default([]),
  image_exclude: z.array(z.string()).default([]),
  brand_voice: z.string().nullable().default(null),
  avoid: z.string().nullable().default(null),
  required_mentions: z.string().nullable().default(null),
  article_type: z.string().nullable().default(null),
  additional_info: z.string().nullable().default(null),
  stage_settings: jsonObject.default(DEFAULT_STAGE_SETTINGS),
  wp_category_id: pydanticInt.nullable().default(null),
  wp_author_id: pydanticInt.nullable().default(null),
})

export type PostCreateInput = z.infer<typeof postCreateSchema>

/**
 * The schema default of every field, which is what `create_post` compares the
 * submitted value against before deciding to prefill it from the profile.
 * Taken from parsing an empty body, so it cannot drift from the schema above.
 */
export const POST_CREATE_DEFAULTS = postCreateSchema.parse({
  slug: "",
  topic: "",
}) satisfies PostCreateInput

/**
 * The create body as it is written, after `prefill.ts` has folded the profile
 * in. `stage_settings` widens to null there: a profile whose
 * `default_stage_settings` is null clears the post's rather than leaving the
 * pydantic default in place.
 */
export type PostWriteInput = Omit<PostCreateInput, "stage_settings"> & {
  stage_settings: PostCreateInput["stage_settings"] | null
}

type PostInsert = typeof posts.$inferInsert

/** Wire field name to Drizzle column key, for every field `PostCreate` carries. */
export const COLUMN_OF = {
  slug: "slug",
  topic: "topic",
  profile_id: "profileId",
  target_audience: "targetAudience",
  niche: "niche",
  intent: "intent",
  word_count: "wordCount",
  tone: "tone",
  output_format: "outputFormat",
  website_url: "websiteUrl",
  related_keywords: "relatedKeywords",
  competitor_urls: "competitorUrls",
  image_style: "imageStyle",
  image_brand_colors: "imageBrandColors",
  image_exclude: "imageExclude",
  brand_voice: "brandVoice",
  avoid: "avoid",
  required_mentions: "requiredMentions",
  article_type: "articleType",
  additional_info: "additionalInfo",
  stage_settings: "stageSettings",
  wp_category_id: "wpCategoryId",
  wp_author_id: "wpAuthorId",
} as const satisfies Record<keyof PostCreateInput, keyof PostInsert>

/**
 * `PostUpdate` in `api/src/models/schemas.py`, which is not `PostCreate`
 * partialised: it drops `slug` and `profile_id`, so a patch can neither rename
 * a post nor move it to another profile (and so out of the caller's tenancy),
 * and it adds the six stage content columns, which is how the editor on
 * `posts/[id]` saves.
 *
 * Every field is declared `X | None = None`, so `null` is a legal value for all
 * of them, including the three list fields and `stage_settings`. That is the
 * difference from `PostCreate`, where the same fields are non-nullable with a
 * container default, and it is why `related_keywords: null` clears the column
 * here but is a 422 on create.
 *
 * `.partial()` supplies `exclude_unset=True`: a key the client did not send is
 * absent from the parse output, so it never reaches the `set`.
 */
export const postUpdateSchema = z
  .object({
    topic: z.string().nullable(),
    target_audience: z.string().nullable(),
    niche: z.string().nullable(),
    intent: z.string().nullable(),
    word_count: pydanticInt.nullable(),
    tone: z.string().nullable(),
    output_format: z.string().nullable(),
    website_url: z.string().nullable(),
    related_keywords: z.array(z.string()).nullable(),
    competitor_urls: z.array(z.string()).nullable(),
    image_style: z.string().nullable(),
    image_brand_colors: z.array(z.string()).nullable(),
    image_exclude: z.array(z.string()).nullable(),
    brand_voice: z.string().nullable(),
    avoid: z.string().nullable(),
    required_mentions: z.string().nullable(),
    article_type: z.string().nullable(),
    additional_info: z.string().nullable(),
    stage_settings: jsonObject.nullable(),
    wp_category_id: pydanticInt.nullable(),
    wp_author_id: pydanticInt.nullable(),
    research_content: z.string().nullable(),
    outline_content: z.string().nullable(),
    draft_content: z.string().nullable(),
    final_md_content: z.string().nullable(),
    final_html_content: z.string().nullable(),
    ready_content: z.string().nullable(),
  })
  .partial()

export type PostUpdateInput = z.infer<typeof postUpdateSchema>

/** Wire field name to Drizzle column key, for every field `PostUpdate` carries. */
export const UPDATE_COLUMN_OF = {
  topic: "topic",
  target_audience: "targetAudience",
  niche: "niche",
  intent: "intent",
  word_count: "wordCount",
  tone: "tone",
  output_format: "outputFormat",
  website_url: "websiteUrl",
  related_keywords: "relatedKeywords",
  competitor_urls: "competitorUrls",
  image_style: "imageStyle",
  image_brand_colors: "imageBrandColors",
  image_exclude: "imageExclude",
  brand_voice: "brandVoice",
  avoid: "avoid",
  required_mentions: "requiredMentions",
  article_type: "articleType",
  additional_info: "additionalInfo",
  stage_settings: "stageSettings",
  wp_category_id: "wpCategoryId",
  wp_author_id: "wpAuthorId",
  research_content: "researchContent",
  outline_content: "outlineContent",
  draft_content: "draftContent",
  final_md_content: "finalMdContent",
  final_html_content: "finalHtmlContent",
  ready_content: "readyContent",
} as const satisfies Record<keyof PostUpdateInput, keyof PostInsert>

/**
 * The validated body as Drizzle column values. Only the keys present in `body`
 * are produced, so this serves both a full `model_dump()` and the
 * `exclude_unset=True` dump of a patch.
 */
function columnsFrom(body: object, map: Record<string, string>): PostInsert {
  const columns: Record<string, unknown> = {}
  for (const [field, column] of Object.entries(map)) {
    if (field in body) columns[column] = (body as Record<string, unknown>)[field]
  }
  return columns as PostInsert
}

export function toColumns(body: Partial<PostWriteInput>): PostInsert {
  return columnsFrom(body, COLUMN_OF)
}

export function updateToColumns(body: PostUpdateInput): PostInsert {
  return columnsFrom(body, UPDATE_COLUMN_OF)
}

export { invalidJsonBody, unprocessableBody } from "../pydantic"
