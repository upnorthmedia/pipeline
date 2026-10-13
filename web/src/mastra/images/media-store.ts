/**
 * The generated images, in the one store both processes can read.
 *
 * `media-dir.ts` is the filesystem the images stage writes and the publish
 * steps walk. That filesystem is only ever one disk when the two processes
 * share it: locally they do (a compose volume), and on Railway they cannot,
 * because a volume attaches to a single service. It is mounted on `worker`,
 * which writes the files, so `web` serving `/media/<post_id>/<file>` reads a
 * different disk and answers 404 for every generated image.
 *
 * Postgres is already shared by both services, and the corpus is a handful of
 * optimized WebPs per post, so the bytes are mirrored into `post_media` at the
 * moment they are written and read back from there when the local disk does
 * not have them. That leaves the filesystem exactly what it was, which matters:
 * the WordPress and Next.js publish steps walk the directory with behaviour
 * pinned against Python, and they run in the worker, which has the disk.
 */
import { and, asc, eq } from "drizzle-orm"

import { getDb, postMedia } from "../../db"

/** One stored file: its bytes and when they were last written. */
export interface StoredMediaFile {
  filename: string
  bytes: Buffer
  updatedAt: Date
}

/**
 * Write the bytes of one generated image into the shared store.
 *
 * Keyed on `(post_id, filename)` and upserted rather than inserted, because a
 * re-run of the images stage writes the same filenames again, the same way it
 * overwrites the files on disk.
 */
export async function storeMediaFile(
  postId: string,
  filename: string,
  bytes: Uint8Array,
): Promise<void> {
  const body = Buffer.from(bytes)
  await getDb()
    .insert(postMedia)
    .values({ postId, filename, bytes: body, updatedAt: new Date() })
    .onConflictDoUpdate({
      target: [postMedia.postId, postMedia.filename],
      set: { bytes: body, updatedAt: new Date() },
    })
}

/** One file by name, or null when the store does not have it. */
export async function readStoredMediaFile(
  postId: string,
  filename: string,
): Promise<StoredMediaFile | null> {
  const rows = await getDb()
    .select()
    .from(postMedia)
    .where(and(eq(postMedia.postId, postId), eq(postMedia.filename, filename)))
    .limit(1)
  return rows[0] ?? null
}

/**
 * Every stored file for a post, by filename.
 *
 * Ordered by name so the export's zip entries land in the same order whichever
 * store they came from; the directory walk sorts too.
 */
export async function listStoredMediaFiles(postId: string): Promise<StoredMediaFile[]> {
  return getDb()
    .select()
    .from(postMedia)
    .where(eq(postMedia.postId, postId))
    .orderBy(asc(postMedia.filename))
}
