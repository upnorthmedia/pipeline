import os from "node:os"
import path from "node:path"

/**
 * The one media directory a `pnpm test` run is allowed to write to.
 *
 * `mediaRoot()` falls back to the repository's own `media/` when `MEDIA_DIR` is
 * unset, so without this every suite that reaches the images step creates post
 * directories inside the working tree. `vitest.config.ts` puts this path in the
 * run's environment and `global-setup.ts` creates and removes it; both run in
 * vitest's main process, so deriving the name from `process.pid` is enough for
 * them to agree on it without a channel between them. The pid also keeps two
 * concurrent runs off each other's files, and `setup()` clears the directory
 * first so a recycled pid inherits nothing.
 */
export function testMediaRoot(): string {
  return path.join(os.tmpdir(), `jena-test-media-${process.pid}`)
}
