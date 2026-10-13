/**
 * `settings.media_dir` in `api/src/config.py`, and the per-post directory
 * underneath it.
 *
 * This lives in its own module because two unrelated callers need it: the
 * images stage, which writes generated files into it, and
 * `DELETE /api/posts/{post_id}`, which removes the directory after the row is
 * gone. A route handler reaching into `generate-one.ts` for a path helper read
 * like a mistake, and there is only one correct definition of the path.
 */
import { mkdir } from "node:fs/promises"
import path from "node:path"

/**
 * Same shape as `rulesDir()` in `../prompts.ts`, and for the same reason.
 * Python resolves the repository's `media/` directory relative to its own
 * source file and lets `MEDIA_DIR` override it in Docker; this keeps both
 * behaviours so a container that already sets `MEDIA_DIR` for the Python
 * worker needs no new variable.
 */
export function mediaRoot(): string {
  return process.env.MEDIA_DIR ?? path.resolve(process.cwd(), "..", "media")
}

/** `media_dir.mkdir(parents=True, exist_ok=True)`, run once before the fan-out. */
export async function ensureMediaDir(mediaRoot: string, postId: string): Promise<string> {
  const dir = path.join(mediaRoot, postId)
  await mkdir(dir, { recursive: true })
  return dir
}

/** `Path(settings.media_dir) / str(post_id)`, without creating it. */
export function postMediaDir(postId: string): string {
  return path.join(mediaRoot(), postId)
}
