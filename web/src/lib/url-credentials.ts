/**
 * Userinfo (`https://user:pass@host`) in the two profile URL columns.
 *
 * Both `website_profiles.website_url` and `website_profiles.wp_url` are plain
 * `text`, and a credential typed into either one is stored in the clear and
 * handed back out by `GET /api/profiles`. The write endpoints refuse a new one
 * (`../app/api/profiles/validation.ts`), and every reader of `wp_url` reports
 * one rather than sending it, but neither of those touches a row written
 * before those checks existed. This module is what lets the dashboard find
 * such a row and offer to clean it.
 *
 * Nothing here strips anything on its own. A stored URL is the operator's
 * value, so the repair is a button they press, not a migration that rewrites
 * the column behind them.
 */

/**
 * Whether `raw` carries a username or a password in front of the host.
 *
 * Empty userinfo is not a credential: the WHATWG parser reads
 * `https://@example.com` as `https://example.com/` with both halves empty, so
 * the bare `@` answers false. A value the parser cannot read at all answers
 * false too, because there is no authority to find a credential in and the
 * URL is already reported as unusable by the checks that care.
 */
export function hasUrlCredentials(raw: string | null | undefined): boolean {
  if (!raw) return false
  let url: URL
  try {
    url = new URL(raw)
  } catch {
    return false
  }
  return url.username !== "" || url.password !== ""
}

/**
 * `raw` with everything up to and including the authority's `@` removed, and
 * `raw` unchanged when there is nothing to remove.
 *
 * Spliced out of the string rather than round-tripped through `URL`, which
 * would also normalise the value: `new URL("https://u:p@example.com")` and
 * `toString()` answers `https://example.com/`, adding a path the operator did
 * not type. The rest of the URL has to survive byte for byte, because the
 * WordPress client concatenates onto it.
 */
export function stripUrlCredentials(raw: string): string {
  if (!hasUrlCredentials(raw)) return raw
  const scheme = raw.indexOf("://")
  if (scheme === -1) return raw
  const authorityStart = scheme + 3
  let authorityEnd = raw.length
  for (let i = authorityStart; i < raw.length; i += 1) {
    const char = raw[i]
    if (char === "/" || char === "?" || char === "#") {
      authorityEnd = i
      break
    }
  }
  const at = raw.lastIndexOf("@", authorityEnd - 1)
  if (at < authorityStart) return raw
  return raw.slice(0, authorityStart) + raw.slice(at + 1)
}

/**
 * What the operator is told when a stored URL turns out to carry one. Written
 * for the decision rather than for the parser: the credential cannot reach the
 * site from either column, so removing it costs nothing and stops a password
 * sitting in a plain-text column and on this screen.
 */
export const URL_CREDENTIALS_WARNING =
  "This address has a username and password in front of the site name. They are stored as " +
  "plain text and no request carries them, so remove them."
