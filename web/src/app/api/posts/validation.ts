/**
 * Request-body validation for the post write endpoints, standing in for
 * `PostCreate` in `api/src/models/schemas.py`.
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
 * The validated body as Drizzle column values. Only the keys present in `body`
 * are produced, so this serves both a full `model_dump()` and, later, the
 * `exclude_unset=True` dump of a patch.
 */
export function toColumns(body: Partial<PostWriteInput>): PostInsert {
  const columns: Record<string, unknown> = {}
  for (const [field, column] of Object.entries(COLUMN_OF)) {
    if (field in body) columns[column] = body[field as keyof PostWriteInput]
  }
  return columns as PostInsert
}

export { invalidJsonBody, unprocessableBody } from "../pydantic"
