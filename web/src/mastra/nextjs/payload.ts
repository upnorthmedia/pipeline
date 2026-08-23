/**
 * The Next.js webhook payload, ported from the block in `publish_to_nextjs`
 * that runs between the `publishing` status commit and `sign_payload`
 * (`api/src/services/nextjs_publish.py`, ledger item 5.3c-iii-b-2-c).
 *
 * Three straight-line pieces: pick the content, walk `image_manifest` reading
 * each file off disk, then `json.dumps` the seven-key body. The bytes that
 * produces are what the HMAC signature covers and what
 * `packages/create-mdx-blog` verifies, so they are the contract.
 *
 * What is not a plain transcription:
 *
 * - `manifest.get`, `img.get` and `"/" in url` are Python attribute lookup and
 *   Python membership over a JSONB column holding model output. A manifest
 *   that is a string, an `images` that is `null`, or an entry that is a list
 *   raises `AttributeError` or `TypeError` out of `publish_to_nextjs`, which
 *   catches neither, so the publish fails rather than skipping the entry.
 * - `if not url` and `if not actual_filename` are Python truthiness, so `0`,
 *   `false`, `[]` and `{}` are all "no url" while `5` is a url that then fails
 *   the membership test.
 * - `Path.is_file()` swallows `ENOENT`, `ENOTDIR`, `EBADF`, `ELOOP` and the
 *   `ValueError` from an embedded NUL, and lets everything else through. A
 *   `url` ending in `..`, naming a directory, or naming a file that is not
 *   there all record `"data": null`; a name too long for the filesystem raises.
 *
 * Verified against `data/nextjs-payload-parity.json`, written by
 * `api/scripts/export_nextjs_payload_parity.py` from the real block.
 */
import { readFile } from "node:fs/promises"

import { pythonTypeName } from "../wordpress/media-upload"
import { statOrAbsent } from "../wordpress/media-walk"
import { applyMappingToContent, pyTruthy } from "./apply-mapping-to-content"
import { pythonJsonDumps } from "./json-dumps"
import { PyAttributeError, PyTypeError } from "./pyyaml/values"

/**
 * An `OSError` that `Path.is_file()` or `Path.read_bytes()` let through.
 *
 * The message is not Python's: Node reports a symbolic code where CPython
 * reports `[Errno N] <strerror>`, and the numbering is platform specific. Only
 * the fact of the failure and the path it happened on are preserved.
 */
export class PyOSError extends Error {
  constructor(
    readonly code: string,
    readonly path: string,
  ) {
    super(`${code}: '${path}'`)
    this.name = "OSError"
  }
}

/** `value.get(key, fallback)`, which needs `value` to be a dict. */
function pyGet(value: unknown, key: string, fallback: unknown): unknown {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new PyAttributeError(
      `'${pythonTypeName(value)}' object has no attribute 'get'`,
    )
  }
  const record = value as Record<string, unknown>
  // `.get` reads a stored `null` as the value, not as a missing key, so
  // `{"alt_text": null}` yields `null` rather than the `""` default.
  return Object.hasOwn(record, key) ? record[key] : fallback
}

/** `for item in value`, over the JSON values a JSONB column can hold. */
function pyIterate(value: unknown): unknown[] {
  if (Array.isArray(value)) return value
  // Iterating a dict yields its keys, which are strings, which is why a
  // manifest storing `images` as an object fails on `img.get` rather than here.
  if (typeof value === "string") return Array.from(value)
  if (value !== null && typeof value === "object") {
    return Object.keys(value as Record<string, unknown>)
  }
  throw new PyTypeError(`'${pythonTypeName(value)}' object is not iterable`)
}

/** `needle in haystack`. */
function pyContains(haystack: unknown, needle: string): boolean {
  if (typeof haystack === "string") return haystack.includes(needle)
  if (Array.isArray(haystack)) return haystack.includes(needle)
  if (haystack !== null && typeof haystack === "object") {
    return Object.hasOwn(haystack as Record<string, unknown>, needle)
  }
  throw new PyTypeError(
    `argument of type '${pythonTypeName(haystack)}' is not iterable`,
  )
}

/**
 * `value.rsplit("/", 1)[-1]`. `lastIndexOf` returning -1 slices from 0, which
 * is the whole string, which is what `rsplit` returns when it finds no
 * separator.
 */
function lastSegment(value: unknown): string {
  if (typeof value !== "string") {
    throw new PyAttributeError(
      `'${pythonTypeName(value)}' object has no attribute 'rsplit'`,
    )
  }
  return value.slice(value.lastIndexOf("/") + 1)
}

/** One entry of the payload's `images` array, in Python's key order. */
export interface PayloadImage {
  filename: string
  public_path: unknown
  alt: unknown
  placement: unknown
  data: string | null
}

