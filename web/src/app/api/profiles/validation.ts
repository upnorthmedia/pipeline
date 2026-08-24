/**
 * Request-body validation for the profile write endpoints, standing in for
 * `ProfileCreate` and `ProfileUpdate` in `api/src/models/schemas.py`.
 *
 * Field by field this mirrors pydantic in its default (lax) mode, including its
 * coercion of an integral string to an `int`. Every shape asserted here was
 * read off the real `ProfileCreate`/`ProfileUpdate` rather than assumed. Extra
 * keys are dropped rather than rejected, which is pydantic's default
 * `extra="ignore"`. The lax coercions and the 422 body itself are shared with
 * the other ported routers in `../pydantic.ts`.
 *
 * One deliberate divergence: `website_url` and `wp_url` are checked as URLs,
 * where pydantic declared both `str` and took anything. Both columns are read
 * by code with nowhere to report a reason, so a value that cannot work has to
 * be refused here, while the person who typed it is still looking at it. See
 * `checkWebsiteUrl` and `checkWpUrl` below.
 */
import { z } from "zod"

import type { StageSettingsJson, websiteProfiles } from "@/db"

import { outputFormatField } from "../output-format"
import { jsonObject, pydanticInt } from "../pydantic"

/**
 * The reasons a URL column is refused, written for the decision the person
 * has to make rather than for the parser that found the problem. `../pydantic`
 * reports a `custom` zod issue with no pydantic error type attached as a
 * `value_error`, which is what pydantic itself answers for a failed validator.
 */
export const WEBSITE_URL_INVALID = "Website URL should be a full URL, like https://example.com"
export const WEBSITE_URL_SCHEME = "Website URL should start with http:// or https://"
export const WP_URL_INVALID = "WordPress URL should be a full URL, like https://example.com"
export const WP_URL_SCHEME = "WordPress URL should start with http:// or https://"
export const WP_URL_SPACES = "WordPress URL should have no spaces around it."
export const WP_URL_QUERY_OR_FRAGMENT =
  "WordPress URL should be the site address on its own. The REST path is added to the end of " +
  "it, so a query string or a #fragment would land in the middle of every request."

/**
 * A value both `fetch` and a browser can follow, or which of the two ways it
 * failed. The WHATWG parser is the same one every reader of these columns
 * ends up in, so agreeing with it is the point.
 */
