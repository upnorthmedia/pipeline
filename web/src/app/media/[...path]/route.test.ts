// @vitest-environment node
/**
 * `GET /media/{post_id}/{filename}`, the replacement for the `/media` static
 * mount in `api/src/main.py`.
 *
 * Runs against the real database, real BetterAuth sessions and a real
 * temporary media directory, so the ownership join and the filesystem
 * behaviour are exercised rather than stubbed.
 *
 * Requires `docker compose up -d db`.
 */
import { randomUUID } from "node:crypto"
import { mkdir, mkdtemp, rm, utimes, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import path from "node:path"

import { like } from "drizzle-orm"
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest"

import { closeDb, getDb, posts, websiteProfiles } from "@/db"
import { apiRequest, createTestSession, deleteTestSessions, type TestSession } from "@/test/session"

import { GET } from "./route"

const PREFIX = "media-route-test-"

/** Discard port on loopback: nothing here should ever reach a real site. */
const SITE = "http://127.0.0.1:9/site"

/** One byte of a real webp header is enough to prove the body is the file's. */
const BYTES = new Uint8Array([0x52, 0x49, 0x46, 0x46, 0x01, 0x02, 0x03, 0x04])

const db = getDb()

let user: TestSession
let other: TestSession
let mediaRootDir: string
let originalMediaDir: string | undefined

async function clearFixtures() {
  await db.delete(posts).where(like(posts.slug, `${PREFIX}%`))
  await db.delete(websiteProfiles).where(like(websiteProfiles.userId, `${PREFIX}%`))
}

/** A post owned by `userId` through its profile, which is what the join reads. */
async function insertPost(userId: string | null): Promise<string> {
  let profileId: string | null = null
  if (userId !== null) {
    const [profile] = await db
      .insert(websiteProfiles)
      .values({ userId, name: "Test Blog", websiteUrl: SITE })
      .returning()
    profileId = profile.id
  }
  const [post] = await db
    .insert(posts)
    .values({ slug: `${PREFIX}${randomUUID()}`, topic: "A topic", profileId })
    .returning()
  return post.id
}

async function writeMedia(postId: string, filename: string, bytes = BYTES): Promise<string> {
  const dir = path.join(mediaRootDir, postId)
  await mkdir(dir, { recursive: true })
  const file = path.join(dir, filename)
  await writeFile(file, bytes)
  return file
}

function fetchMedia(segments: string[], init: RequestInit & { cookie?: string } = {}) {
  return GET(apiRequest(`http://test/media/${segments.join("/")}`, init), {
    params: Promise.resolve({ path: segments }),
  })
}

beforeAll(async () => {
  originalMediaDir = process.env.MEDIA_DIR
  mediaRootDir = await mkdtemp(path.join(tmpdir(), "media-route-test-"))
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

describe("GET /media/{post_id}/{filename}: access", () => {
  it("401s without a session", async () => {
    const postId = await insertPost(user.userId)
    await writeMedia(postId, "a.webp")

    const response = await fetchMedia([postId, "a.webp"])
    expect(response.status).toBe(401)
    expect(await response.json()).toEqual({ detail: "Not authenticated" })
  })

  it("404s another user's file even though it exists on disk", async () => {
    const postId = await insertPost(user.userId)
    await writeMedia(postId, "a.webp")

    const response = await fetchMedia([postId, "a.webp"], { cookie: other.cookie })
    expect(response.status).toBe(404)
    expect(await response.json()).toEqual({ detail: "Not Found" })
  })

  it("404s a post with no profile, which no owner can reach", async () => {
    const postId = await insertPost(null)
    await writeMedia(postId, "a.webp")

    expect((await fetchMedia([postId, "a.webp"], { cookie: user.cookie })).status).toBe(404)
  })
})

describe("GET /media/{post_id}/{filename}: serving", () => {
  it("returns the file's bytes with its content type and length", async () => {
    const postId = await insertPost(user.userId)
    await writeMedia(postId, "a.webp")

    const response = await fetchMedia([postId, "a.webp"], { cookie: user.cookie })
    expect(response.status).toBe(200)
    expect(response.headers.get("content-type")).toBe("image/webp")
    expect(response.headers.get("content-length")).toBe(String(BYTES.length))
    expect(new Uint8Array(await response.arrayBuffer())).toEqual(BYTES)
  })

  it("serves an unknown extension as a download rather than guessing", async () => {
    const postId = await insertPost(user.userId)
    await writeMedia(postId, "notes.bin")

    const response = await fetchMedia([postId, "notes.bin"], { cookie: user.cookie })
    expect(response.status).toBe(200)
    expect(response.headers.get("content-type")).toBe("application/octet-stream")
    expect(response.headers.get("x-content-type-options")).toBe("nosniff")
  })

  it("revalidates with an entity tag that tracks the bytes, not the name", async () => {
    const postId = await insertPost(user.userId)
    await writeMedia(postId, "a.webp")

    const first = await fetchMedia([postId, "a.webp"], { cookie: user.cookie })
    const etag = first.headers.get("etag")
    expect(etag).toMatch(/^"[0-9a-f]+-[0-9a-f]+"$/)
    expect(first.headers.get("cache-control")).toBe("private, max-age=0, must-revalidate")

    const cached = await fetchMedia([postId, "a.webp"], {
      cookie: user.cookie,
      headers: { "if-none-match": etag as string },
    })
    expect(cached.status).toBe(304)
    expect(await cached.arrayBuffer()).toEqual(new ArrayBuffer(0))
    // A 304 has no content, so it must not claim a length for one.
    expect(cached.headers.get("content-length")).toBeNull()
    expect(cached.headers.get("etag")).toBe(etag)

    // A re-run of the images stage rewrites the same filename with new bytes.
    await writeMedia(postId, "a.webp", new Uint8Array([9, 9, 9]))
    const rerun = await fetchMedia([postId, "a.webp"], {
      cookie: user.cookie,
      headers: { "if-none-match": etag as string },
    })
    expect(rerun.status).toBe(200)
    expect(rerun.headers.get("etag")).not.toBe(etag)
  })

  it("reports the file's modification time", async () => {
    const postId = await insertPost(user.userId)
    const file = await writeMedia(postId, "a.webp")
    const when = new Date("2026-01-02T03:04:05.000Z")
    await utimes(file, when, when)

    const response = await fetchMedia([postId, "a.webp"], { cookie: user.cookie })
    expect(response.headers.get("last-modified")).toBe(when.toUTCString())
  })
})

describe("GET /media/{post_id}/{filename}: rejected paths", () => {
  it("404s a file that is not on disk", async () => {
    const postId = await insertPost(user.userId)

    expect((await fetchMedia([postId, "missing.webp"], { cookie: user.cookie })).status).toBe(404)
  })

  it("404s the post directory itself", async () => {
    const postId = await insertPost(user.userId)
    await writeMedia(postId, "a.webp")

    expect((await fetchMedia([postId], { cookie: user.cookie })).status).toBe(404)
  })

  it("404s a malformed post id without touching the database", async () => {
    expect((await fetchMedia(["not-a-uuid", "a.webp"], { cookie: user.cookie })).status).toBe(404)
  })

  it("404s a traversal that escapes the post directory", async () => {
    const postId = await insertPost(user.userId)
    const outside = path.join(mediaRootDir, "outside.webp")
    await writeFile(outside, BYTES)

    // What a client sends as `%2F..%2Foutside.webp`: one decoded segment
    // carrying separators, which the resolved path is what catches.
    const response = await fetchMedia([postId, "../outside.webp"], { cookie: user.cookie })
    expect(response.status).toBe(404)
    await rm(outside, { force: true })
  })

  it("404s a nested path, which the flat media layout never produces", async () => {
    const postId = await insertPost(user.userId)
    await mkdir(path.join(mediaRootDir, postId, "nested"), { recursive: true })
    await writeFile(path.join(mediaRootDir, postId, "nested", "a.webp"), BYTES)

    expect((await fetchMedia([postId, "nested", "a.webp"], { cookie: user.cookie })).status).toBe(
      404,
    )
  })

  it("404s a trailing segment rather than letting it alias a real file", async () => {
    const postId = await insertPost(user.userId)
    await writeMedia(postId, "a.webp")

    expect((await fetchMedia([postId, "a.webp", "extra"], { cookie: user.cookie })).status).toBe(404)
  })

  it("404s a subdirectory of the post directory", async () => {
    const postId = await insertPost(user.userId)
    await mkdir(path.join(mediaRootDir, postId, "nested"), { recursive: true })

    expect((await fetchMedia([postId, "nested"], { cookie: user.cookie })).status).toBe(404)
  })
})
