/**
 * `api/src/services/analytics.py` ported to TypeScript.
 *
 * The edit stage prints every number this module returns straight into its
 * prompt, so the port is byte-exact rather than approximate. Three primitives
 * do not survive a naive translation and are spelled out here instead:
 *
 * * `round()` is round-half-to-even (see `pythonRound`),
 * * `re.MULTILINE`'s `^` matches only after `\n`, where JavaScript's `m` flag
 *   also matches after `\r`, `U+2028` and `U+2029`, so the multiline anchors
 *   are written as `(?:^|(?<=\n))` and the `m` flag is never used,
 * * Python's `.` excludes `\n` alone, where JavaScript's excludes `\r`,
 *   `U+2028` and `U+2029` too, so `.` is written as `[^\n]`.
 *
 * `str.split()` and `str.strip()` come from the `textstat` port, which already
 * spells out Python's whitespace class.
 */
import { PY_WHITESPACE, countSentences, fleschReadingEase, pythonSplit, pythonStrip } from "../textstat"
import { pythonRound } from "./python-round"

export interface ContentAnalytics {
  wordCount: number
  sentenceCount: number
  paragraphCount: number
  avgSentenceLength: number
  fleschReadingEase: number
  keywordDensity: Record<string, number>
  /**
   * `_seo_checklist`'s mixed dict: booleans for the checks and integers for the
   * two link counts, in Python's insertion order, which the edit prompt renders
   * in. `edit_node` filters on `isinstance(passed, bool)`, so the counts are
   * carried but not printed.
   */
  seoChecklist: Record<string, boolean | number>
}

export interface ComputeAnalyticsOptions {
  primaryKeyword?: string
  secondaryKeywords?: string[]
  title?: string
  websiteUrl?: string
}

const OUTER_FENCE_OPEN = new RegExp(`^\`\`\`(?:markdown|md)?[${PY_WHITESPACE}]*\\n`, "u")
const OUTER_FENCE_CLOSE = new RegExp(`\\n\`\`\`[${PY_WHITESPACE}]*$`, "u")

const FRONTMATTER = /^---\n[\s\S]*?\n---\n/
const HTML_TAG = /<[^>]+>/g
const HEADING_PREFIX = new RegExp(`(?:^|(?<=\\n))#{1,6}[${PY_WHITESPACE}]+`, "gu")
const EMPHASIS = /[*_]{1,3}/g
const IMAGE = /!\[([^\]]*)\]\([^)]+\)/g
const LINK = /\[([^\]]+)\]\([^)]+\)/g
const CODE_BLOCK = /```[\s\S]*?```/g
const INLINE_CODE = /`[^`]+`/g
const BLOCKQUOTE_PREFIX = new RegExp(`(?:^|(?<=\\n))>[${PY_WHITESPACE}]+`, "gu")
const BLANK_LINE_RUN = /\n{3,}/g

const H2 = new RegExp(`(?:^|(?<=\\n))##[${PY_WHITESPACE}]+([^\\n]+)(?=\\n|$)`, "gu")
const MARKDOWN_LINK = /\[([^\]]+)\]\(([^)]+)\)/g
const META_DESCRIPTION = new RegExp(`(?:^|(?<=\\n))description:[${PY_WHITESPACE}]*[^\\n]+`, "u")

const EMPTY_ANALYTICS: ContentAnalytics = {
  wordCount: 0,
  sentenceCount: 0,
  paragraphCount: 0,
  avgSentenceLength: 0,
  fleschReadingEase: 0,
  keywordDensity: {},
  seoChecklist: {},
}

/** `compute_analytics`. */
export function computeAnalytics(
  content: string,
  options: ComputeAnalyticsOptions = {},
): ContentAnalytics {
  if (!content) return { ...EMPTY_ANALYTICS, keywordDensity: {}, seoChecklist: {} }

  const primaryKeyword = options.primaryKeyword ?? ""
  const secondaryKeywords = options.secondaryKeywords ?? []
  const title = options.title ?? ""
  const websiteUrl = options.websiteUrl ?? ""

  // Unwrap the outer code fence the LLM wraps its answer in, before any analysis.
  const unwrapped = pythonStrip(content).replace(OUTER_FENCE_OPEN, "").replace(OUTER_FENCE_CLOSE, "")

  const plain = stripMarkdown(unwrapped)

  const wordCount = pythonSplit(plain).length
  const sentences = countSentences(plain)
  const paragraphs = unwrapped.split("\n\n").filter((p) => pythonStrip(p) !== "").length

  const avgSentenceLength = sentences > 0 ? wordCount / sentences : 0
  const flesch = fleschReadingEase(plain)

  const density: Record<string, number> = {}
  const plainLower = plain.toLowerCase()
  if (primaryKeyword && wordCount > 0) {
    const keyword = primaryKeyword.toLowerCase()
    const occurrences = countSubstring(plainLower, keyword)
    const keywordWords = pythonSplit(keyword).length
    density[primaryKeyword] = pythonRound(((occurrences * keywordWords) / wordCount) * 100, 2)
  }
  for (const keyword of secondaryKeywords) {
    if (keyword && wordCount > 0) {
      const lowered = keyword.toLowerCase()
      const occurrences = countSubstring(plainLower, lowered)
      const keywordWords = pythonSplit(lowered).length
      density[keyword] = pythonRound(((occurrences * keywordWords) / wordCount) * 100, 2)
    }
  }

  return {
    wordCount,
    sentenceCount: sentences,
    paragraphCount: paragraphs,
    avgSentenceLength: pythonRound(avgSentenceLength, 1),
    fleschReadingEase: pythonRound(flesch, 1),
    keywordDensity: density,
    seoChecklist: seoChecklist(unwrapped, plain, title, primaryKeyword, websiteUrl),
  }
}

