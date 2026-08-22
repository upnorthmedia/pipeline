/**
 * Request-body validation for the profile write endpoints, standing in for
 * `ProfileCreate` and `ProfileUpdate` in `api/src/models/schemas.py`.
 *
 * Field by field this mirrors pydantic in its default (lax) mode, including its
 * coercion of an integral string to an `int`, and its 422 body down to the
 * error `type` and `msg` strings. Every shape asserted here was read off the
 * real `ProfileCreate`/`ProfileUpdate` rather than assumed. Extra keys are
 * dropped rather than rejected, which is pydantic's default `extra="ignore"`.
 */
import { z } from "zod"

import type { StageSettingsJson, websiteProfiles } from "@/db"

/** `ProfileBase.default_stage_settings`, spelled exactly as pydantic spelled it. */
const DEFAULT_STAGE_SETTINGS: StageSettingsJson = {
  research: "auto",
  outline: "auto",
  write: "auto",
  edit: "auto",
  images: "auto",
  ready: "auto",
}

/**
 * Both `dict` fields are unconstrained on the Python side and land in a jsonb
 * or json column, so the value shape is not narrowed here either. The `$type`
 * on the column is a convention the writers follow, not a check the database
 * makes.
 */
const jsonObject = z.record(z.string(), z.unknown())

/**
 * pydantic's lax mode parses an `int` out of a string that holds nothing but an
 * optionally signed run of digits, surrounding whitespace allowed, and rejects
 * anything else. A float is accepted only when it is integral, which
 * `z.number().int()` already enforces.
 */
const INTEGRAL_STRING = /^[+-]?\d+$/

const pydanticInt = z.preprocess(
  (value) =>
    typeof value === "string" && INTEGRAL_STRING.test(value.trim()) ? Number(value) : value,
  z.number().int(),
)

/** One entry per field, in `ProfileCreate`'s declaration order. */
const FIELDS = {
  name: z.string(),
  website_url: z.string(),
  niche: z.string().nullable(),
  target_audience: z.string().nullable(),
  tone: z.string(),
  brand_voice: z.string().nullable(),
  word_count: pydanticInt,
  output_format: z.string(),
  image_style: z.string().nullable(),
  image_brand_colors: z.array(z.string()),
  image_exclude: z.array(z.string()),
  avoid: z.string().nullable(),
  required_mentions: z.string().nullable(),
  related_keywords: z.array(z.string()),
  default_stage_settings: jsonObject,
  recrawl_interval: z.string().nullable(),
  wp_url: z.string().nullable(),
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
 * defaults to "markdown" here even though the column defaults to "both",
 * because `model_dump()` always supplied a value and the column default never
 * applied on this path.
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

/**
 * FastAPI's 422 body. Only the `type`/`loc`/`msg`/`input` keys are reproduced,
 * matching the choice already made for the malformed-UUID response in
 * `[id]/route.ts`; pydantic's `ctx` and `url` keys are not, and nothing in
 * `web/src/lib/api.ts` reads them.
 */
export interface ValidationErrorDetail {
  type: string
  loc: (string | number)[]
  msg: string
  input: unknown
}

/** pydantic's error type and message for each type zod reports as `expected`. */
const TYPE_ERRORS: Record<string, { type: string; msg: string }> = {
  string: { type: "string_type", msg: "Input should be a valid string" },
  number: { type: "int_type", msg: "Input should be a valid integer" },
  array: { type: "list_type", msg: "Input should be a valid list" },
  record: { type: "dict_type", msg: "Input should be a valid dictionary" },
}

/** pydantic separates a string it could not read as an int from a wrong type. */
const INT_PARSING = {
  type: "int_parsing",
  msg: "Input should be a valid integer, unable to parse string as an integer",
}

/**
 * The submitted value a zod issue points at. Zod 4 drops `input` from the
 * finalised issues it exposes on `ZodError`, keeping only `code`, `expected`,
 * `path` and `message`, so the value has to be walked out of the body instead.
 */
function valueAt(body: unknown, path: readonly PropertyKey[]): unknown {
  let value = body
  for (const segment of path) {
    if (value === null || typeof value !== "object") return undefined
    value = (value as Record<PropertyKey, unknown>)[segment]
  }
  return value
}

function detailFor(issue: z.core.$ZodIssue, body: unknown): ValidationErrorDetail {
  const loc = ["body", ...issue.path.map((segment) => segment as string | number)]
  if (issue.code === "invalid_type") {
    if (valueAt(body, issue.path) === undefined) {
      // pydantic reports the containing object as the input of a missing key.
      return {
        type: "missing",
        loc,
        msg: "Field required",
        input: valueAt(body, issue.path.slice(0, -1)),
      }
    }
    const input = valueAt(body, issue.path)
    if (issue.expected === "number" && typeof input === "string") {
      return { ...INT_PARSING, loc, input }
    }
    const expected = TYPE_ERRORS[issue.expected]
    if (expected) return { ...expected, loc, input }
  }
  return { type: "value_error", loc, msg: issue.message, input: valueAt(body, issue.path) }
}

/** FastAPI's `RequestValidationError` response for a set of zod issues. */
export function unprocessableBody(issues: readonly z.core.$ZodIssue[], body: unknown): Response {
  return Response.json({ detail: issues.map((issue) => detailFor(issue, body)) }, { status: 422 })
}

/**
 * FastAPI answered a body that is not JSON with a 422 carrying a single
 * `json_invalid` entry, not a 400, so a client cannot tell a malformed body
 * from an invalid one by status alone.
 */
export function invalidJsonBody(): Response {
  return Response.json(
    { detail: [{ type: "json_invalid", loc: ["body", 0], msg: "JSON decode error", input: {} }] },
    { status: 422 },
  )
}
