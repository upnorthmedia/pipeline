// @vitest-environment node
/**
 * Tests for the ported post write endpoints `PATCH /api/posts/{post_id}` and
 * `DELETE /api/posts/{post_id}`.
 *
 * Both handlers run against the real database and real BetterAuth sessions, so
 * the `website_profiles.user_id` scoping and the `internal_links.post_id`
 * detachment are exercised for real rather than asserted against a stub. The
 * media root is redirected at a temporary directory for the whole file, so the
 * delete's `shutil.rmtree` port is observed on real files without touching the
 * repository's `media/`.
 *
 * The 422 bodies asserted here were read off the real `PostUpdate`:
 *
 *   $ cd api && PYTHONPATH=. uv run python /tmp/probe_postupdate_5_3b_ii.py
 *   {"word_count": "abc"} -> [{"type": "int_parsing", ...}]
 *   {"word_count": [1]}   -> [{"type": "int_type", ...}]
 *   {"word_count": " 7 "} -> OK {'word_count': 7}
 *   {"related_keywords": "x"}  -> [{"type": "list_type", ...}]
 *   {"related_keywords": [1]}  -> [{"type": "string_type", "loc": [..., 0], ...}]
 *   {"stage_settings": []}     -> [{"type": "dict_type", ...}]
 *   {"topic": 5}               -> [{"type": "string_type", ...}]
 */
import { mkdtemp, mkdir, rm, writeFile, readdir } from "node:fs/promises"
import { existsSync } from "node:fs"
import { tmpdir } from "node:os"
import path from "node:path"

import { eq, like } from "drizzle-orm"
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest"

import { closeDb, getDb, internalLinks, posts, websiteProfiles } from "@/db"
import { apiRequest, createTestSession, deleteTestSessions, type TestSession } from "@/test/session"

import { DELETE as deletePost, PATCH as patchPost } from "./[id]/route"

const PREFIX = "posts-write-test-"
const URL_BASE = "http://test/api/posts"
const MISSING_ID = "00000000-0000-4000-8000-000000000000"

const db = getDb()

let user: TestSession
let other: TestSession
let mediaRootDir: string
let originalMediaDir: string | undefined

async function clearFixtures() {
  await db.delete(posts).where(like(posts.slug, `${PREFIX}%`))
  await db.delete(websiteProfiles).where(like(websiteProfiles.userId, `${PREFIX}%`))
}

async function insertProfile(userId: string): Promise<string> {
  const [row] = await db
    .insert(websiteProfiles)
    .values({ userId, name: "Test Blog", websiteUrl: "http://127.0.0.1:9/testblog" })
    .returning({ id: websiteProfiles.id })
  return row.id
}

async function insertPost(
  values: Partial<typeof posts.$inferInsert> & { slug: string },
): Promise<typeof posts.$inferSelect> {
  const [row] = await db
    .insert(posts)
    .values({ topic: "A topic", ...values })
    .returning()
  return row
}

function patch(id: string, body: unknown, cookie?: string) {
  return patchPost(
    apiRequest(`${URL_BASE}/${id}`, {
      cookie,
      method: "PATCH",
      body: typeof body === "string" ? body : JSON.stringify(body),
    }),
    { params: Promise.resolve({ id }) },
  )
}

function destroy(id: string, cookie?: string) {
  return deletePost(apiRequest(`${URL_BASE}/${id}`, { cookie, method: "DELETE" }), {
    params: Promise.resolve({ id }),
  })
}

/** `updated_at` is nullable in the schema, so read it as a number to compare. */
function stamp(row: typeof posts.$inferSelect): number {
  return row.updatedAt?.getTime() ?? 0
}

async function reload(id: string) {
  const [row] = await db.select().from(posts).where(eq(posts.id, id)).limit(1)
  return row
}

beforeAll(async () => {
  user = await createTestSession(PREFIX)
  other = await createTestSession(PREFIX)
  originalMediaDir = process.env.MEDIA_DIR
  mediaRootDir = await mkdtemp(path.join(tmpdir(), "posts-write-media-"))
  process.env.MEDIA_DIR = mediaRootDir
  await clearFixtures()
})

