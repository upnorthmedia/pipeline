/**
 * `publish_to_nextjs` from `api/src/services/nextjs_publish.py`, as a Mastra
 * step (ledger item 5.3c-iii-b-2-d).
 *
 * The three transforms the hook is built from are already ported and pinned
 * against oracles generated from the real Python: `applyFrontmatterMapping`,
 * `applyMappingToContent` (with the half of PyYAML it needs) and
 * `buildNextjsPayload`, which is content selection, the `image_manifest` walk
 * and the `json.dumps` whose bytes the signature covers. Signing itself was
 * ported earlier as `signPayload` in `../../lib/hmac-signing`. What is left,
 * and what this module is, is the part with no pure oracle: the three guards,
 * the `nextjs_publish_status` transitions, the webhook `POST` and its 200
 * check, and the three SSE events.
 *
 * It is a step rather than a helper for the same reason the WordPress hook is:
 * the structural rule of this port puts every background job in a Mastra
 * primitive, and a publish is a 60-second webhook against someone else's site,
 * so `POST /api/posts/{id}/publish` starts a run and returns.
 *
 * Where this differs from `./wordpress-publish.ts`, and it differs in ways that
 * are easy to smooth over by accident:
 *
 * * **The payload build is not inside the `try`.** Python wraps only the
 *   `httpx` call. An `AttributeError` out of the manifest walk, a `TypeError`
 *   out of the frontmatter mapping or an `OSError` off the filesystem all
 *   propagate out of the job, which leaves the row reading `publishing` and
 *   lets ARQ retry. That is reproduced by letting the exception leave the step:
 *   the run ends `failed`, the row still says `publishing`, and
 *   `retryConfig.attempts` on the workflow reproduces `max_tries = 3`.
 * * **`_fail` writes no execution log.** The WordPress hook's did; this one
 *   only logs, writes the column and publishes the event, in that order, with
 *   the log line *first*. Adding an audit entry here would put a row in
 *   `GET /posts/{id}/logs` that Python never wrote.
 * * **A non-200 is a failure, not an exception.** No `raise_for_status()`, so
 *   the status code and the first 200 characters of the body become the
 *   recorded message and the publish ends `failed` without a retry.
 * * **`{"target": "nextjs"}` is the whole event payload.** The WordPress events
 *   carry human-readable `message` fields; these three carry only the target,
 *   plus `error` on the failure. `web/src/hooks/use-sse.ts` reads whatever
 *   arrives, so the difference is visible in the dashboard and preserved.
 *
 * Three divergences that are outcome-equivalent but not byte-equivalent, each
 * pinned by a test in `./nextjs-publish.test.ts`:
 *
 * * `response.text[:200]` slices 200 *code points*; `String.prototype.slice`
 *   counts UTF-16 units, so an astral character in a webhook's error body would
 *   be cut in half. Sliced by code point here.
 * * `httpx` decodes the body using the charset from `Content-Type` and falls
 *   back to charset detection; `Response.text()` is always UTF-8. A receiver
 *   that answers `text/plain; charset=latin-1` therefore produces a different
 *   recorded message. Not worth a decoder: the failure and its status code are
 *   what the dashboard shows.
 * * `Webhook request failed: {exc}` interpolates the `httpx` exception's `str`.
 *   `fetch` reports its own, so the prefix matches and the tail does not.
 */
import { randomUUID } from "node:crypto"

import { createStep } from "@mastra/core/workflows/evented"
import { eq } from "drizzle-orm"
import { z } from "zod"

import { getDb, posts, websiteProfiles } from "../../db"
import { decrypt } from "../../lib/crypto"
import { signPayload } from "../../lib/hmac-signing"
import { mediaRoot } from "../images/media-dir"
import { buildNextjsPayload, isoformatUtc } from "../nextjs/payload"
import { publishPipelineEvent } from "../pipeline-events"

import type { PubSub } from "@mastra/core/events"

/**
 * The slice of `mastra.getLogger()` this hook writes to, spelled structurally
 * rather than imported as `IMastraLogger`, for the reason
 * `./wordpress-publish.ts` gives: `no-next-imports.test.ts` asserts the exact
 * package set the entry point's graph reaches, and a type-only import of
 * `@mastra/core/logger` still shows up in that textual scan.
 */
type PublishLogger = { info(message: string): void; error(message: string): void }

/** `httpx.AsyncClient(timeout=60.0)`. */
export const WEBHOOK_TIMEOUT_MS = 60_000

/**
 * The two guard messages, exported because the route handler that starts this
 * run (item 5.3c-iii-b-2-e) has no way to reproduce them and the tests assert
 * them verbatim. Both are user-facing copy that the dashboard shows in a toast.
 */
export const NO_PROFILE_MESSAGE = "No profile linked to this post. Assign a profile first."
export const NOT_CONFIGURED_MESSAGE =
  "Next.js webhook not configured. Go to Profiles, select this post's profile, and add a Webhook URL and Secret in the Next.js Integration section."

export const nextjsPublishInputSchema = z.object({
  postId: z.uuid(),
})

export type NextjsPublishInput = z.infer<typeof nextjsPublishInputSchema>

