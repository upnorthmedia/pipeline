/**
 * Port of `GET /api/posts/{post_id}/export/all` in `api/src/api/posts.py`.
 *
 * The markdown export plus every file sitting in the post's media directory,
 * bundled into one zip. The content selection, the H1 strip and the media URL
 * rewrite are the same three steps `/export/markdown` runs, shared through
 * `export-content.ts`; the 404 detail for missing content is not the same
 * string, so it is spelled out here rather than shared.
 *
 * Python built the whole archive in a `BytesIO` and then handed that buffer to
 * `StreamingResponse`, so nothing was ever streamed in the sense of being
 * produced lazily. A `Response` over the finished bytes is the same thing
 * without the indirection.
 *
 * `fflate` is the zip writer. Node has no zip API, and of the candidates it is
 * the only one that is dependency-free and offers a synchronous whole-archive
 * call that matches what Python was doing: `archiver` is a stream pipeline with
 * a large dependency tree and is only present here as a transitive dependency
 * of the `mastra` CLI, and `jszip` is several times the size for an async API
 * this code has no use for. `zipSync`'s default level 6 deflate is the same
 * method Python's `ZIP_DEFLATED` selects.
 *
 * `zf.write()` copies the source file's modification time into the archive
 * entry while `writestr` stamps the current time, so the images carry their
 * `stat` mtime and the `.mdx` entry does not.
 *
 * Two consequences of `zipSync` taking an object rather than an ordered list of
 * entries, both recorded in the ledger: an image whose name collides with
 * `<slug>.mdx` replaces it instead of producing the duplicate-name archive
 * Python emits with a warning, and an image named with a canonical integer
 * string would be moved to the front of the archive by JavaScript's own key
 * ordering. Neither changes any file's contents.
 */
import { readdir, readFile, stat } from "node:fs/promises"
import path from "node:path"

import { and, eq } from "drizzle-orm"
import { zipSync } from "fflate"

import { getDb, posts, websiteProfiles } from "@/db"
import { getRequestUser, unauthorized } from "@/lib/request-auth"
import { postMediaDir } from "@/mastra/images/media-dir"

import { rewriteMediaUrls, stripLeadingH1 } from "../../../export-content"
import { isUuid, postNotFound, unprocessableUuid } from "../../../params"

interface MediaFile {
  name: string
  body: Uint8Array
  mtime: number
}

/**
 * `[f for f in media_dir.iterdir() if f.is_file()]`, guarded by
 * `media_dir.is_dir()`.
 *
 * `Path.is_file()` follows symlinks and answers `False` rather than raising
 * when the target is missing, which `Dirent.isFile()` does not reproduce: the
 * directory entry itself is what `readdir` reports on, so a symlink to an image
 * would be skipped. Each entry is therefore `stat`ed, and a failing `stat` is
 * the broken-symlink case Python swallows.
 */
async function readMediaFiles(dir: string): Promise<MediaFile[]> {
  let names: string[]
  try {
    if (!(await stat(dir)).isDirectory()) return []
    names = await readdir(dir)
  } catch {
    return []
  }

  const files: MediaFile[] = []
  for (const name of names) {
    const full = path.join(dir, name)
    try {
      const info = await stat(full)
      if (!info.isFile()) continue
      files.push({ name, body: new Uint8Array(await readFile(full)), mtime: info.mtimeMs })
    } catch {
      continue
    }
  }
  return files
}

export async function GET(
  request: Request,
  { params }: { params: Promise<{ id: string }> },
): Promise<Response> {
  const user = await getRequestUser(request)
  if (!user) return unauthorized()

  const { id } = await params
  if (!isUuid(id)) return unprocessableUuid(id)

  const rows = await getDb()
    .select({
      slug: posts.slug,
      readyContent: posts.readyContent,
      finalMdContent: posts.finalMdContent,
    })
    .from(posts)
    .innerJoin(websiteProfiles, eq(posts.profileId, websiteProfiles.id))
    .where(and(eq(posts.id, id), eq(websiteProfiles.userId, user.id)))
    .limit(1)

  if (rows.length === 0) return postNotFound()
  const post = rows[0]

  const content = post.readyContent || post.finalMdContent
  if (!content) {
    return Response.json({ detail: "No content available to export" }, { status: 404 })
  }

  // `str(post_id)` again: the media directory is named with the lowercase
  // canonical uuid FastAPI parsed, whatever case the request path carried.
  const entries: Record<string, Uint8Array | [Uint8Array, { mtime: number }]> = {
    [`${post.slug}.mdx`]: new TextEncoder().encode(rewriteMediaUrls(stripLeadingH1(content), id)),
  }
  for (const file of await readMediaFiles(postMediaDir(id.toLowerCase()))) {
    entries[file.name] = [file.body, { mtime: file.mtime }]
  }

  return new Response(zipSync(entries), {
    status: 200,
    headers: {
      "Content-Type": "application/zip",
      "Content-Disposition": `attachment; filename="${post.slug}.zip"`,
    },
  })
}
