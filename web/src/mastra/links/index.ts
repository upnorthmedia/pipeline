/**
 * `api/src/services/link_validator.py` ported to TypeScript.
 *
 * The edit stage runs every markdown link in the model's output through this
 * module and strips the ones that come back 404, 410 or 451. It is the only
 * part of the pipeline that reaches the public internet, and it is deliberately
 * conservative: a timeout, a connection error or any other status keeps the
 * link, because a transient failure must not delete a good citation.
 *
 * Three details do not survive a naive translation:
 *
 * * Python's `re.escape` escapes a superset of what JavaScript needs, but the
 *   two agree on every character that is actually special in a JavaScript
 *   regex, so `escapeRegExp` escapes the JavaScript set and the `u` flag is
 *   never used (`\&` is an error under `u` and an identity escape without it).
 * * `httpx`'s `timeout=10` is per connect/read/write/pool phase, where
 *   `AbortSignal.timeout` is a deadline over the whole request. A server that
 *   dribbles a response for longer than the deadline but never stalls 10s in
 *   one phase is answered by Python and aborted here. Both outcomes keep the
 *   link unless the slow answer was a 404, so the port errs conservative.
 * * Python iterates `dead_urls`, a `set`, whose order is hash-randomised per
 *   process. The substitutions are independent for every URL that appears in
 *   the content once, so order is unobservable in practice; this port
 *   substitutes in first-appearance order so it is deterministic at all.
 */

/** `_MD_LINK_RE`. Link text may be empty; the URL may not contain `)`. */
const MD_LINK_RE = /\[([^\]]*)\]\(([^)]+)\)/g

/** `_DEAD_STATUSES`. Everything else, including 5xx, keeps the link. */
const DEAD_STATUSES = new Set([404, 410, 451])

/** `_SEMAPHORE_LIMIT`. */
export const CONCURRENCY_LIMIT = 5

/** `_REQUEST_TIMEOUT`, in milliseconds. */
export const REQUEST_TIMEOUT_MS = 10_000

export interface RemovedLink {
  url: string
  status: number
  text: string
}

export interface ValidationResult {
  content: string
  removed: RemovedLink[]
}

export interface MarkdownLink {
  text: string
  url: string
}

/** `_MD_LINK_RE.findall(content)`, in match order. */
export function findMarkdownLinks(content: string): MarkdownLink[] {
  return [...content.matchAll(MD_LINK_RE)].map((match) => ({
    text: match[1],
    url: match[2],
  }))
}

/** The characters that are special in a JavaScript regex outside a class. */
function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")
}

/**
 * The substitution loop from `validate_links`: `[text](dead)` becomes `text`.
 * Exported because it is the half of this module that is pure and therefore
 * the half a test can pin exactly.
 */
export function stripDeadLinks(content: string, deadUrls: Iterable<string>): string {
  let cleaned = content
  for (const url of deadUrls) {
    cleaned = cleaned.replace(
      new RegExp(`\\[([^\\]]*)\\]\\(${escapeRegExp(url)}\\)`, "g"),
      "$1",
    )
  }
  return cleaned
}

/** `_check_url`. Returns the status code, or `null` on any error. */
async function checkUrl(url: string): Promise<number | null> {
  try {
    const response = await fetch(url, {
      method: "HEAD",
      redirect: "follow",
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    })
    return response.status
  } catch {
    return null
  }
}

/**
 * `asyncio.Semaphore(_SEMAPHORE_LIMIT)` over eagerly created tasks. Python
 * creates every task up front and the semaphore admits them in FIFO order, so
 * a pool of `limit` workers pulling from the head of the list is equivalent.
 */
async function mapWithLimit<T, R>(
  items: T[],
  limit: number,
  fn: (item: T) => Promise<R>,
): Promise<R[]> {
  const results = new Array<R>(items.length)
  let next = 0
  const worker = async (): Promise<void> => {
    while (next < items.length) {
      const index = next++
      results[index] = await fn(items[index])
    }
  }
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker))
  return results
}

/**
 * Validate every markdown link in `content`, stripping confirmed 404/410/451s.
 *
 * Relative and anchor links are skipped, as are schemes other than a
 * lower-case `http://` or `https://`, matching Python's case-sensitive
 * `str.startswith`.
 */
export async function validateLinks(content: string): Promise<ValidationResult> {
  const matches = findMarkdownLinks(content)
  if (matches.length === 0) {
    return { content, removed: [] }
  }

  const urlsToCheck = new Map<string, string[]>()
  for (const { text, url } of matches) {
    if (!url.startsWith("http://") && !url.startsWith("https://")) {
      continue
    }
    const texts = urlsToCheck.get(url)
    if (texts) {
      texts.push(text)
    } else {
      urlsToCheck.set(url, [text])
    }
  }

  if (urlsToCheck.size === 0) {
    return { content, removed: [] }
  }

  const urls = [...urlsToCheck.keys()]
  const statuses = await mapWithLimit(urls, CONCURRENCY_LIMIT, checkUrl)

  const deadUrls: string[] = []
  const removed: RemovedLink[] = []
  urls.forEach((url, index) => {
    const status = statuses[index]
    if (status === null || !DEAD_STATUSES.has(status)) {
      return
    }
    deadUrls.push(url)
    for (const text of urlsToCheck.get(url) ?? []) {
      removed.push({ url, status, text })
    }
  })

  if (deadUrls.length === 0) {
    return { content, removed: [] }
  }

  return { content: stripDeadLinks(content, deadUrls), removed }
}
