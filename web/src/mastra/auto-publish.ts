/**
 * The auto-publish half of `_post_completion_hook` (`api/src/worker.py:439`),
 * ledger item 5.11.
 *
 * When a full run finishes, a post whose `output_format` names a destination
 * and whose profile carries that destination's credentials publishes itself
 * without anybody pressing the button. Python split the work across two
 * functions and the split is load-bearing, so it is preserved here: the hook
 * only writes `wp_publish_status` / `nextjs_publish_status`, and the *caller*
 * (`api/src/worker.py:288`) re-reads the row and enqueues on
 * `status == "pending"`.
 *
 * That indirection is not a detail to tidy away. Three consequences a
 * translation that fused the two would lose, each pinned by a test in
 * `./workflows/auto-publish.test.ts`:
 *
 * * **A stale `pending` re-publishes.** The caller reads the column, not the
 *   decision the check just made. A post left `pending` by an earlier publish
 *   that died is started again by the next full run, even when the
 *   configuration check above declined (profile credentials since removed, or
 *   an `output_format` that no longer names that destination).
 * * **The two columns are read independently of `output_format`.** A
 *   `wordpress` post carrying a stale `nextjs_publish_status = "pending"`
 *   starts the Next.js publish too.
 * * **`both` matches neither branch.** Python compared for equality rather
 *   than testing membership, exactly as `POST /{post_id}/publish` does, so the
 *   default `output_format` publishes nowhere on its own.
 *
 * The configuration checks are Python truthiness on nullable `text` columns, so
 * an empty string counts as unconfigured the same way a null does.
 */
import { and, eq, sql } from "drizzle-orm"

import { getDb, posts, websiteProfiles } from "../db"

/** Which publishes the caller should start, read back off the row. */
export interface AutoPublishTargets {
  wordpress: boolean
  nextjs: boolean
}

const PENDING = "pending"

function configured(...values: (string | null)[]): boolean {
  return values.every((value) => Boolean(value))
}

/**
 * Write the `pending` markers `_post_completion_hook` wrote, then report what
 * the caller's re-read of the row says to start.
 *
 * A post that no longer exists reports neither, which is Python's `if not post:
 * return` followed by a caller whose own `session.get` also came back `None`.
 *
 * Each write is skipped when the column already reads `pending`, because
 * SQLAlchemy emitted no `UPDATE` for an assignment that did not change the
 * loaded value and therefore left `updated_at` alone. Without the guard,
 * finishing a run would bump `updated_at` on a post whose publish state did not
 * move.
 */
export async function applyAutoPublishHook(postId: string): Promise<AutoPublishTargets> {
  const db = getDb()
  const [post] = await db
    .select({
      outputFormat: posts.outputFormat,
      profileId: posts.profileId,
    })
    .from(posts)
    .where(eq(posts.id, postId))
    .limit(1)

  if (!post) return { wordpress: false, nextjs: false }

  if (post.profileId) {
    const [profile] = await db
      .select({
        wpUrl: websiteProfiles.wpUrl,
        wpUsername: websiteProfiles.wpUsername,
        wpAppPassword: websiteProfiles.wpAppPassword,
        nextjsWebhookUrl: websiteProfiles.nextjsWebhookUrl,
        nextjsWebhookSecret: websiteProfiles.nextjsWebhookSecret,
      })
      .from(websiteProfiles)
      .where(eq(websiteProfiles.id, post.profileId))
      .limit(1)

    if (
      post.outputFormat === "wordpress" &&
      profile &&
      configured(profile.wpUrl, profile.wpUsername, profile.wpAppPassword)
    ) {
      await db
        .update(posts)
        .set({ wpPublishStatus: PENDING, updatedAt: new Date() })
        .where(
          and(eq(posts.id, postId), sql`${posts.wpPublishStatus} is distinct from ${PENDING}`),
        )
    }

    if (
      post.outputFormat === "nextjs" &&
      profile &&
      configured(profile.nextjsWebhookUrl, profile.nextjsWebhookSecret)
    ) {
      await db
        .update(posts)
        .set({ nextjsPublishStatus: PENDING, updatedAt: new Date() })
        .where(
          and(eq(posts.id, postId), sql`${posts.nextjsPublishStatus} is distinct from ${PENDING}`),
        )
    }
  }

  const [refreshed] = await db
    .select({
      wpPublishStatus: posts.wpPublishStatus,
      nextjsPublishStatus: posts.nextjsPublishStatus,
    })
    .from(posts)
    .where(eq(posts.id, postId))
    .limit(1)

  return {
    wordpress: refreshed?.wpPublishStatus === PENDING,
    nextjs: refreshed?.nextjsPublishStatus === PENDING,
  }
}
