/**
 * `_get_user_profile` and `_get_wp_client` from `api/src/api/wordpress.py`,
 * shared by the three `/api/profiles/{profile_id}/wordpress/*` handlers.
 *
 * The two functions are one lookup here because both of them read the same
 * row, but the order and the outcomes are unchanged: the profile is resolved
 * against the caller first, so another user's profile is a 404, and only then
 * are the WordPress credentials examined.
 *
 * The result is a discriminated union rather than a thrown error because the
 * three callers disagree about what to do with the two credential failures:
 * `/test` reports them as `{connected: false, error}` with a 200, while
 * `/categories` and `/authors` let them out as 400s.
 */
import { and, eq } from "drizzle-orm"

import { getDb, websiteProfiles } from "@/db"
import { decrypt } from "@/lib/crypto"
import { WordPressClient } from "@/mastra/wordpress"

/**
 * Both strings are copied byte for byte from the Python `HTTPException`
 * details, em dash included, because `/test` hands them to the dashboard as
 * `error` and `web/src/lib/api.ts` surfaces the `detail` of the other two.
 */
export const WP_CREDENTIALS_MISSING = "WordPress credentials not configured on this profile"
export const WP_DECRYPT_FAILED =
  "Failed to decrypt WordPress app password — check WP_ENCRYPTION_KEY"

export type WpClientResult =
  | { kind: "ok"; client: WordPressClient }
  | { kind: "not-found" }
  | { kind: "bad-request"; detail: string }

export async function resolveWpClient(
  profileId: string,
  userId: string,
): Promise<WpClientResult> {
  const rows = await getDb()
    .select({
      wpUrl: websiteProfiles.wpUrl,
      wpUsername: websiteProfiles.wpUsername,
      wpAppPassword: websiteProfiles.wpAppPassword,
    })
    .from(websiteProfiles)
    .where(and(eq(websiteProfiles.id, profileId), eq(websiteProfiles.userId, userId)))
    .limit(1)

  const profile = rows[0]
  if (!profile) return { kind: "not-found" }

  // `if not profile.wp_url or ...`: an empty string is as missing as a null.
  if (!profile.wpUrl || !profile.wpUsername || !profile.wpAppPassword) {
    return { kind: "bad-request", detail: WP_CREDENTIALS_MISSING }
  }

  let password: string
  try {
    password = decrypt(profile.wpAppPassword)
  } catch {
    // Python's `except Exception` covers both an invalid token and the
    // `ValueError` a missing `WP_ENCRYPTION_KEY` raises, and answers the same
    // 400 for either.
    return { kind: "bad-request", detail: WP_DECRYPT_FAILED }
  }

  return { kind: "ok", client: new WordPressClient(profile.wpUrl, profile.wpUsername, password) }
}

/**
 * The `c["id"]` / `u["slug"]` subscripts in the two list projections. Python
 * raised `KeyError` for an item missing one, which no handler caught, so the
 * request became a 500 and the caller got no partial list. JavaScript would
 * instead read `undefined` and `Response.json` would drop the key, answering
 * 200 with items that do not match `WPCategory` or `WPAuthor`, so the
 * exception is reproduced rather than the expression.
 */
export class WordPressFieldError extends Error {
  constructor(key: string) {
    super(key)
    this.name = "WordPressFieldError"
  }
}

export function requireField(item: Record<string, unknown>, key: string): unknown {
  if (!(key in item)) throw new WordPressFieldError(key)
  return item[key]
}
