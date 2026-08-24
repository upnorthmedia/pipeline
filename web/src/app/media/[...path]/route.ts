/**
 * Port of the `/media` static mount in `api/src/main.py`.
 *
 * FastAPI served the generated images with
 * `app.mount("/media", StaticFiles(directory=settings.media_dir))`, and
 * `content-preview.tsx` still resolves every `/media/<post_id>/<file>` URL the
 * images stage writes into `image_manifest`. Deleting the Python service takes
 * that mount with it, so the Next.js app has to serve the same directory or
 * every generated image in the dashboard 404s.
 *
 * Two deliberate differences from `StaticFiles`:
 *
 * 1. **The request is scoped to the post's owner.** The mount was anonymous,
 *    which predates the `website_profiles.user_id` column; a generated image is
 *    post content, and every other handler that reads post content joins
 *    through the profile. A file belonging to another user answers exactly like
 *    a file that does not exist, matching `_get_user_post()`'s rule that an
 *    unowned post is indistinguishable from a missing one.
 * 2. **A file the local disk does not have is looked up in `post_media`.**
 *    The images stage runs in the worker, and on Railway a volume attaches to
 *    a single service, so the disk this handler can see is not the disk the
 *    files were written to. `../../../mastra/images/media-store` is the copy
 *    both services share; see its header for why the filesystem stays.
 * 3. **Content types come from the small table below, not from
 *    `guessTypeFromFilename()`.** That function reproduces Python 3.12's
 *    builtin table, which has no `.webp` entry (see
 *    `mastra/wordpress/mimetypes.ts`), so Starlette labelled every generated
 *    image `text/plain` and browsers only rendered them by sniffing. Serving
 *    the real type is strictly better and costs a six-entry map.
 */
import { readFile, stat } from "node:fs/promises"
import path from "node:path"

import { and, eq } from "drizzle-orm"

import { getDb, posts, websiteProfiles } from "@/db"
import { getRequestUser, unauthorized } from "@/lib/request-auth"
import { mediaRoot } from "@/mastra/images/media-dir"
import { readStoredMediaFile } from "@/mastra/images/media-store"

import { isUuid } from "../../api/posts/params"

/**
 * The images stage only ever writes `.webp` (`optimizeImage()` returns that
 * extension unconditionally), so the rest of the table covers files dropped
 * into the directory by hand. Anything else is served as a download rather
 * than guessed at.
 */
const CONTENT_TYPES: Record<string, string> = {
  ".webp": "image/webp",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".gif": "image/gif",
  ".avif": "image/avif",
}

/** Starlette's 404 body for a missing static file, which `api.ts` surfaces verbatim. */
function notFound(): Response {
  return Response.json({ detail: "Not Found" }, { status: 404 })
}

/**
 * `"<size>-<mtime-ms>"`. Filenames are reused when the images stage is re-run,
 * so the entity tag has to change with the bytes rather than with the name.
 */
function etagFor(size: number, mtimeMs: number): string {
  return `"${size.toString(16)}-${Math.floor(mtimeMs).toString(16)}"`
}

/** The bytes and the moment they were last written, from whichever store has them. */
interface ServedFile {
  /**
   * `Buffer<ArrayBuffer>` rather than `Buffer`: `BodyInit` only accepts a view
   * over a real `ArrayBuffer`, and a `Buffer` from the driver is typed over
   * `ArrayBufferLike`, which could be a `SharedArrayBuffer`.
   */
  bytes: Buffer<ArrayBuffer>
  modifiedMs: number
}

/**
 * The local disk first, then the shared store.
 *
 * Disk first because when the two processes do share it, which is every local
 * and compose run, that is the whole answer and no bytes cross the database
 * connection. The stored copy is what the `web` service on Railway has, and
 * what a post generated before the mirror existed does not.
 */
async function readMedia(file: string, postId: string, filename: string): Promise<ServedFile | null> {
  const info = await stat(file).catch(() => null)
  if (info?.isFile()) return { bytes: await readFile(file), modifiedMs: info.mtimeMs }

  const stored = await readStoredMediaFile(postId, filename)
  if (!stored) return null
  return { bytes: Buffer.from(stored.bytes), modifiedMs: stored.updatedAt.getTime() }
}

export async function GET(
  request: Request,
  { params }: { params: Promise<{ path: string[] }> },
): Promise<Response> {
  const user = await getRequestUser(request)
  if (!user) return unauthorized()

  const segments = (await params).path
  if (segments.length !== 2) return notFound()

  const [postId, filename] = segments
  if (!isUuid(postId)) return notFound()

  const postDir = path.join(mediaRoot(), postId)
  const file = path.resolve(postDir, filename)
  // A segment can still carry a separator when the client percent-encodes one,
  // so the resolved path, not the raw name, is what decides containment.
  if (path.dirname(file) !== path.resolve(postDir)) return notFound()

  const owned = await getDb()
    .select({ id: posts.id })
    .from(posts)
    .innerJoin(websiteProfiles, eq(posts.profileId, websiteProfiles.id))
    .where(and(eq(posts.id, postId), eq(websiteProfiles.userId, user.id)))
    .limit(1)
  if (owned.length === 0) return notFound()

  const served = await readMedia(file, postId, filename)
  if (!served) return notFound()

  const etag = etagFor(served.bytes.length, served.modifiedMs)
  const headers = new Headers({
    "Content-Type": CONTENT_TYPES[path.extname(filename).toLowerCase()] ?? "application/octet-stream",
    "Content-Length": String(served.bytes.length),
    "Last-Modified": new Date(served.modifiedMs).toUTCString(),
    ETag: etag,
    // Owner-scoped, and rewritten in place by a re-run of the images stage, so
    // a shared cache must not hold it and a private one must revalidate.
    "Cache-Control": "private, max-age=0, must-revalidate",
    "X-Content-Type-Options": "nosniff",
  })

  if (request.headers.get("if-none-match") === etag) {
    // A 304 carries no content, so it must not claim a length for one.
    const revalidated = new Headers(headers)
    revalidated.delete("Content-Length")
    return new Response(null, { status: 304, headers: revalidated })
  }

  return new Response(served.bytes, { status: 200, headers })
}