function parseHttpUrl(raw: string): URL | "invalid" | "scheme" {
  let url: URL
  try {
    url = new URL(raw)
  } catch {
    return "invalid"
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") return "scheme"
  return url
}

/**
 * `website_url` seeds the sitemap crawl and is the base the internal-link
 * resolver resolves relative hrefs against. Neither can say anything to
 * anyone when it is not a URL: the crawl records a failed run and the resolver
 * quietly drops links.
 */
function checkWebsiteUrl(value: string, ctx: z.RefinementCtx): void {
  const parsed = parseHttpUrl(value)
  if (parsed === "invalid") ctx.addIssue({ code: "custom", message: WEBSITE_URL_INVALID })
  else if (parsed === "scheme") ctx.addIssue({ code: "custom", message: WEBSITE_URL_SCHEME })
}

/**
 * `wp_url` is stricter than a URL because `WordPressClient` does not build its
 * endpoints with the URL parser: it strips trailing slashes and one known
 * suffix, then concatenates `/wp-json/wp/v2` onto whatever is left. Anything
 * that has to stay at the end of a URL therefore ends up in the middle of one.
 * Measured against the real client: `https://example.com/?a=1` reaches
 * `https://example.com/?a=1/wp-json/wp/v2`, and every call against it 404s.
 *
 * The empty string is accepted rather than treated as a bad URL because every
 * reader already tests `wp_url` for truthiness, so "" is how a profile with no
 * WordPress connection reads, exactly as `null` does.
 */
function checkWpUrl(value: string, ctx: z.RefinementCtx): void {
  if (value === "") return
  if (value !== value.trim()) {
    ctx.addIssue({ code: "custom", message: WP_URL_SPACES })
    return
  }
  const parsed = parseHttpUrl(value)
  if (parsed === "invalid") {
    ctx.addIssue({ code: "custom", message: WP_URL_INVALID })
    return
  }
  if (parsed === "scheme") {
    ctx.addIssue({ code: "custom", message: WP_URL_SCHEME })
    return
  }
  if (parsed.search !== "" || parsed.hash !== "") {
    ctx.addIssue({ code: "custom", message: WP_URL_QUERY_OR_FRAGMENT })
  }
}

/** `ProfileBase.default_stage_settings`, spelled exactly as pydantic spelled it. */
const DEFAULT_STAGE_SETTINGS: StageSettingsJson = {
  research: "auto",
  outline: "auto",
  write: "auto",
  edit: "auto",
  images: "auto",
  ready: "auto",
}

/** One entry per field, in `ProfileCreate`'s declaration order. */
const FIELDS = {
  name: z.string(),
  website_url: z.string().superRefine(checkWebsiteUrl),
  niche: z.string().nullable(),
  target_audience: z.string().nullable(),
  tone: z.string(),
  brand_voice: z.string().nullable(),
  word_count: pydanticInt,
  output_format: outputFormatField,
  image_style: z.string().nullable(),
  image_brand_colors: z.array(z.string()),
  image_exclude: z.array(z.string()),
  avoid: z.string().nullable(),
  required_mentions: z.string().nullable(),
  related_keywords: z.array(z.string()),
  default_stage_settings: jsonObject,
  recrawl_interval: z.string().nullable(),
  wp_url: z.string().superRefine(checkWpUrl).nullable(),
  wp_username: z.string().nullable(),
  wp_app_password: z.string().nullable(),
  wp_default_author_id: pydanticInt.nullable(),
  wp_default_category_id: pydanticInt.nullable(),
  wp_default_status: z.string().nullable(),
  nextjs_webhook_url: z.string().nullable(),
  nextjs_webhook_secret: z.string().nullable(),
  nextjs_frontmatter_map: jsonObject.nullable(),
} as const

/**
 * `ProfileCreate`: `name` and `website_url` are required, every other field
 * carries the pydantic default it would have been dumped with. `output_format`
 * defaults to "markdown" here because `model_dump()` always supplied a value
 * and the column default never applied on this path; the column defaulted to
 * "both" until `drizzle/0003` made the two agree.
 */
export const profileCreateSchema = z.object({
  ...FIELDS,
  niche: FIELDS.niche.default(null),
  target_audience: FIELDS.target_audience.default(null),
  tone: FIELDS.tone.default("Conversational and friendly"),
  brand_voice: FIELDS.brand_voice.default(null),
  word_count: FIELDS.word_count.default(2000),
  output_format: FIELDS.output_format.default("markdown"),
  image_style: FIELDS.image_style.default(null),
  image_brand_colors: FIELDS.image_brand_colors.default([]),
  image_exclude: FIELDS.image_exclude.default([]),
  avoid: FIELDS.avoid.default(null),
  required_mentions: FIELDS.required_mentions.default(null),
  related_keywords: FIELDS.related_keywords.default([]),
  default_stage_settings: FIELDS.default_stage_settings.default(DEFAULT_STAGE_SETTINGS),
  recrawl_interval: FIELDS.recrawl_interval.default(null),
  wp_url: FIELDS.wp_url.default(null),
  wp_username: FIELDS.wp_username.default(null),
  wp_app_password: FIELDS.wp_app_password.default(null),
  wp_default_author_id: FIELDS.wp_default_author_id.default(null),
  wp_default_category_id: FIELDS.wp_default_category_id.default(null),
  wp_default_status: FIELDS.wp_default_status.default("publish"),
  nextjs_webhook_url: FIELDS.nextjs_webhook_url.default(null),
  nextjs_webhook_secret: FIELDS.nextjs_webhook_secret.default(null),
  nextjs_frontmatter_map: FIELDS.nextjs_frontmatter_map.default(null),
})

/**
 * `ProfileUpdate`: every field is `X | None = None`, so each one is both
 * optional and nullable. Absent keys stay absent from the parse output, which
 * is what gives the caller `model_dump(exclude_unset=True)`: a key the client
 * did not send is not written, while a key sent as `null` is.
 */
export const profileUpdateSchema = z
  .object({
    ...FIELDS,
    name: FIELDS.name.nullable(),
    website_url: FIELDS.website_url.nullable(),
    tone: FIELDS.tone.nullable(),
    word_count: FIELDS.word_count.nullable(),
    output_format: FIELDS.output_format.nullable(),
    image_brand_colors: FIELDS.image_brand_colors.nullable(),
    image_exclude: FIELDS.image_exclude.nullable(),
    related_keywords: FIELDS.related_keywords.nullable(),
    default_stage_settings: FIELDS.default_stage_settings.nullable(),
  })
  .partial()

export type ProfileCreateInput = z.infer<typeof profileCreateSchema>
export type ProfileUpdateInput = z.infer<typeof profileUpdateSchema>

type ProfileInsert = typeof websiteProfiles.$inferInsert

/** Wire field name to Drizzle column key. Every field either stack writes is here. */
const COLUMN_OF = {
  name: "name",
  website_url: "websiteUrl",
  niche: "niche",
  target_audience: "targetAudience",
  tone: "tone",
  brand_voice: "brandVoice",
  word_count: "wordCount",
  output_format: "outputFormat",
  image_style: "imageStyle",
  image_brand_colors: "imageBrandColors",
  image_exclude: "imageExclude",
  avoid: "avoid",
  required_mentions: "requiredMentions",
  related_keywords: "relatedKeywords",
  default_stage_settings: "defaultStageSettings",
  recrawl_interval: "recrawlInterval",
  wp_url: "wpUrl",
  wp_username: "wpUsername",
  wp_app_password: "wpAppPassword",
  wp_default_author_id: "wpDefaultAuthorId",
  wp_default_category_id: "wpDefaultCategoryId",
  wp_default_status: "wpDefaultStatus",
  nextjs_webhook_url: "nextjsWebhookUrl",
  nextjs_webhook_secret: "nextjsWebhookSecret",
  nextjs_frontmatter_map: "nextjsFrontmatterMap",
} as const satisfies Record<keyof typeof FIELDS, keyof ProfileInsert>

/**
 * The validated body as Drizzle column values. Only the keys present in
 * `body` are produced, so this serves both the full `model_dump()` of a create
 * and the `exclude_unset=True` dump of a patch.
 */
export function toColumns(body: ProfileCreateInput | ProfileUpdateInput): ProfileInsert {
  const columns: Record<string, unknown> = {}
  for (const [field, column] of Object.entries(COLUMN_OF)) {
    if (field in body) columns[column] = body[field as keyof typeof body]
  }
  return columns as ProfileInsert
}

export { invalidJsonBody, unprocessableBody } from "../pydantic"