export const nextjsPublishOutputSchema = z.object({
  postId: z.uuid(),
  /**
   * `missing` is Python's "post not found" branch, which touched nothing; the
   * other two are the value left in `posts.nextjs_publish_status`.
   */
  status: z.enum(["published", "failed", "missing"]),
  /** `post.nextjs_published_at`, as written to the row. Null unless published. */
  publishedAt: z.date().nullable(),
  /** The message `_fail` recorded. Null on success. */
  error: z.string().nullable(),
})

export type NextjsPublishOutput = z.infer<typeof nextjsPublishOutputSchema>

/**
 * `_fail`: the log line, then the row, then the browser.
 *
 * The order is Python's and it is the opposite of the WordPress hook's, which
 * wrote the row first. Kept as written: nothing here depends on the ordering
 * between the log and the column, and reordering to match its sibling would be
 * a change with no reason behind it.
 */
async function fail(
  pubsub: PubSub,
  logger: PublishLogger | undefined,
  postId: string,
  message: string,
): Promise<NextjsPublishOutput> {
  logger?.error(`Next.js publish failed for post ${postId}: ${message}`)
  await getDb().update(posts).set({ nextjsPublishStatus: "failed" }).where(eq(posts.id, postId))
  await publishPipelineEvent(pubsub, postId, "publish_error", {
    error: message,
    target: "nextjs",
  })
  return { postId, status: "failed", publishedAt: null, error: message }
}

/**
 * `text[:200]`. Python slices code points, so a four-byte character counts once
 * and is never split; `slice` would count it twice and could leave a lone
 * surrogate at the end of the recorded message.
 */
export function sliceCodePoints(text: string, limit: number): string {
  const points = Array.from(text)
  return points.length <= limit ? text : points.slice(0, limit).join("")
}

export const nextjsPublishStep = createStep({
  id: "nextjs-publish",
  inputSchema: nextjsPublishInputSchema,
  outputSchema: nextjsPublishOutputSchema,
  execute: async ({ inputData, mastra }) => {
    const { postId } = inputData
    const logger = mastra?.getLogger()
    const pubsub = mastra.pubsub
    const db = getDb()

    const [post] = await db.select().from(posts).where(eq(posts.id, postId)).limit(1)
    if (!post) {
      logger?.error(`Post ${postId} not found for Next.js publish`)
      return {
        postId,
        status: "missing" as const,
        publishedAt: null,
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
    if (!profile) return fail(pubsub, logger, postId, NO_PROFILE_MESSAGE)

    // `if not profile.nextjs_webhook_url or ...`: an empty string is as missing
    // as a null, and the profile form saves an empty string for a cleared field.
    if (!profile.nextjsWebhookUrl || !profile.nextjsWebhookSecret) {
      return fail(pubsub, logger, postId, NOT_CONFIGURED_MESSAGE)
    }

    let secret: string
    try {
      secret = decrypt(profile.nextjsWebhookSecret)
    } catch {
      return fail(pubsub, logger, postId, "Failed to decrypt webhook secret")
    }

    await db.update(posts).set({ nextjsPublishStatus: "publishing" }).where(eq(posts.id, postId))
    await publishPipelineEvent(pubsub, postId, "publish_start", { target: "nextjs" })

    // Deliberately outside the `try` below, exactly as Python has it: see the
    // header. A manifest or a mapping that raises leaves the row `publishing`.
    const payload = await buildNextjsPayload({
      post: {
        id: post.id,
        slug: post.slug,
        readyContent: post.readyContent,
        finalMdContent: post.finalMdContent,
        imageManifest: post.imageManifest,
      },
      frontmatterMap: profile.nextjsFrontmatterMap,
      postId,
      mediaDir: mediaRoot(),
      deliveryId: randomUUID(),
      timestamp: isoformatUtc(new Date()),
      onMissing: (path) => logger?.error(`Image file not found: ${path}`),
    })
    const signature = signPayload(payload, secret)

    let response: Response
    try {
      response = await fetch(profile.nextjsWebhookUrl, {
        method: "POST",
        body: payload,
        headers: {
          "Content-Type": "application/json",
          "X-Jena-Signature": signature,
        },
        signal: AbortSignal.timeout(WEBHOOK_TIMEOUT_MS),
      })
    } catch (error) {
      // `except httpx.RequestError`: every transport failure, which is what
      // `fetch` rejects with too. A non-transport failure would have been
      // raised before the request was made and is not caught here either.
      const detail = error instanceof Error ? error.message : String(error)
      return fail(pubsub, logger, postId, `Webhook request failed: ${detail}`)
    }

    if (response.status !== 200) {
      const body = await response.text()
      return fail(
        pubsub,
        logger,
        postId,
        `Webhook returned ${response.status}: ${sliceCodePoints(body, 200)}`,
      )
    }

    const publishedAt = new Date()
    await db
      .update(posts)
      .set({ nextjsPublishStatus: "published", nextjsPublishedAt: publishedAt })
      .where(eq(posts.id, postId))
    await publishPipelineEvent(pubsub, postId, "publish_complete", { target: "nextjs" })
    logger?.info(`Published post ${postId} to Next.js at ${profile.nextjsWebhookUrl}`)

    return { postId, status: "published" as const, publishedAt, error: null }
  },
})
