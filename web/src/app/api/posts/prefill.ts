/**
 * The profile-driven prefill `create_post` runs before it writes a new post.
 *
 * The rule is not "fill in what the client left out": the endpoint has already
 * dumped the body through pydantic by this point, so an omitted field and a
 * field the client sent with the schema's own default value are indistinguishable
 * and both lose to the profile. That is why `word_count: 2000` submitted from
 * the new-post form is replaced by the profile's word count while
 * `word_count: 0` is not, and why an explicitly empty `related_keywords`
 * inherits the profile's keywords.
 *
 * A profile value of null never overwrites anything, so a sparsely filled
 * profile leaves the pydantic defaults in place. The one exception is
 * `stage_settings`, which is copied from `default_stage_settings`
 * unconditionally once the body holds the schema default, null included.
 *
 * `stage_settings` is also the one field that reads `submitted` rather than
 * only the parsed value, the deliberate deviation from Python recorded as
 * ledger item P2.114. Under Python's rule a post that cleared every gate sent
 * six `auto`s, which is the schema default, and had the profile's gates
 * written back over it: there was no body that expressed "no gates on this one
 * run", so the per-post gate editor could not exist. A `stage_settings` key
 * the client actually sent now wins, and an omitted one still inherits the
 * profile's. Nothing else deviates: `word_count: 2000` still loses.
 *
 * The two `wp_*` fields use the other rule: they are filled only when the body
 * left them null, so a client-supplied value always wins.
 *
 * `api/scripts/export_post_create_parity.py` drives the real endpoint over ten
 * bodies and profiles; `create.test.ts` asserts this module against its output.
 */
import type { websiteProfiles } from "@/db"

import { POST_CREATE_DEFAULTS, type PostCreateInput, type PostWriteInput } from "./validation"

type ProfileRow = typeof websiteProfiles.$inferSelect

/** `_PROFILE_PREFILL_FIELDS`, paired with the profile column each reads. */
const PREFILL_FIELDS = {
  niche: "niche",
  target_audience: "targetAudience",
  tone: "tone",
  brand_voice: "brandVoice",
  word_count: "wordCount",
  output_format: "outputFormat",
  website_url: "websiteUrl",
  image_style: "imageStyle",
  image_brand_colors: "imageBrandColors",
  image_exclude: "imageExclude",
  avoid: "avoid",
  required_mentions: "requiredMentions",
  related_keywords: "relatedKeywords",
} as const satisfies Partial<Record<keyof PostCreateInput, keyof ProfileRow>>

/** `_WP_PREFILL`, read here in post-field order rather than profile-field order. */
const WP_PREFILL = {
  wp_category_id: "wpDefaultCategoryId",
  wp_author_id: "wpDefaultAuthorId",
} as const satisfies Partial<Record<keyof PostCreateInput, keyof ProfileRow>>

/**
 * Python's `==` on the dumped value against the schema default. Only scalars
 * and the three list fields plus the one dict field reach this, so a structural
 * comparison over JSON values is exactly as deep as it needs to be.
 */
function equalsDefault(value: unknown, fallback: unknown): boolean {
  if (value === fallback) return true
  if (Array.isArray(value) && Array.isArray(fallback)) {
    return value.length === fallback.length && value.every((item, i) => equalsDefault(item, fallback[i]))
  }
  if (
    typeof value === "object" &&
    value !== null &&
    typeof fallback === "object" &&
    fallback !== null &&
    !Array.isArray(value) &&
    !Array.isArray(fallback)
  ) {
    const left = value as Record<string, unknown>
    const right = fallback as Record<string, unknown>
    const keys = Object.keys(left)
    if (keys.length !== Object.keys(right).length) return false
    return keys.every((key) => key in right && equalsDefault(left[key], right[key]))
  }
  return false
}

/**
 * The keys the client actually sent.
 *
 * The parsed body cannot answer this: zod fills an omitted `stage_settings`
 * with the schema default, so an absent key and a submitted six-`auto`s object
 * arrive identical. Anything that is not a JSON object sent no keys, which is
 * a body the schema has already refused by the time this is read.
 */
export function submittedKeys(raw: unknown): ReadonlySet<string> {
  if (raw === null || typeof raw !== "object" || Array.isArray(raw)) return new Set()
  return new Set(Object.keys(raw))
}

/** The body as it should be written, with the profile folded in. */
export function applyProfilePrefill(
  body: PostWriteInput,
  profile: ProfileRow,
  submitted: ReadonlySet<string>,
): PostWriteInput {
  const filled: PostWriteInput = { ...body }

  for (const [field, column] of Object.entries(PREFILL_FIELDS) as [
    keyof typeof PREFILL_FIELDS,
    keyof ProfileRow,
  ][]) {
    const current = filled[field]
    if (!equalsDefault(current, POST_CREATE_DEFAULTS[field]) && current !== null) continue
    const value = profile[column]
    if (value !== null && value !== undefined) {
      ;(filled as Record<string, unknown>)[field] = value
    }
  }

  if (
    !submitted.has("stage_settings") &&
    equalsDefault(filled.stage_settings, POST_CREATE_DEFAULTS.stage_settings)
  ) {
    // Copied without a null guard, so a profile that has none clears the post's.
    filled.stage_settings = profile.defaultStageSettings
  }

  for (const [field, column] of Object.entries(WP_PREFILL) as [
    keyof typeof WP_PREFILL,
    keyof ProfileRow,
  ][]) {
    if (filled[field] !== null) continue
    const value = profile[column]
    if (value !== null && value !== undefined) {
      ;(filled as Record<string, unknown>)[field] = value
    }
  }

  return filled
}
