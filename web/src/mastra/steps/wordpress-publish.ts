/**
 * `publish_to_wordpress` from `api/src/pipeline/publish.py`, as a Mastra step
 * (ledger item 5.3c-iii-b-1-c-iii).
 *
 * The four pieces the hook is built from are already ported and tested against
 * oracles generated from the real Python: `extractFrontmatter` and
 * `indexManifestImages` (`../wordpress/publish-metadata`), `markdownToWpHtml`
 * (`../wordpress/wp-html`), the media sweep (`../wordpress/media-upload`) and
 * the REST client (`../wordpress`). What is left, and what this module is, is
 * the part that has no pure oracle: the guards, the `wp_publish_status`
 * transitions, the create/update branch and the three SSE events.
 *
 * It is a step rather than a helper because the structural rule of this port
 * puts every background job in a Mastra primitive, and because publishing is
 * minutes of uploads against someone else's WordPress: `POST
 * /api/posts/{id}/publish` (item 5.3c-iii-b-1-d) starts a run and returns,
 * exactly as it enqueued an ARQ job before.
 *
 * Behaviours that a naive translation loses, each pinned by a test in
 * `./wordpress-publish.test.ts`:
 *
 * * **A publish failure is not a step failure.** Python caught everything,
 *   marked the post `failed` and returned normally, so ARQ never retried a
 *   publish. This step does the same and reports the failure in its output
 *   rather than throwing, because a thrown step is redelivered by the
 *   transport and every image would be uploaded to the site a second time.
 * * **A missing post is not an error either.** Python logged and returned.
 * * **The `try` covers the success commit.** An exception raised after the row
 *   has already been written `published`, which is every failure in
 *   `append_execution_log` and in the event publish, still reaches `_fail`,
 *   which rewrites `wp_publish_status` to `failed` and leaves `wp_post_id` and
 *   `wp_post_url` in place. That is a post that exists on WordPress and reads
 *   as failed here, and it is preserved rather than corrected.
 * * **`body` is computed and unused.** `_extract_frontmatter` is called for its
 *   metadata only; the HTML is rendered from the whole `content`, frontmatter
 *   included, because `markdown_to_wp_html` strips its own.
 *
 * One divergence that is outcome-equivalent but not message-equivalent.
 * `post.wp_post_id = wp_post.get("id")` assigns into an `integer` column and
 * `post.wp_post_url = wp_post.get("link", "")` into a `text` one. A WordPress
 * that answered `{"id": "7"}` made asyncpg raise, which Python caught and
 * turned into a `failed` publish; `pg` sends parameters as text and Postgres
 * would coerce `'7'` happily, so the check is made here instead. The outcome
 * matches (the publish fails and the row says so), the recorded message does
 * not: Python's was asyncpg's, this one names the column.
 */
import { createStep } from "@mastra/core/workflows/evented"
import { eq } from "drizzle-orm"
import { z } from "zod"

import { getDb, posts, websiteProfiles } from "../../db"
import { decrypt } from "../../lib/crypto"
import { appendExecutionLog } from "../execution-log"
import { postMediaDir } from "../images/media-dir"
import { publishPipelineEvent } from "../pipeline-events"
import { WordPressClient } from "../wordpress"
import { pythonGet, rewriteImageUrls, sweepMediaDirectory } from "../wordpress/media-upload"
import { extractFrontmatter, indexManifestImages } from "../wordpress/publish-metadata"
import { markdownToWpHtml } from "../wordpress/wp-html"

import type { PubSub } from "@mastra/core/events"

/**
 * The slice of `mastra.getLogger()` this hook writes to, spelled structurally
 * rather than imported as `IMastraLogger`: `no-next-imports.test.ts` asserts
 * the exact set of packages the Mastra entry point reaches, and a type-only
 * import of `@mastra/core/logger` still shows up in that scan.
 */
type PublishLogger = { info(message: string): void; error(message: string): void }

export const wordpressPublishInputSchema = z.object({
  postId: z.uuid(),
})

export type WordPressPublishInput = z.infer<typeof wordpressPublishInputSchema>

export const wordpressPublishOutputSchema = z.object({
  postId: z.uuid(),
  /**
   * `missing` is Python's "post not found" branch, which touched nothing; the
   * other two are the value left in `posts.wp_publish_status`.
   */
  status: z.enum(["published", "failed", "missing"]),
  /** `wp_post.get("id")`, as written to the row. Null on every failure. */
  wpPostId: z.number().int().nullable(),
  /** `wp_post.get("link", "")`, as written to the row. Null on every failure. */
  wpPostUrl: z.string().nullable(),
  /** Images uploaded, which is the size of `image_map`. */
  uploaded: z.number().int().nonnegative(),
  /** The message `_fail` recorded, for the trace view. Null on success. */
  error: z.string().nullable(),
})

export type WordPressPublishOutput = z.infer<typeof wordpressPublishOutputSchema>

/**
 * `_fail`: the row first, then the audit trail, then the browser, then the log
 * line, in that order because a dashboard that refetches on `publish_error`
 * must not read a row that still says `publishing`.
 */
