/**
 * The caller's publish attempts that are not going to finish on their own,
 * read off the database once for the two route handlers that need them.
 *
 * `src/lib/publish-report.ts` holds the derivation and knows nothing about a
 * database; this holds the query, which is here rather than in either handler
 * because both of them ask the same question of the same rows. `GET /api/queue`
 * wants the stalled ones by name, for the card on `/monitor`; `GET
 * /api/analytics/dashboard` wants the ids, to keep a run whose publish died out
 * of the completion rate printed directly under that card. Two copies of the
 * query would be two places for the two screens to drift apart.
 *
 * Scoped to the rows carrying a publish status rather than to the account's
 * whole history, because the derivation reads `execution_logs` and that column
 * is large. The account's other posts cannot be in the answer: a publish that
 * was never asked for and one that landed are both outside it.
 */
import { and, eq, inArray, or } from "drizzle-orm"

import { getDb, posts, websiteProfiles } from "@/db"
import { publishColumnOf, publishStall, type PublishStall } from "@/lib/publish-report"
import type { PublishTarget } from "@/lib/publishing"

/**
 * The three values a publish status column holds when the attempt it records
 * is not a success. `pending` and `publishing` are the two the attempt is
 * supposed to move through, so they are the ones `publishStall()` can answer
 * about; `failed` is the step's own word for an attempt that ended badly and
 * needs no clock.
 */
const NOT_LANDED = ["pending", "publishing", "failed"]

/** One publish attempt that stopped, and which of the two ways it stopped in. */
export interface DeadPublish {
  id: string
  topic: string
  target: PublishTarget
  /** The destination's name, for a sentence that already says what is being done to it. */
  label: string
  /**
   * How it went quiet, or `null` when the column says `failed` outright. A
   * failure has a reason on the post itself (`lastPublishError()`), which is
   * more than this query is willing to read for a count.
   */
  stall: PublishStall | null
}

/**
 * Every publish of this user's that is not going to move again without them.
 *
 * A row whose format names no destination is dropped by `publishColumnOf()`,
 * including one still carrying a status from a format it has since been moved
 * off: neither publish step clears the other's column, so the format is the
 * only thing that says which of the two speaks for the post.
 */
export async function deadPublishes(userId: string, now: number): Promise<DeadPublish[]> {
  const rows = await getDb()
    .select({
      id: posts.id,
      topic: posts.topic,
      outputFormat: posts.outputFormat,
      wpPublishStatus: posts.wpPublishStatus,
      nextjsPublishStatus: posts.nextjsPublishStatus,
      updatedAt: posts.updatedAt,
      executionLogs: posts.executionLogs,
    })
    .from(posts)
    .innerJoin(websiteProfiles, eq(posts.profileId, websiteProfiles.id))
    .where(
      and(
        eq(websiteProfiles.userId, userId),
        or(
          inArray(posts.wpPublishStatus, NOT_LANDED),
          inArray(posts.nextjsPublishStatus, NOT_LANDED),
        ),
      ),
    )

  const dead: DeadPublish[] = []
  for (const row of rows) {
    const column = publishColumnOf({
      output_format: row.outputFormat ?? "",
      wp_publish_status: row.wpPublishStatus,
      nextjs_publish_status: row.nextjsPublishStatus,
      updated_at: null,
      execution_logs: null,
    })
    if (column === null) continue

    const entry = { id: row.id, topic: row.topic, target: column.target, label: column.label }
    if (column.status === "failed") {
      dead.push({ ...entry, stall: null })
      continue
    }

    const stall = publishStall({
      status: column.status,
      updatedAt: row.updatedAt?.toISOString() ?? null,
      executionLogs: row.executionLogs,
      now,
    })
    if (stall === null) continue
    dead.push({ ...entry, stall })
  }
  return dead
}