afterEach(clearFixtures)

afterAll(async () => {
  if (originalMediaDir === undefined) delete process.env.MEDIA_DIR
  else process.env.MEDIA_DIR = originalMediaDir
  await rm(mediaRootDir, { recursive: true, force: true })
  await deleteTestSessions(PREFIX)
  await closeDb()
})

describe("PATCH /api/posts/{post_id}", () => {
  it("rejects an unauthenticated request the way get_current_user did", async () => {
    const response = await patch(MISSING_ID, { topic: "x" })
    expect(response.status).toBe(401)
    await expect(response.json()).resolves.toEqual({ detail: "Not authenticated" })
  })

  it("answers a malformed uuid with FastAPI's path 422", async () => {
    const response = await patch("not-a-uuid", { topic: "x" }, user.cookie)
    expect(response.status).toBe(422)
    await expect(response.json()).resolves.toEqual({
      detail: [
        {
          type: "uuid_parsing",
          loc: ["path", "post_id"],
          msg: "Input should be a valid UUID",
          input: "not-a-uuid",
        },
      ],
    })
  })

  it("answers an unknown post with _get_user_post's 404", async () => {
    const response = await patch(MISSING_ID, { topic: "x" }, user.cookie)
    expect(response.status).toBe(404)
    await expect(response.json()).resolves.toEqual({ detail: "Post not found" })
  })

  it("answers another user's post with the same 404 and writes nothing", async () => {
    const theirs = await insertProfile(other.userId)
    const post = await insertPost({ slug: `${PREFIX}theirs`, profileId: theirs })

    const response = await patch(post.id, { topic: "hijacked" }, user.cookie)
    expect(response.status).toBe(404)
    expect((await reload(post.id)).topic).toBe("A topic")
  })

  it("cannot see a post whose profile_id is null, because the join is inner", async () => {
    const post = await insertPost({ slug: `${PREFIX}orphan`, profileId: null })

    const response = await patch(post.id, { topic: "x" }, user.cookie)
    expect(response.status).toBe(404)
    expect((await reload(post.id)).topic).toBe("A topic")
  })

  it("answers a body that is not JSON with FastAPI's json_invalid 422", async () => {
    const mine = await insertProfile(user.userId)
    const post = await insertPost({ slug: `${PREFIX}badjson`, profileId: mine })

    const response = await patch(post.id, "{not json", user.cookie)
    expect(response.status).toBe(422)
    await expect(response.json()).resolves.toEqual({
      detail: [{ type: "json_invalid", loc: ["body", 0], msg: "JSON decode error", input: {} }],
    })
  })

  it("writes only the keys the client sent, which is exclude_unset", async () => {
    const mine = await insertProfile(user.userId)
    const post = await insertPost({
      slug: `${PREFIX}unset`,
      profileId: mine,
      niche: "gardening",
      wordCount: 1200,
      tone: "Wry",
    })

    const response = await patch(post.id, { topic: "New topic" }, user.cookie)
    expect(response.status).toBe(200)

    const row = await reload(post.id)
    expect(row.topic).toBe("New topic")
    expect(row.niche).toBe("gardening")
    expect(row.wordCount).toBe(1200)
    expect(row.tone).toBe("Wry")
  })

  it("clears a column sent as null, including a list column", async () => {
    const mine = await insertProfile(user.userId)
    const post = await insertPost({
      slug: `${PREFIX}null`,
      profileId: mine,
      niche: "gardening",
      relatedKeywords: ["compost"],
      stageSettings: { research: "auto" },
    })

    const response = await patch(
      post.id,
      { niche: null, related_keywords: null, stage_settings: null },
      user.cookie,
    )
    expect(response.status).toBe(200)

    const row = await reload(post.id)
    expect(row.niche).toBeNull()
    expect(row.relatedKeywords).toBeNull()
    expect(row.stageSettings).toBeNull()
  })

  it("ignores keys PostUpdate does not declare, so slug and profile_id are immovable", async () => {
    const mine = await insertProfile(user.userId)
    const theirs = await insertProfile(other.userId)
    const post = await insertPost({ slug: `${PREFIX}immovable`, profileId: mine })

    const response = await patch(
      post.id,
      { slug: `${PREFIX}renamed`, profile_id: theirs, current_stage: "complete", bogus: 1 },
      user.cookie,
    )
    expect(response.status).toBe(200)

    const row = await reload(post.id)
    expect(row.slug).toBe(`${PREFIX}immovable`)
    expect(row.profileId).toBe(mine)
    expect(row.currentStage).toBe("pending")
  })

  it("applies pydantic's lax int coercion to word_count", async () => {
    const mine = await insertProfile(user.userId)
    const post = await insertPost({ slug: `${PREFIX}lax`, profileId: mine })

    const response = await patch(post.id, { word_count: " 7 " }, user.cookie)
    expect(response.status).toBe(200)
    expect((await reload(post.id)).wordCount).toBe(7)
  })

  it.each([
    [
      { word_count: "abc" },
      {
        type: "int_parsing",
        loc: ["body", "word_count"],
        msg: "Input should be a valid integer, unable to parse string as an integer",
        input: "abc",
      },
    ],
    [
      { word_count: [1] },
      {
        type: "int_type",
        loc: ["body", "word_count"],
        msg: "Input should be a valid integer",
        input: [1],
      },
    ],
    [
      { related_keywords: "x" },
      {
        type: "list_type",
        loc: ["body", "related_keywords"],
        msg: "Input should be a valid list",
        input: "x",
      },
    ],
    [
      { related_keywords: [1] },
      {
        type: "string_type",
        loc: ["body", "related_keywords", 0],
        msg: "Input should be a valid string",
        input: 1,
      },
    ],
    [
      { stage_settings: [] },
      {
        type: "dict_type",
        loc: ["body", "stage_settings"],
        msg: "Input should be a valid dictionary",
        input: [],
      },
    ],
    [
      { topic: 5 },
      {
        type: "string_type",
        loc: ["body", "topic"],
        msg: "Input should be a valid string",
        input: 5,
      },
    ],
  ])("reproduces pydantic's 422 for %j", async (body, detail) => {
    const mine = await insertProfile(user.userId)
    const post = await insertPost({ slug: `${PREFIX}422`, profileId: mine })

    const response = await patch(post.id, body, user.cookie)
    expect(response.status).toBe(422)
    await expect(response.json()).resolves.toEqual({ detail: [detail] })
    expect((await reload(post.id)).topic).toBe("A topic")
  })

  it("returns the row untouched for an empty body, leaving updated_at alone", async () => {
    const mine = await insertProfile(user.userId)
    const post = await insertPost({ slug: `${PREFIX}empty`, profileId: mine })

    const response = await patch(post.id, {}, user.cookie)
    expect(response.status).toBe(200)
    await expect(response.json()).resolves.toMatchObject({ id: post.id, topic: "A topic" })
    expect((await reload(post.id)).updatedAt).toEqual(post.updatedAt)
  })

  it("stamps updated_at on a real change, standing in for TimestampMixin.onupdate", async () => {
    const mine = await insertProfile(user.userId)
    const post = await insertPost({ slug: `${PREFIX}stamp`, profileId: mine })

    const response = await patch(post.id, { topic: "Moved on" }, user.cookie)
    expect(response.status).toBe(200)

    const row = await reload(post.id)
    expect(stamp(row)).toBeGreaterThan(stamp(post))
    expect(row.createdAt).toEqual(post.createdAt)
  })

  it("saves stage content the way the editor on posts/[id] does", async () => {
    const mine = await insertProfile(user.userId)
    const post = await insertPost({ slug: `${PREFIX}editor`, profileId: mine })

    // The exact payload `handleSave` in web/src/app/posts/[id]/page.tsx sends.
    const response = await patch(post.id, { draft_content: "# Edited\n\nBody." }, user.cookie)
    expect(response.status).toBe(200)

    const body = (await response.json()) as Record<string, unknown>
    expect(body.draft_content).toBe("# Edited\n\nBody.")
    expect((await reload(post.id)).draftContent).toBe("# Edited\n\nBody.")
  })

  it("answers with the full PostRead shape, not just the changed columns", async () => {
    const mine = await insertProfile(user.userId)
    const post = await insertPost({ slug: `${PREFIX}shape`, profileId: mine })

    const response = await patch(post.id, { topic: "Shaped" }, user.cookie)
    const body = (await response.json()) as Record<string, unknown>

    expect(Object.keys(body).sort()).toEqual(
      Object.keys(await (await patch(post.id, {}, user.cookie)).json()).sort(),
    )
    expect(body.id).toBe(post.id)
    expect(body.current_stage).toBe("pending")
  })
})

