import path from "node:path"
import { fileURLToPath } from "node:url"
import { readdir, rm, writeFile } from "node:fs/promises"
import { describe, expect, it } from "vitest"

import { ensureMediaDir, mediaRoot, postMediaDir } from "@/mastra/images/media-dir"

/**
 * `mediaRoot()` falls back to the repository's own `media/` when `MEDIA_DIR` is
 * unset, which is the right default for `pnpm dev` and the wrong one for a test
 * run: every suite that reaches the images step then creates a post directory
 * inside the working tree. The run-wide `MEDIA_DIR` in `vitest.config.ts` is
 * what keeps those writes in a temp directory, and this file is what notices
 * when it stops being set.
 *
 * The check is on the resolver rather than on the leftover files, because a
 * directory the suite creates and an image it writes are the same defect and
 * only the resolver is observable before the damage.
 */

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../..")

function isInside(parent: string, child: string): boolean {
  const rel = path.relative(parent, child)
  return rel !== "" && !rel.startsWith("..") && !path.isAbsolute(rel)
}

describe("media root isolation", () => {
  it("gives the run a MEDIA_DIR rather than leaving the repo fallback in place", () => {
    expect(process.env.MEDIA_DIR).toBeTruthy()
  })

  it("resolves outside the repository", () => {
    expect(isInside(REPO_ROOT, mediaRoot())).toBe(false)
  })

  it("keeps the repository's own media directory out of every post path", () => {
    const dir = postMediaDir("00000000-0000-4000-8000-0000000005f1")
    expect(isInside(REPO_ROOT, dir)).toBe(false)
    expect(isInside(mediaRoot(), dir)).toBe(true)
  })

  it("writes a real file outside the repository when a step asks for a post directory", async () => {
    const postId = "00000000-0000-4000-8000-0000000005f2"
    const dir = await ensureMediaDir(mediaRoot(), postId)
    try {
      await writeFile(path.join(dir, "probe.webp"), "bytes")
      expect(await readdir(dir)).toContain("probe.webp")
      expect(isInside(REPO_ROOT, dir)).toBe(false)
    } finally {
      await rm(dir, { recursive: true, force: true })
    }
  })

  // `isInside` is what every assertion above rests on, so pin that it answers
  // true for the exact path this file exists to keep the suite out of, and is
  // not fooled by a sibling whose name starts the same way.
  it("recognises the repository's own media directory", () => {
    expect(isInside(REPO_ROOT, path.join(REPO_ROOT, "media"))).toBe(true)
    expect(isInside(REPO_ROOT, path.join(REPO_ROOT, "media", "post", "a.webp"))).toBe(true)
    expect(isInside(REPO_ROOT, REPO_ROOT)).toBe(false)
    expect(isInside(`${REPO_ROOT}-other`, path.join(REPO_ROOT, "media"))).toBe(false)
  })
})
