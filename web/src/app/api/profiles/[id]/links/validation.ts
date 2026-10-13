/**
 * `LinkCreate` from `api/src/models/schemas.py`: `url` required, the other
 * three carrying pydantic defaults. Extra keys are dropped rather than
 * rejected, which is pydantic's default `extra="ignore"` and is what stops a
 * client from setting `source` or `post_id`; the handler always writes
 * `source: "manual"` the way `create_link()` did.
 *
 * Probed against the real model rather than assumed:
 *
 *   {"url": "u", "source": "sitemap", "post_id": "...", "id": "x"}
 *     -> {'url': 'u', 'title': None, 'slug': None, 'keywords': []}
 *   {"url": "u", "keywords": ["a", 1]}
 *     -> string_type at ['keywords', 1]
 */
import { z } from "zod"

export const linkCreateSchema = z.object({
  url: z.string(),
  title: z.string().nullable().default(null),
  slug: z.string().nullable().default(null),
  keywords: z.array(z.string()).default([]),
})

export type LinkCreateInput = z.infer<typeof linkCreateSchema>