async function fail(
  pubsub: PubSub,
  logger: PublishLogger | undefined,
  postId: string,
  error: string,
): Promise<WordPressPublishOutput> {
  await getDb().update(posts).set({ wpPublishStatus: "failed" }).where(eq(posts.id, postId))
  await appendExecutionLog(postId, {
    stage: "",
    level: "error",
    event: "publish_error",
    message: `WordPress publish failed: ${error}`,
  })
  await publishPipelineEvent(pubsub, postId, "publish_error", {
    error,
    message: `Publish failed: ${error}`,
  })
  logger?.error(`WP publish failed for post ${postId}: ${error}`)
  return { postId, status: "failed", wpPostId: null, wpPostUrl: null, uploaded: 0, error }
}

/** See the header: the column check that stands in for asyncpg's parameter check. */
function integerColumn(value: unknown, column: string): number | null {
  if (value === null || value === undefined) return null
  if (typeof value === "number" && Number.isInteger(value)) return value
  throw new TypeError(`${column} expects an integer, got ${typeof value}`)
}

/** The same, for `wp_post_url`, whose `.get` default is `""` rather than null. */
function textColumn(value: unknown, column: string): string {
  if (typeof value === "string") return value
  throw new TypeError(`${column} expects a string, got ${value === null ? "None" : typeof value}`)
}

export const wordpressPublishStep = createStep({
  id: "wordpress-publish",
  inputSchema: wordpressPublishInputSchema,
  outputSchema: wordpressPublishOutputSchema,
  execute: async ({ inputData, mastra }) => {
    const { postId } = inputData
    const logger = mastra?.getLogger()
    const pubsub = mastra.pubsub
    const db = getDb()

    const [post] = await db.select().from(posts).where(eq(posts.id, postId)).limit(1)
    if (!post) {
      logger?.error(`Post ${postId} not found for WP publish`)
      return {
        postId,
        status: "missing" as const,
        wpPostId: null,
        wpPostUrl: null,
        uploaded: 0,
        error: null,
      }
    }

    const [profile] = post.profileId
      ? await db
          .select()
          .from(websiteProfiles)
          .where(eq(websiteProfiles.id, post.profileId))
          .limit(1)
      : []
    if (!profile) return fail(pubsub, logger, postId, "No profile linked to post")

    // `if not profile.wp_url or ...`: an empty string is as missing as a null.
    if (!profile.wpUrl || !profile.wpUsername || !profile.wpAppPassword) {
      return fail(pubsub, logger, postId, "WordPress credentials not configured")
    }

    let password: string
    try {
      password = decrypt(profile.wpAppPassword)
    } catch {
      return fail(pubsub, logger, postId, "Failed to decrypt WP app password")
    }

    await db.update(posts).set({ wpPublishStatus: "publishing" }).where(eq(posts.id, postId))
    await publishPipelineEvent(pubsub, postId, "publish_start", {
      message: "Publishing to WordPress...",
    })

    try {
      const client = new WordPressClient(profile.wpUrl, profile.wpUsername, password)

      const content = post.readyContent || post.finalMdContent || ""
      // `body` is discarded: see the header.
      const { meta } = extractFrontmatter(content)
      const title = meta.has("title") ? meta.get("title")! : post.topic
      const description = meta.has("description") ? meta.get("description")! : ""

      const wpHtml0 = markdownToWpHtml(content)

      const manifest = indexManifestImages(post.imageManifest)
      const { imageMap, featuredMediaId } = await sweepMediaDirectory(postMediaDir(postId), {
        postId,
        title,
        manifest,
        client,
      })
      const wpHtml = rewriteImageUrls(wpHtml0, imageMap)

      const categories = post.wpCategoryId ? [post.wpCategoryId] : null
      const author = post.wpAuthorId
      const status = profile.wpDefaultStatus || "publish"

      const wpPost = post.wpPostId
        ? // `**kwargs` with no filtering: a null clears the field rather than
          // being dropped, and the key order is the call's keyword order.
          await client.updatePost(post.wpPostId, {
            title,
            content: wpHtml,
            status,
            categories: categories ?? [],
            author,
            featured_media: featuredMediaId,
            excerpt: description,
          })
        : await client.createPost({
            title,
            content: wpHtml,
            status,
            categories,
            author,
            featuredMedia: featuredMediaId,
            excerpt: description,
          })

      const wpPostId = integerColumn(pythonGet(wpPost, "id"), "wp_post_id")
      const wpPostUrl = textColumn(pythonGet(wpPost, "link", ""), "wp_post_url")
      await db
        .update(posts)
        .set({ wpPostId, wpPostUrl, wpPublishStatus: "published" })
        .where(eq(posts.id, postId))

      await appendExecutionLog(postId, {
        stage: "",
        level: "info",
        event: "publish_complete",
        message: `Published to WordPress: ${wpPostUrl}`,
      })
      await publishPipelineEvent(pubsub, postId, "publish_complete", {
        wp_post_url: wpPostUrl,
        wp_post_id: wpPostId,
      })
      logger?.info(`Post ${postId} published to WordPress: ${wpPostUrl}`)

      return {
        postId,
        status: "published" as const,
        wpPostId,
        wpPostUrl,
        uploaded: imageMap.size,
        error: null,
      }
    } catch (error) {
      // Python's two arms differ only in the traceback the second one logs,
      // and both call `_fail(str(e))`. `WordPressError`'s `str` is its message,
      // which is every other exception's `str` here too.
      const message = error instanceof Error ? error.message : String(error)
      return fail(pubsub, logger, postId, message)
    }
  },
})
