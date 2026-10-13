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
import {
  WP_URL_HAS_CREDENTIALS,
  WordPressClient,
  WordPressError,
  wordPressUrlHasCredentials,
} from "@/mastra/wordpress"

/**
 * The two credential complaints, both of which reach the dashboard: `/test`
 * hands them over as `error`, and `web/src/lib/api.ts` surfaces the `detail`
 * of the other two on the profile's WordPress tab.
 *
 * `WP_CREDENTIALS_MISSING` is Python's byte for byte and says something the
 * reader can act on. `WP_DECRYPT_FAILED` is not: Python's wording (kept below
 * as `PY_WP_DECRYPT_FAILED`) told the reader to check `WP_ENCRYPTION_KEY`, a
 * server environment variable nobody reading a profile page can see, let alone
 * check, and the only thing that reaches this branch through the
 * dashboard is a token written under a key this deployment no longer has. The
 * fix for that is to type the application password in again, so that is what
 * it now says. `wordpress.test.ts` keeps the oracle's record of Python's
 * wording and maps it through `reworded()`.
 */
export const WP_CREDENTIALS_MISSING = "WordPress credentials not configured on this profile"
export const WP_DECRYPT_FAILED =
  "The saved WordPress application password could not be read. Enter it again on this profile and save."

/** What Python said, kept so the parity oracle can be mapped onto the above. */
export const PY_WP_DECRYPT_FAILED =
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

  // Polish ledger item P2.107. `WP_URL_HAS_CREDENTIALS` and the predicate come
  // from the client, which refuses a credentialed `wp_url` in its constructor
  // for every caller. It is checked again here, before the constructor rather
  // than around it, so the answer keeps the `bad-request` shape these three
  // handlers already agree on: `/test` reports it as `{connected: false, error}`
  // and the two pickers as a 400 `detail`, where a throw would have to be
  // caught and re-mapped. `POST`/`PATCH /api/profiles` refuse such a value on
  // the way in (`checkWpUrl` in `../../validation.ts`), so what reaches here is
  // a row written before that check or around the API.
  if (wordPressUrlHasCredentials(profile.wpUrl)) {
    return { kind: "bad-request", detail: WP_URL_HAS_CREDENTIALS }
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

/**
 * The three handlers' shared answer for a failure that happened on the
 * WordPress side rather than on ours.
 *
 * Python let both kinds out of `/categories` and `/authors` uncaught, so an
 * expired application password, a user without `list_users`, or a site behind
 * a login wall all reached the dashboard's pickers as a bare 500 with no
 * reason attached while `/test` on the same profile reported the real message.
 * A 502 says the upstream is what failed, and `detail` is what
 * `apiErrorMessage()` in `web/src/lib/api.ts` unwraps for the user.
 *
 * `noun` names the thing being listed, so a payload missing a key reads as a
 * sentence rather than as a `KeyError`.
 */
export function upstreamFailure(error: unknown, noun: "category" | "author"): Response | null {
  if (error instanceof WordPressError) {
    return Response.json({ detail: error.message }, { status: 502 })
  }
  if (error instanceof WordPressFieldError) {
    return Response.json(
      { detail: `WordPress returned a ${noun} with no "${error.message}"` },
      { status: 502 },
    )
  }
  return null
}