/** `_seo_checklist`. */
export function seoChecklist(
  markdown: string,
  plain: string,
  title: string,
  primaryKeyword: string,
  websiteUrl = "",
): Record<string, boolean | number> {
  const keyword = primaryKeyword ? primaryKeyword.toLowerCase() : ""
  const checks: Record<string, boolean | number> = {}

  checks.keyword_in_title = Boolean(keyword && title.toLowerCase().includes(keyword))

  const first100 = pythonSplit(plain).slice(0, 100).join(" ").toLowerCase()
  checks.keyword_in_first_100_words = Boolean(keyword && first100.includes(keyword))

  const h2s = [...markdown.matchAll(H2)].map((match) => match[1])
  checks.keyword_in_h2 = Boolean(keyword && h2s.some((h2) => h2.toLowerCase().includes(keyword)))
  checks.has_h2_headings = h2s.length > 0

  const domain = websiteUrl ? urlNetloc(websiteUrl) : ""
  const links = [...markdown.matchAll(MARKDOWN_LINK)].map((match) => match[2])
  const internalLinks = links.filter(
    (url) =>
      url.startsWith("/") ||
      url.startsWith("#") ||
      Boolean(domain && urlNetloc(url).includes(domain)),
  )
  const externalLinks = links.filter(
    (url) => url.startsWith("http") && !(domain && urlNetloc(url).includes(domain)),
  )
  checks.has_internal_links = internalLinks.length >= 1
  checks.has_external_links = externalLinks.length >= 1
  checks.internal_link_count = internalLinks.length
  checks.external_link_count = externalLinks.length

  checks.has_meta_description = META_DESCRIPTION.test(markdown)

  return checks
}

/** `_strip_markdown`. */
export function stripMarkdown(text: string): string {
  let out = text.replace(FRONTMATTER, "")
  out = out.replace(HTML_TAG, "")
  out = out.replace(HEADING_PREFIX, "")
  out = out.replace(EMPHASIS, "")
  out = out.replace(IMAGE, "$1")
  out = out.replace(LINK, "$1")
  out = out.replace(CODE_BLOCK, "")
  out = out.replace(INLINE_CODE, "")
  out = out.replace(BLOCKQUOTE_PREFIX, "")
  out = out.replace(BLANK_LINE_RUN, "\n\n")
  return pythonStrip(out)
}

/** Python's `str.count`: non-overlapping occurrences. */
function countSubstring(haystack: string, needle: string): number {
  if (!needle) return haystack.length + 1
  let count = 0
  let from = 0
  for (;;) {
    const found = haystack.indexOf(needle, from)
    if (found === -1) return count
    count += 1
    from = found + needle.length
  }
}

/**
 * `urllib.parse.urlparse(url).netloc`.
 *
 * Only the authority is needed, and only for a substring comparison against the
 * profile's own domain, but the parse still has to be Python's: a URL with no
 * `//` has no netloc at all, so a bare `example.com` on either side of the
 * comparison classifies every link as external.
 */
export function urlNetloc(url: string): string {
  // `_UNSAFE_URL_BYTES_TO_REMOVE`, then WHATWG C0-control-or-space stripping.
  let rest = url.replace(/[\t\n\r]/g, "").replace(/^[\0-\x20]+/, "").replace(/[\0-\x20]+$/, "")
  const colon = rest.indexOf(":")
  if (colon > 0 && /[A-Za-z]/.test(rest[0]) && /^[A-Za-z0-9+\-.]*$/.test(rest.slice(1, colon))) {
    rest = rest.slice(colon + 1)
  }
  if (!rest.startsWith("//")) return ""
  const authority = rest.slice(2)
  const delimiter = authority.search(/[/?#]/)
  return delimiter === -1 ? authority : authority.slice(0, delimiter)
}
