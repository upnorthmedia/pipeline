// @vitest-environment node
/**
 * `GET /api/posts/{post_id}/export/all`, the zip export.
 *
 * The content half of this endpoint is `stripLeadingH1` plus `rewriteMediaUrls`,
 * both already pinned against the Python oracle in `export.test.ts`, so what is
 * new here is the archive: which files land in it, what the `.mdx` entry holds,
 * and that the bytes really are a deflate-compressed zip. The archive is read
 * back two ways on purpose: `unzipSync` for the entry map, and a hand-parsed
 * local file header inflated with `node:zlib` so the compression method claim
 * does not rest on the same library that wrote it.
 *
 * The media directory is a real temporary directory with real files, including
 * the symlink and subdirectory cases `Path.is_file()` and `Dirent.isFile()`
 * disagree about.
 *
 * Requires `docker compose up -d db`.
 */
import { randomUUID } from "node:crypto"
import { mkdir, mkdtemp, rm, symlink, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import path from "node:path"
import { inflateRawSync } from "node:zlib"

import { like } from "drizzle-orm"
import { unzipSync } from "fflate"
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest"

import { closeDb, getDb, posts, websiteProfiles } from "@/db"
import { ABSENT_POST_ID } from "@/test/absent-ids"
import { apiRequest, createTestSession, deleteTestSessions, type TestSession } from "@/test/session"

import { GET as exportAll } from "./[id]/export/all/route"

const PREFIX = "posts-export-all-test-"
const URL_BASE = "http://test/api/posts"
const MISSING_ID = ABSENT_POST_ID

/** Discard port on loopback: nothing here should ever reach a real site. */
const SITE = "http://127.0.0.1:9/site"

const db = getDb()

let user: TestSession
let other: TestSession
let mediaRootDir: string
let originalMediaDir: string | undefined

async function clearFixtures() {
  await db.delete(posts).where(like(posts.slug, `${PREFIX}%`))
  await db.delete(websiteProfiles).where(like(websiteProfiles.userId, `${PREFIX}%`))
}

async function insertPost(
  userId: string | null,
  values: Partial<typeof posts.$inferInsert> = {},
): Promise<typeof posts.$inferSelect> {
  let profileId: string | null = null
  if (userId !== null) {
    const [profile] = await db
      .insert(websiteProfiles)
      .values({ userId, name: "Test Blog", websiteUrl: SITE })
      .returning()
    profileId = profile.id
  }
  const [row] = await db
    .insert(posts)
    .values({ slug: `${PREFIX}${randomUUID()}`, topic: "A topic", profileId, ...values })
    .returning()
  return row
}

function exportZip(id: string, cookie?: string) {
  return exportAll(apiRequest(`${URL_BASE}/${id}/export/all`, { cookie }), {
    params: Promise.resolve({ id }),
  })
}

/** The post's media directory, created. */
async function mediaDirFor(postId: string): Promise<string> {
  const dir = path.join(mediaRootDir, postId)
  await mkdir(dir, { recursive: true })
  return dir
}

async function entriesOf(response: Response): Promise<Record<string, Uint8Array>> {
  return unzipSync(new Uint8Array(await response.arrayBuffer()))
}

function text(bytes: Uint8Array): string {
  return new TextDecoder().decode(bytes)
}

beforeAll(async () => {
  originalMediaDir = process.env.MEDIA_DIR
  mediaRootDir = await mkdtemp(path.join(tmpdir(), "posts-export-all-media-"))
  process.env.MEDIA_DIR = mediaRootDir

  await clearFixtures()
  await deleteTestSessions(PREFIX)
  user = await createTestSession(PREFIX)
  other = await createTestSession(PREFIX)
})

afterEach(clearFixtures)

afterAll(async () => {
  if (originalMediaDir === undefined) delete process.env.MEDIA_DIR
  else process.env.MEDIA_DIR = originalMediaDir
  await rm(mediaRootDir, { recursive: true, force: true })

  await clearFixtures()
  await deleteTestSessions(PREFIX)
  await closeDb()
})

describe("GET /api/posts/{post_id}/export/all: access", () => {
  it("401s without a session", async () => {
    const post = await insertPost(user.userId, { readyContent: "x" })
    expect((await exportZip(post.id)).status).toBe(401)
  })

  it("422s on a malformed uuid", async () => {
    const response = await exportZip("not-a-uuid", user.cookie)
    expect(response.status).toBe(422)
    expect((await response.json()).detail[0]).toMatchObject({
      type: "uuid_parsing",
      loc: ["path", "post_id"],
    })
  })

  it("404s on a post that does not exist", async () => {
    const response = await exportZip(MISSING_ID, user.cookie)
    expect(response.status).toBe(404)
    expect(await response.json()).toEqual({ detail: "Post not found" })
  })

  it("404s on another user's post, with the same body as a missing one", async () => {
    const post = await insertPost(other.userId, { readyContent: "secret" })
    const response = await exportZip(post.id, user.cookie)
    expect(response.status).toBe(404)
    expect(await response.json()).toEqual({ detail: "Post not found" })
  })

  it("404s on a post with no profile, because the ownership join is inner", async () => {
    const post = await insertPost(null, { readyContent: "orphan" })
    expect((await exportZip(post.id, user.cookie)).status).toBe(404)
  })
})

describe("GET /api/posts/{post_id}/export/all: content selection", () => {
  it("404s with a detail of its own, not the markdown export's", async () => {
    const post = await insertPost(user.userId)
    const response = await exportZip(post.id, user.cookie)
    expect(response.status).toBe(404)
    expect(await response.json()).toEqual({ detail: "No content available to export" })
  })

  it("404s even when images exist, because the check is on content alone", async () => {
    const post = await insertPost(user.userId)
    await writeFile(path.join(await mediaDirFor(post.id), "a.webp"), "img")
    expect((await exportZip(post.id, user.cookie)).status).toBe(404)
  })

  it("prefers ready_content over final_md_content", async () => {
    const post = await insertPost(user.userId, {
      readyContent: "ready body",
      finalMdContent: "edited body",
    })
    const entries = await entriesOf(await exportZip(post.id, user.cookie))
    expect(text(entries[`${post.slug}.mdx`])).toBe("ready body")
  })

  it("falls through to final_md_content when ready_content is empty, matching `or`", async () => {
    const post = await insertPost(user.userId, { readyContent: "", finalMdContent: "edited body" })
    const entries = await entriesOf(await exportZip(post.id, user.cookie))
    expect(text(entries[`${post.slug}.mdx`])).toBe("edited body")
  })

  it("strips the duplicated H1 and rewrites every media URL in the .mdx entry", async () => {
    const post = await insertPost(user.userId)
    const content = [
      "---",
      "title: Hello",
      "---",
      "# Hello",
      "",
      `![a](/media/${post.id}/a.webp)`,
      `![b](/media/${post.id}/b.webp)`,
      "",
    ].join("\n")
    await db.update(posts).set({ readyContent: content }).where(like(posts.slug, post.slug))

    const entries = await entriesOf(await exportZip(post.id, user.cookie))
    expect(text(entries[`${post.slug}.mdx`])).toBe(
      ["---", "title: Hello", "---", "", "![a](/a.webp)", "![b](/b.webp)", ""].join("\n"),
    )
  })
})

describe("GET /api/posts/{post_id}/export/all: the archive", () => {
  it("serves application/zip with no charset, as a .zip attachment named after the slug", async () => {
    const post = await insertPost(user.userId, { readyContent: "body" })
    const response = await exportZip(post.id, user.cookie)
    expect(response.status).toBe(200)
    expect(response.headers.get("content-type")).toBe("application/zip")
    expect(response.headers.get("content-disposition")).toBe(
      `attachment; filename="${post.slug}.zip"`,
    )
  })

  it("holds only the .mdx when the post has no media directory", async () => {
    const post = await insertPost(user.userId, { readyContent: "body" })
    const entries = await entriesOf(await exportZip(post.id, user.cookie))
    expect(Object.keys(entries)).toEqual([`${post.slug}.mdx`])
  })

  it("holds only the .mdx when the media directory is empty", async () => {
    const post = await insertPost(user.userId, { readyContent: "body" })
    await mediaDirFor(post.id)
    const entries = await entriesOf(await exportZip(post.id, user.cookie))
    expect(Object.keys(entries)).toEqual([`${post.slug}.mdx`])
  })

  it("adds every media file at the archive root, under its own bare name", async () => {
    const post = await insertPost(user.userId, { readyContent: "body" })
    const dir = await mediaDirFor(post.id)
    await writeFile(path.join(dir, "image-1.webp"), "one")
    await writeFile(path.join(dir, "image-2.webp"), "two")

    const entries = await entriesOf(await exportZip(post.id, user.cookie))
    expect(Object.keys(entries).sort()).toEqual([
      "image-1.webp",
      "image-2.webp",
      `${post.slug}.mdx`,
    ])
  })

  it("copies image bytes through unchanged, including bytes that are not valid utf-8", async () => {
    const post = await insertPost(user.userId, { readyContent: "body" })
    const bytes = new Uint8Array([0xff, 0xd8, 0x00, 0x80, 0xfe, 0x01])
    await writeFile(path.join(await mediaDirFor(post.id), "raw.bin"), bytes)

    const entries = await entriesOf(await exportZip(post.id, user.cookie))
    expect(Array.from(entries["raw.bin"])).toEqual(Array.from(bytes))
  })

  it("skips subdirectories, which is what `is_file()` excludes", async () => {
    const post = await insertPost(user.userId, { readyContent: "body" })
    const dir = await mediaDirFor(post.id)
    await mkdir(path.join(dir, "thumbs"))
    await writeFile(path.join(dir, "thumbs", "nested.webp"), "nested")

    const entries = await entriesOf(await exportZip(post.id, user.cookie))
    expect(Object.keys(entries)).toEqual([`${post.slug}.mdx`])
  })

  it("includes dotfiles, because iterdir() filters on nothing but is_file()", async () => {
    const post = await insertPost(user.userId, { readyContent: "body" })
    await writeFile(path.join(await mediaDirFor(post.id), ".manifest"), "hidden")

    const entries = await entriesOf(await exportZip(post.id, user.cookie))
    expect(text(entries[".manifest"])).toBe("hidden")
  })

  it("follows a symlink to a file, which Dirent.isFile() would have skipped", async () => {
    const post = await insertPost(user.userId, { readyContent: "body" })
    const dir = await mediaDirFor(post.id)
    await writeFile(path.join(dir, "real.webp"), "real")
    await symlink(path.join(dir, "real.webp"), path.join(dir, "alias.webp"))

    const entries = await entriesOf(await exportZip(post.id, user.cookie))
    expect(text(entries["alias.webp"])).toBe("real")
  })

  it("skips a broken symlink instead of failing the export", async () => {
    const post = await insertPost(user.userId, { readyContent: "body" })
    const dir = await mediaDirFor(post.id)
    await symlink(path.join(dir, "gone.webp"), path.join(dir, "dangling.webp"))
    await writeFile(path.join(dir, "kept.webp"), "kept")

    const response = await exportZip(post.id, user.cookie)
    expect(response.status).toBe(200)
    expect(Object.keys(await entriesOf(response)).sort()).toEqual([
      "kept.webp",
      `${post.slug}.mdx`,
    ])
  })

  /**
   * The media directory half of this only bites on a case-sensitive
   * filesystem: on macOS's default APFS the uppercase path resolves to the
   * same directory, so dropping `toLowerCase()` from the handler does not
   * fail this test locally. The URL rewrite half is a plain string comparison
   * and fails either way, which is why both are asserted here.
   */
  it("lowercases the id for both the media directory and the URL rewrite", async () => {
    const post = await insertPost(user.userId, { readyContent: "placeholder" })
    await db
      .update(posts)
      .set({ readyContent: `![a](/media/${post.id}/a.webp)` })
      .where(like(posts.slug, post.slug))
    await writeFile(path.join(await mediaDirFor(post.id), "a.webp"), "img")

    const entries = await entriesOf(await exportZip(post.id.toUpperCase(), user.cookie))
    expect(text(entries["a.webp"])).toBe("img")
    expect(text(entries[`${post.slug}.mdx`])).toBe("![a](/a.webp)")
  })

  it("is a deflate-compressed zip, read straight out of the local file header", async () => {
    const post = await insertPost(user.userId, {
      // Long enough that deflate is a visible transformation of the bytes.
      readyContent: "compress me ".repeat(200),
    })
    const raw = Buffer.from(await (await exportZip(post.id, user.cookie)).arrayBuffer())

    expect(raw.readUInt32LE(0)).toBe(0x04034b50)
    expect(raw.readUInt16LE(8)).toBe(8) // zipfile.ZIP_DEFLATED
    const nameLength = raw.readUInt16LE(26)
    const extraLength = raw.readUInt16LE(28)
    expect(raw.subarray(30, 30 + nameLength).toString("utf8")).toBe(`${post.slug}.mdx`)

    const compressedSize = raw.readUInt32LE(18)
    const start = 30 + nameLength + extraLength
    const payload = raw.subarray(start, start + compressedSize)
    expect(payload.length).toBeLessThan(raw.readUInt32LE(22))
    expect(inflateRawSync(payload).toString("utf8")).toBe("compress me ".repeat(200))
  })
})
