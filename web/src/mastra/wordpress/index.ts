/**
 * `api/src/services/wordpress.py`, ported to TypeScript.
 *
 * `WordPressClient` is the REST client behind the three
 * `/api/profiles/{profile_id}/wordpress/*` endpoints (a connection test, the
 * category list and the author list) and behind the WordPress publish
 * workflow (`upload_media`, `create_post`, `update_post`).
 *
 * The behaviours that do not survive a naive translation:
 *
 * * `httpx.Timeout(30.0, read=120.0)` is a per-phase timeout where
 *   `AbortSignal.timeout` is a deadline over the whole request. A WordPress
 *   install that answers slowly but never stalls 120s inside one read is
 *   served by Python and aborted here. The deadline is set to the read value,
 *   the larger of the two, so the port is the more patient of the pair on
 *   connect and the less patient only on a response that takes over two
 *   minutes in total.
 * * `resp.text[:200]` slices 200 code points; `String.prototype.slice` slices
 *   200 UTF-16 code units. The two differ only for an error body carrying
 *   astral characters inside the first 200 of them.
 * * `resp.json()` is `json.loads`, which accepts `NaN`, `Infinity` and
 *   `-Infinity`; `JSON.parse` rejects all three. A WordPress install that
 *   emitted one would be a non-JSON response here and a parsed one in Python.
 * * The paginated calls do `results.extend(data)`, which for a 200 body that
 *   is a JSON object extends the list with that object's keys rather than
 *   failing. Spreading a non-iterable throws here instead. Only a `< 400`
 *   response reaches that line and every paginated WordPress collection
 *   endpoint answers with an array, so the divergence is unreachable through
 *   a real install.
 * * `json=` in httpx 0.28.1 serialises with `separators=(",", ":")` and
 *   `ensure_ascii=False`, which is `JSON.stringify`'s output byte for byte.
 *   The `wordpress-write-parity.json` oracle records the exact request bodies
 *   so that equivalence is asserted rather than assumed.
 * * Python's `**kwargs` carries `None` through to a JSON `null`, while
 *   `JSON.stringify` drops an `undefined` property entirely. `updatePost`
 *   therefore takes an explicit record and its caller must spell a cleared
 *   field `null`, not `undefined`.
 */

/** `WordPressError`. `statusCode` is null when the transport never answered. */
export class WordPressError extends Error {
  readonly statusCode: number | null

  constructor(message: string, statusCode: number | null = null) {
    super(message)
    this.name = "WordPressError"
    this.statusCode = statusCode
  }
}

/** `_STRIP_SUFFIXES`. Order matters: the first match wins and stops the scan. */
const STRIP_SUFFIXES = ["/wp-admin", "/wp-login.php", "/wp-json", "/wp-json/wp/v2"]

/** `httpx.Timeout(30.0, read=120.0)`'s read value, in milliseconds. */
export const WP_TIMEOUT_MS = 120_000

/** `per_page` on every paginated call, and the page-is-full test. */
const PER_PAGE = 100

/** `list_users`' default `roles`. */
const DEFAULT_ROLES = ["administrator", "editor", "author"]

/**
 * `WordPressClient.__init__`'s URL normalisation: drop every trailing slash,
 * then drop at most one known suffix, compared case-insensitively but sliced
 * off the original casing.
 */
export function normalizeWordPressUrl(wpUrl: string): string {
  let base = wpUrl.replace(/\/+$/, "")
  for (const suffix of STRIP_SUFFIXES) {
    if (base.toLowerCase().endsWith(suffix)) {
      base = base.slice(0, base.length - suffix.length)
      break
    }
  }
  return base
}

/** The `Authorization` header value `__init__` sets, `Basic <base64>`. */
export function basicAuthHeader(username: string, appPassword: string): string {
  const credentials = Buffer.from(`${username}:${appPassword}`, "utf8").toString("base64")
  return `Basic ${credentials}`
}

/**
 * `_request`'s error grammar for a `>= 400` response: the JSON body's
 * `message` if there is one, else the first 200 characters of the raw body.
 */
function errorDetail(text: string): string {
  let parsed: unknown
  try {
    parsed = JSON.parse(text)
  } catch {
    return text.slice(0, 200)
  }
  // `resp.json().get(...)` raises `AttributeError` for anything but a dict,
  // which Python catches and answers with the raw body. A JSON array needs no
  // guard of its own: it can never carry a `message` property, so it reaches
  // the same raw body through the fallback below. `null` does need one, since
  // reading a property off it throws rather than answering `undefined`.
  if (parsed === null || typeof parsed !== "object") {
    return text.slice(0, 200)
  }
  const message = (parsed as Record<string, unknown>).message
  if (message === undefined) {
    return text.slice(0, 200)
  }
  return typeof message === "string" ? message : String(message)
}

export class WordPressClient {
  readonly apiUrl: string
  readonly siteUrl: string
  private readonly authorization: string

  constructor(wpUrl: string, username: string, appPassword: string) {
    const base = normalizeWordPressUrl(wpUrl)
    this.apiUrl = `${base}/wp-json/wp/v2`
    this.siteUrl = `${base}/wp-json`
    this.authorization = basicAuthHeader(username, appPassword)
  }

