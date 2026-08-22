/**
 * Port of `POST /api/posts/{post_id}/duplicate` in `api/src/api/posts.py`.
 *
 * The copy is a whitelist, not a row clone: `duplicate_post` names eighteen
 * configuration fields and reads only those off the original, so everything
 * else falls back to the column default. That is what makes the duplicate a
 * fresh unrun post rather than a second copy of a finished article: the six
 * stage content columns, `image_manifest`, `stage_logs`, `execution_logs`,
 * `current_stage`, `stage_status`, `priority`, the WordPress fields and the
 * Next.js publishing fields are all left behind.
 *
 * Two fields the whitelist predates are also left behind, `article_type` and
 * `additional_info`, so a duplicate silently loses them. That is a defect in
 * the original rather than a decision, but it is behaviour the dashboard has
 * always seen, so it is reproduced here and logged in `todo.md` instead of
 * being quietly fixed inside a port.
 *
 * No pipeline run is started. `duplicate_post` is the one write endpoint in the
 * router that does not enqueue, which is why the duplicate sits at
 * `current_stage: "pending"` until the user runs it.
 */
import { randomUUID } from "node:crypto"

import { and, eq } from "drizzle-orm"

import { getDb, posts, websiteProfiles } from "@/db"
import { getRequestUser, unauthorized } from "@/lib/request-auth"

import { isUuid, postNotFound, unprocessableUuid } from "../../params"
import { serializePost } from "../../serialize"

/** `uuid.uuid4().hex[:6]`. */
function slugSuffix(): string {
  return randomUUID().replace(/-/g, "").slice(0, 6)
}

/** The eighteen names in `duplicate_post`'s `config_fields`, plus `slug`. */
const CONFIG_COLUMNS = [
  "profileId",
  "topic",
  "targetAudience",
  "niche",
  "intent",
  "wordCount",
  "tone",
  "outputFormat",
  "websiteUrl",
  "relatedKeywords",
  "competitorUrls",
  "imageStyle",
  "imageBrandColors",
  "imageExclude",
  "brandVoice",
  "avoid",
  "requiredMentions",
  "stageSettings",
] as const satisfies readonly (keyof typeof posts.$inferInsert)[]

export async function POST(
  request: Request,
  { params }: { params: Promise<{ id: string }> },
): Promise<Response> {
  const user = await getRequestUser(request)
  if (!user) return unauthorized()

  const { id } = await params
  if (!isUuid(id)) return unprocessableUuid(id)

  const rows = await getDb()
    .select({ post: posts })
    .from(posts)
    .innerJoin(websiteProfiles, eq(posts.profileId, websiteProfiles.id))
    .where(and(eq(posts.id, id), eq(websiteProfiles.userId, user.id)))
    .limit(1)

  if (rows.length === 0) return postNotFound()
  const original = rows[0].post

  // `topic` is seeded rather than left to the loop only because it is the one
  // non-nullable column in the whitelist, so the insert type demands it here.
  const values: typeof posts.$inferInsert = {
    slug: `${original.slug}-copy-${slugSuffix()}`,
    topic: original.topic,
  }
  for (const column of CONFIG_COLUMNS) {
    ;(values as Record<string, unknown>)[column] = original[column]
  }

  const [copy] = await getDb().insert(posts).values(values).returning()
  return Response.json(serializePost(copy), { status: 201 })
}