/** The post columns the payload reads. */
export interface PayloadPost {
  id: string
  slug: string
  readyContent: string | null
  finalMdContent: string | null
  imageManifest: unknown
}

/** `post.ready_content or post.final_md_content or ""`. */
export function selectContent(post: PayloadPost): string {
  return post.readyContent || post.finalMdContent || ""
}

/**
 * The `image_manifest` walk: every entry with a usable url, its file read off
 * disk and base64-encoded when one is there.
 *
 * `mediaDir` is `settings.media_dir`; `postId` is joined onto it exactly as
 * `Path(settings.media_dir) / post_id` does.
 */
export async function buildPayloadImages(
  manifest: unknown,
  mediaDir: string,
  postId: string,
  onMissing?: (path: string) => void,
): Promise<PayloadImage[]> {
  const images: PayloadImage[] = []
  const postDir = `${mediaDir}/${postId}`
  // `post.image_manifest or {"images": []}`: an empty dict, an empty list and a
  // stored `0` are all falsy, so they take the default rather than the column.
  const source = pyTruthy(manifest) ? manifest : { images: [] }

  for (const entry of pyIterate(pyGet(source, "images", []))) {
    const url = pyGet(entry, "url", "")
    if (!pyTruthy(url)) continue

    const filename = pyContains(url, "/") ? lastSegment(url) : ""
    if (filename === "") continue

    const target = `${postDir}/${filename}`
    let data: string | null = null
    if (await isFile(target)) {
      data = (await readBytes(target)).toString("base64")
    } else {
      onMissing?.(target)
    }

    images.push({
      filename,
      public_path: url,
      alt: pyGet(entry, "alt_text", ""),
      placement: pyGet(entry, "placement", "inline"),
      data,
    })
  }
  return images
}

async function isFile(target: string): Promise<boolean> {
  try {
    return (await statOrAbsent(target))?.isFile() ?? false
  } catch (error) {
    throw asOSError(error, target)
  }
}

async function readBytes(target: string): Promise<Buffer> {
  try {
    return await readFile(target)
  } catch (error) {
    throw asOSError(error, target)
  }
}

function asOSError(error: unknown, target: string): Error {
  const code = (error as NodeJS.ErrnoException).code
  return code ? new PyOSError(code, target) : (error as Error)
}

/** Arguments of the `json.dumps` at the end of the block. */
export interface NextjsPayloadOptions {
  post: PayloadPost
  /** `profile.nextjs_frontmatter_map`, straight off the JSONB column. */
  frontmatterMap: unknown
  /** `post_id` as the job received it, which names the media directory. */
  postId: string
  /** `settings.media_dir`. */
  mediaDir: string
  /** `str(uuid.uuid4())`. */
  deliveryId: string
  /** `datetime.now(UTC).isoformat()`. */
  timestamp: string
  onMissing?: (path: string) => void
}

/** The signed body: content, images and the seven-key `json.dumps`. */
export async function buildNextjsPayload(
  options: NextjsPayloadOptions,
): Promise<string> {
  const { post, frontmatterMap, postId, mediaDir } = options
  let content = selectContent(post)
  // The mapping runs before the walk, so a mapping that raises fails the
  // publish without any image having been read.
  if (pyTruthy(frontmatterMap)) {
    content = applyMappingToContent(content, toMapping(frontmatterMap))
  }
  const images = await buildPayloadImages(
    post.imageManifest,
    mediaDir,
    postId,
    options.onMissing,
  )

  return pythonJsonDumps({
    event: "post.published",
    post_id: post.id,
    delivery_id: options.deliveryId,
    slug: post.slug,
    content,
    images,
    timestamp: options.timestamp,
  })
}

/**
 * `nextjs_frontmatter_map` as the mapping `apply_frontmatter_mapping` wants. A
 * `Map` rather than the object it arrived as, because `__proto__` is an
 * ordinary key of a Python dict and a mapping target may be one.
 */
export function toMapping(value: unknown): ReadonlyMap<unknown, unknown> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    // `if profile.nextjs_frontmatter_map:` has already rejected the falsy
    // values, so a non-dict here is a truthy string or list, which
    // `apply_frontmatter_mapping` iterates as one.
    throw new PyAttributeError(
      `'${pythonTypeName(value)}' object has no attribute 'items'`,
    )
  }
  return new Map(Object.entries(value as Record<string, unknown>))
}

/**
 * `datetime.now(UTC).isoformat()`. Python prints microseconds and omits the
 * fractional part entirely when they are zero; a `Date` only carries
 * milliseconds, so the last three digits are always `000`.
 */
export function isoformatUtc(date: Date): string {
  const iso = date.toISOString()
  const milliseconds = date.getUTCMilliseconds()
  const seconds = iso.slice(0, 19)
  return milliseconds === 0
    ? `${seconds}+00:00`
    : `${seconds}.${String(milliseconds).padStart(3, "0")}000+00:00`
}
