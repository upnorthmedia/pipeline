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
 * 2. **Content types come from the small table below, not from
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

  const info = await stat(file).catch(() => null)
  if (!info?.isFile()) return notFound()

  const etag = etagFor(info.size, info.mtimeMs)
  const headers = new Headers({
    "Content-Type": CONTENT_TYPES[path.extname(filename).toLowerCase()] ?? "application/octet-stream",
    "Content-Length": String(info.size),
    "Last-Modified": new Date(info.mtimeMs).toUTCString(),
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

  return new Response(await readFile(file), { status: 200, headers })
}
