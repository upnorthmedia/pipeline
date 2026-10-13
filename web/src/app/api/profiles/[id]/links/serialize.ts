/**
 * The wire shape of an internal link, from `LinkRead` in
 * `api/src/models/schemas.py`. This is the `InternalLink` interface in
 * `web/src/lib/api.ts`, and the field order below is `LinkRead`'s own,
 * confirmed against the live model rather than transcribed from the class body:
 *
 *   ['url', 'title', 'slug', 'keywords', 'id', 'profile_id', 'source',
 *    'post_id', 'created_at']
 */
import type { internalLinks } from "@/db"

import { toPydanticIso } from "../../../pydantic"

type LinkRow = typeof internalLinks.$inferSelect

export interface LinkResponse {
  url: string
  title: string | null
  slug: string | null
  keywords: string[]
  id: string
  profile_id: string
  source: string
  post_id: string | null
  created_at: string | null
}

/**
 * `source` and `keywords` are nullable columns that `LinkRead` declared
 * non-optional, so a row written with an explicit null takes the pydantic
 * default rather than the 500 pydantic would have raised. That is the same
 * narrow divergence `serializePost()` records, and both columns carry a server
 * default so only a deliberate null reaches it. `created_at` is the exception:
 * pydantic required it with no default to fall back on, so a null carries
 * through.
 */
export function serializeLink(row: LinkRow): LinkResponse {
  return {
    url: row.url,
    title: row.title,
    slug: row.slug,
    keywords: row.keywords ?? [],
    id: row.id,
    profile_id: row.profileId,
    source: row.source ?? "sitemap",
    post_id: row.postId,
    created_at: toPydanticIso(row.createdAt),
  }
}
