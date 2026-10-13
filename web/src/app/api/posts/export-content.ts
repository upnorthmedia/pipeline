/**
 * The content transformations `GET /api/posts/{post_id}/export/markdown` and
 * `/export/all` apply before handing the body back, ported from
 * `strip_leading_h1` in `api/src/pipeline/helpers.py` and the one-line media
 * URL rewrite in `api/src/api/posts.py`.
 *
 * Python's regex dialect and JavaScript's disagree in three places this
 * function walks straight through, so none of the patterns below are literal
 * transcriptions:
 *
 * - `re.MULTILINE` makes Python's `^` and `$` match around `\n` only, while
 *   JavaScript's `m` flag also matches around `\r`, ` ` and ` `.
 *   The Python semantics are written out as `(?:^|(?<=\n))` and `(?=\n|$)`
 *   instead of using `m`.
 * - Without `re.DOTALL` Python's `.` excludes `\n` alone; JavaScript's also
 *   excludes `\r`, so a heading containing a bare carriage return would end
 *   early. `[^\n]` is used wherever Python wrote a non-DOTALL `.`.
 * - `str.strip("\"'")` strips a *set* of characters from both ends until one
 *   that is not in the set is reached, which is not what any `trim`-shaped
 *   JavaScript API does.
 *
 * Two smaller differences are left in place because closing them would cost
 * more clarity than they are worth, and both are recorded in the ledger:
 * Python's `\s` covers `\x1c`-`\x1f` and `\x85` where JavaScript's does not,
 * JavaScript's covers `﻿` where Python's does not; and `str.lower()` and
 * `String.toLowerCase()` differ on a handful of non-Latin characters. The
 * parity oracle in `data/strip-leading-h1-parity.json` is what actually pins
 * the behaviour.
 */

/** `str.strip("\"'")`: both quote characters, from both ends, repeatedly. */
function stripQuotes(value: string): string {
  return value.replace(/^["']+/, "").replace(/["']+$/, "")
}

/**
 * Remove a leading H1 from a markdown body when it duplicates the frontmatter
 * title, because blog templates render the frontmatter `title` as the page H1
 * and the two together read as a duplicate.
 *
 * Every early return in the Python is preserved: content with no frontmatter,
 * frontmatter with no `title:` at the start of a line, a body that does not
 * open with an H1 (an H1 with no trailing newline does not count), and an H1
 * whose text does not match the title all come back untouched.
 */
export function stripLeadingH1(content: string): string {
  const frontmatter = /^---\s*\n([\s\S]*?)\n---\s*\n([\s\S]*)$/.exec(content)
  if (!frontmatter) return content

  const [, frontmatterBlock, body] = frontmatter

  const titleMatch = /(?:^|(?<=\n))title:\s*["']?([^\n]+?)["']?\s*(?=\n|$)/.exec(frontmatterBlock)
  if (!titleMatch) return content

  const fmTitle = titleMatch[1].trim()

  const h1 = /^\s*#\s+([^\n]+?)(?:\s*\n)/.exec(body)
  if (!h1) return content

  const h1Text = h1[1].trim()

  if (stripQuotes(h1Text.toLowerCase()) !== stripQuotes(fmTitle.toLowerCase())) return content

  // `body[h1_match.end():].lstrip("\n")`: only newlines, only from the left.
  const cleanedBody = body.slice(h1[0].length).replace(/^\n+/, "")
  return `---\n${frontmatterBlock}\n---\n\n${cleanedBody}`
}

/**
 * `export_content.replace(f"/media/{post_id}/", "/")`: every occurrence, not
 * the first. The id is lowercased because FastAPI handed the handler a parsed
 * `uuid.UUID` and `str()` on one is always the lowercase canonical form, so an
 * uppercase id in the request path still rewrote lowercase URLs.
 */
export function rewriteMediaUrls(content: string, postId: string): string {
  return content.replaceAll(`/media/${postId.toLowerCase()}/`, "/")
}