describe("DELETE /api/posts/{post_id}", () => {
  it("rejects an unauthenticated request the way get_current_user did", async () => {
    const response = await destroy(MISSING_ID)
    expect(response.status).toBe(401)
    await expect(response.json()).resolves.toEqual({ detail: "Not authenticated" })
  })

  it("answers a malformed uuid with FastAPI's path 422", async () => {
    const response = await destroy("not-a-uuid", user.cookie)
    expect(response.status).toBe(422)
    await expect(response.json()).resolves.toMatchObject({
      detail: [{ type: "uuid_parsing", loc: ["path", "post_id"] }],
    })
  })

  it("answers an unknown post with _get_user_post's 404", async () => {
    const response = await destroy(MISSING_ID, user.cookie)
    expect(response.status).toBe(404)
    await expect(response.json()).resolves.toEqual({ detail: "Post not found" })
  })

  it("answers another user's post with the same 404 and leaves the row in place", async () => {
    const theirs = await insertProfile(other.userId)
    const post = await insertPost({ slug: `${PREFIX}theirs-del`, profileId: theirs })

    const response = await destroy(post.id, user.cookie)
    expect(response.status).toBe(404)
    expect(await reload(post.id)).toBeDefined()
  })

  it("removes the row and answers 204 with no body", async () => {
    const mine = await insertProfile(user.userId)
    const post = await insertPost({ slug: `${PREFIX}gone`, profileId: mine })

    const response = await destroy(post.id, user.cookie)
    expect(response.status).toBe(204)
    expect(await response.text()).toBe("")
    expect(await reload(post.id)).toBeUndefined()
  })

  it("detaches internal links rather than deleting them, per Alembic 006's SET NULL", async () => {
    const mine = await insertProfile(user.userId)
    const post = await insertPost({ slug: `${PREFIX}linked`, profileId: mine })
    const [link] = await db
      .insert(internalLinks)
      .values({ profileId: mine, url: "http://127.0.0.1:9/testblog/a", postId: post.id })
      .returning({ id: internalLinks.id })

    expect((await destroy(post.id, user.cookie)).status).toBe(204)

    const [row] = await db.select().from(internalLinks).where(eq(internalLinks.id, link.id))
    expect(row).toBeDefined()
    expect(row.postId).toBeNull()
  })

  it("removes the post's media directory and nothing beside it", async () => {
    const mine = await insertProfile(user.userId)
    const post = await insertPost({ slug: `${PREFIX}media`, profileId: mine })
    const keep = await insertPost({ slug: `${PREFIX}media-keep`, profileId: mine })

    for (const id of [post.id, keep.id]) {
      await mkdir(path.join(mediaRootDir, id), { recursive: true })
      await writeFile(path.join(mediaRootDir, id, "hero.webp"), "bytes")
    }

    expect((await destroy(post.id, user.cookie)).status).toBe(204)

    expect(existsSync(path.join(mediaRootDir, post.id))).toBe(false)
    expect(await readdir(mediaRootDir)).toEqual([keep.id])
  })

  it("succeeds when the post never generated images, matching the exists() guard", async () => {
    const mine = await insertProfile(user.userId)
    const post = await insertPost({ slug: `${PREFIX}nomedia`, profileId: mine })

    expect(existsSync(path.join(mediaRootDir, post.id))).toBe(false)
    expect((await destroy(post.id, user.cookie)).status).toBe(204)
    expect(await reload(post.id)).toBeUndefined()
  })
})