  /** `_request`. */
  private async request(
    method: string,
    url: string,
    // `Uint8Array<ArrayBufferLike>` is not assignable to `BodyInit`, whose
    // `ArrayBufferView` arm is pinned to `ArrayBuffer`, so the upload body is
    // spelled out rather than widened with a cast.
    init: { body?: string | Uint8Array<ArrayBuffer>; headers?: Record<string, string> } = {},
  ): Promise<unknown> {
    const response = await fetch(url, {
      method,
      headers: { Authorization: this.authorization, ...init.headers },
      body: init.body,
      signal: AbortSignal.timeout(WP_TIMEOUT_MS),
    })
    const text = await response.text()
    if (response.status >= 400) {
      throw new WordPressError(
        `WordPress API error: ${errorDetail(text)}`,
        response.status,
      )
    }
    try {
      return JSON.parse(text)
    } catch {
      throw new WordPressError(
        // Copied verbatim from the Python source string, punctuation included,
        // because `GET /wordpress/test` returns it to the dashboard as `error`.
        "WordPress returned non-JSON response — check that the site URL is correct",
        response.status,
      )
    }
  }

  /**
   * The `while True` in `list_categories` and `list_users`: pages of 100 until
   * a short page arrives. A full page followed by an empty one costs the
   * extra request, exactly as it does in Python.
   */
  private async paginate(
    path: string,
    extra: Record<string, string> = {},
  ): Promise<unknown[]> {
    const results: unknown[] = []
    let page = 1
    for (;;) {
      const params = new URLSearchParams({ per_page: String(PER_PAGE), page: String(page) })
      for (const [key, value] of Object.entries(extra)) {
        params.set(key, value)
      }
      const data = (await this.get(`${path}?${params}`)) as unknown[]
      results.push(...data)
      if (data.length < PER_PAGE) {
        return results
      }
      page += 1
    }
  }

  /** The GET arm of `_request`, which is every read the client issues. */
  private get(url: string): Promise<unknown> {
    return this.request("GET", url)
  }

  /** The `json=` arm of `_request`: httpx sets `Content-Type` for it. */
  private postJson(url: string, payload: unknown): Promise<unknown> {
    return this.request("POST", url, {
      body: JSON.stringify(payload),
      headers: { "Content-Type": "application/json" },
    })
  }

  /** `test_connection`: the `/wp-json` root, which carries the site name. */
  testConnection(): Promise<unknown> {
    return this.get(this.siteUrl)
  }

  /** `list_categories`. */
  listCategories(): Promise<unknown[]> {
    return this.paginate(`${this.apiUrl}/categories`)
  }

  /** `list_users`, whose `roles` default is applied for a missing argument only. */
  listUsers(roles: string[] = DEFAULT_ROLES): Promise<unknown[]> {
    return this.paginate(`${this.apiUrl}/users`, { roles: roles.join(",") })
  }

  /**
   * `upload_media`. The bytes go up raw under a `Content-Disposition`
   * filename, not as multipart, and the alt text is a *second* request against
   * the attachment that was just created.
   *
   * Two guards worth naming, because both are truthiness tests rather than
   * presence tests: an empty `altText` sends no patch at all, and a response
   * whose `id` is missing or `0` sends none either. The return value is the
   * upload response, never the patch response, so alt text written by the
   * second call is not reflected in what the caller sees.
   *
   * A failing patch throws even though the upload already committed, leaving
   * an attachment on the site with no alt text. That is Python's behaviour and
   * it is preserved; the publish workflow's error path has to cope with it.
   */
  async uploadMedia(
    imageBytes: Uint8Array<ArrayBuffer>,
    filename: string,
    mimeType = "image/png",
    altText = "",
  ): Promise<unknown> {
    const media = await this.request("POST", `${this.apiUrl}/media`, {
      body: imageBytes,
      headers: {
        "Content-Disposition": `attachment; filename="${filename}"`,
        "Content-Type": mimeType,
      },
    })
    const id =
      media !== null && typeof media === "object"
        ? (media as Record<string, unknown>).id
        : undefined
    if (altText && id) {
      await this.postJson(`${this.apiUrl}/media/${id}`, { alt_text: altText })
    }
    return media
  }

  /**
   * `create_post`. `title`, `content` and `status` always ride along, even
   * when empty; the other four are dropped when falsy, so an empty
   * `categories` list, an `author` or `featuredMedia` of `0`, and an empty
   * `excerpt` are all indistinguishable from absent. Key order matches
   * Python's insertion order because the request body is compared byte for
   * byte against the oracle.
   */
  createPost(options: {
    title: string
    content: string
    status?: string
    categories?: number[] | null
    author?: number | null
    featuredMedia?: number | null
    excerpt?: string
  }): Promise<unknown> {
    const payload: Record<string, unknown> = {
      title: options.title,
      content: options.content,
      status: options.status ?? "publish",
    }
    if (options.categories && options.categories.length > 0) {
      payload.categories = options.categories
    }
    if (options.author) {
      payload.author = options.author
    }
    if (options.featuredMedia) {
      payload.featured_media = options.featuredMedia
    }
    if (options.excerpt) {
      payload.excerpt = options.excerpt
    }
    return this.postJson(`${this.apiUrl}/posts`, payload)
  }

  /**
   * `update_post`, whose `**kwargs` are forwarded with no filtering at all:
   * unlike `create_post` a null clears the field on the WordPress side rather
   * than being dropped. The parameter is a record of already-wire-shaped keys
   * (`featured_media`, not `featuredMedia`) for the same reason.
   */
  updatePost(wpPostId: number, fields: Record<string, unknown>): Promise<unknown> {
    return this.postJson(`${this.apiUrl}/posts/${wpPostId}`, fields)
  }
}
