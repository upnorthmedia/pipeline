// @vitest-environment node
/**
 * Tests for the ported post read endpoints, `GET /api/posts` and
 * `GET /api/posts/{post_id}`.
 *
 * The handlers run against the real database and real BetterAuth sessions, so
 * the `website_profiles.user_id` scoping is genuinely exercised rather than
 * asserted against a stub. Fixture rows are inserted with Drizzle, because
 * `POST /api/posts` is not ported yet and a create bug must not be able to
 * hide a read bug.
 */
import { like } from "drizzle-orm"
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest"

import { closeDb, getDb, posts, websiteProfiles } from "@/db"
import { apiRequest, createTestSession, deleteTestSessions, type TestSession } from "@/test/session"

import { GET as getPost } from "./[id]/route"
import { GET as listPosts } from "./route"
import { serializePost, toPydanticIso } from "./serialize"

const PREFIX = "posts-route-test-"
const URL_BASE = "http://test/api/posts"

const db = getDb()

let user: TestSession
let other: TestSession

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

function list(qs = "", cookie?: string) {
  return listPosts(apiRequest(`${URL_BASE}${qs}`, { cookie }))
}

function getById(id: string, cookie?: string) {
  return getPost(apiRequest(`${URL_BASE}/${id}`, { cookie }), {
    params: Promise.resolve({ id }),
  })
}

beforeAll(async () => {
  user = await createTestSession(PREFIX)
  other = await createTestSession(PREFIX)
  await clearFixtures()
})

afterEach(clearFixtures)

afterAll(async () => {
  await deleteTestSessions(PREFIX)
  await closeDb()
})

describe("GET /api/posts", () => {
  it("rejects an unauthenticated request the way get_current_user did", async () => {
    const response = await list()
    expect(response.status).toBe(401)
    await expect(response.json()).resolves.toEqual({ detail: "Not authenticated" })
  })

  it("returns only posts whose profile belongs to the caller", async () => {
    const mine = await insertProfile(user.userId)
    const theirs = await insertProfile(other.userId)
    await insertPost({ slug: `${PREFIX}mine`, profileId: mine })
    await insertPost({ slug: `${PREFIX}theirs`, profileId: theirs })

    const response = await list("", user.cookie)
    expect(response.status).toBe(200)
    const body = (await response.json()) as { slug: string }[]
    expect(body.map((p) => p.slug)).toEqual([`${PREFIX}mine`])
  })

  it("hides a post with no profile, which no user_id filter can match", async () => {
    await insertProfile(user.userId)
    await insertPost({ slug: `${PREFIX}orphan`, profileId: null })

    const body = (await (await list("", user.cookie)).json()) as { slug: string }[]
    expect(body).toEqual([])
  })

  it("orders by created_at descending by default", async () => {
    const profileId = await insertProfile(user.userId)
    await insertPost({
      slug: `${PREFIX}old`,
      profileId,
      createdAt: new Date("2020-01-01T00:00:00Z"),
    })
    await insertPost({
      slug: `${PREFIX}new`,
      profileId,
      createdAt: new Date("2030-01-01T00:00:00Z"),
    })

    const body = (await (await list("", user.cookie)).json()) as { slug: string }[]
    expect(body.map((p) => p.slug)).toEqual([`${PREFIX}new`, `${PREFIX}old`])
  })

  it("honours sort and order", async () => {
    const profileId = await insertProfile(user.userId)
    await insertPost({ slug: `${PREFIX}b`, profileId, priority: 1 })
    await insertPost({ slug: `${PREFIX}a`, profileId, priority: 9 })

    const asc = (await (await list("?sort=slug&order=asc", user.cookie)).json()) as {
      slug: string
    }[]
    expect(asc.map((p) => p.slug)).toEqual([`${PREFIX}a`, `${PREFIX}b`])

    const byPriority = (await (await list("?sort=priority&order=desc", user.cookie)).json()) as {
      slug: string
    }[]
    expect(byPriority.map((p) => p.slug)).toEqual([`${PREFIX}a`, `${PREFIX}b`])
  })

  it("falls back to created_at for an unknown sort field", async () => {
    const profileId = await insertProfile(user.userId)
    await insertPost({
      slug: `${PREFIX}old`,
      profileId,
      createdAt: new Date("2020-01-01T00:00:00Z"),
    })
    await insertPost({
      slug: `${PREFIX}new`,
      profileId,
      createdAt: new Date("2030-01-01T00:00:00Z"),
    })

    const body = (await (await list("?sort=bogus", user.cookie)).json()) as { slug: string }[]
    expect(body.map((p) => p.slug)).toEqual([`${PREFIX}new`, `${PREFIX}old`])
  })

  it("filters on current_stage through either status or stage, status winning", async () => {
    const profileId = await insertProfile(user.userId)
    await insertPost({ slug: `${PREFIX}r`, profileId, currentStage: "research" })
    await insertPost({ slug: `${PREFIX}w`, profileId, currentStage: "write" })

    const byStatus = (await (await list("?status=write", user.cookie)).json()) as {
      slug: string
    }[]
    expect(byStatus.map((p) => p.slug)).toEqual([`${PREFIX}w`])

    const byStage = (await (await list("?stage=research", user.cookie)).json()) as {
      slug: string
    }[]
    expect(byStage.map((p) => p.slug)).toEqual([`${PREFIX}r`])

    const both = (await (await list("?status=write&stage=research", user.cookie)).json()) as {
      slug: string
    }[]
    expect(both.map((p) => p.slug)).toEqual([`${PREFIX}w`])
  })

  it("filters by profile_id", async () => {
    const one = await insertProfile(user.userId)
    const two = await insertProfile(user.userId)
    await insertPost({ slug: `${PREFIX}one`, profileId: one })
    await insertPost({ slug: `${PREFIX}two`, profileId: two })

    const body = (await (await list(`?profile_id=${two}`, user.cookie)).json()) as {
      slug: string
    }[]
    expect(body.map((p) => p.slug)).toEqual([`${PREFIX}two`])
  })

  it("searches topic and slug case-insensitively", async () => {
    const profileId = await insertProfile(user.userId)
    await insertPost({ slug: `${PREFIX}widgets`, profileId, topic: "Nothing to see" })
    await insertPost({ slug: `${PREFIX}other`, profileId, topic: "All about WIDGETS" })
    await insertPost({ slug: `${PREFIX}miss`, profileId, topic: "Unrelated" })

    const body = (await (await list("?q=widget", user.cookie)).json()) as { slug: string }[]
    expect(body.map((p) => p.slug).sort()).toEqual([`${PREFIX}other`, `${PREFIX}widgets`])
  })

  it("paginates with page and per_page", async () => {
    const profileId = await insertProfile(user.userId)
    for (let i = 0; i < 3; i++) {
      await insertPost({
        slug: `${PREFIX}${i}`,
        profileId,
        createdAt: new Date(`203${i}-01-01T00:00:00Z`),
      })
    }

    const first = (await (await list("?per_page=2", user.cookie)).json()) as { slug: string }[]
    expect(first.map((p) => p.slug)).toEqual([`${PREFIX}2`, `${PREFIX}1`])

    const second = (await (await list("?per_page=2&page=2", user.cookie)).json()) as {
      slug: string
    }[]
    expect(second.map((p) => p.slug)).toEqual([`${PREFIX}0`])
  })

  it.each([
    ["?page=0", { type: "greater_than_equal", loc: ["query", "page"], msg: "Input should be greater than or equal to 1", input: "0", ctx: { ge: 1 } }],
    ["?per_page=0", { type: "greater_than_equal", loc: ["query", "per_page"], msg: "Input should be greater than or equal to 1", input: "0", ctx: { ge: 1 } }],
    ["?per_page=201", { type: "less_than_equal", loc: ["query", "per_page"], msg: "Input should be less than or equal to 200", input: "201", ctx: { le: 200 } }],
    ["?page=abc", { type: "int_parsing", loc: ["query", "page"], msg: "Input should be a valid integer, unable to parse string as an integer", input: "abc" }],
    ["?page=1.5", { type: "int_parsing", loc: ["query", "page"], msg: "Input should be a valid integer, unable to parse string as an integer", input: "1.5" }],
    ["?page=", { type: "int_parsing", loc: ["query", "page"], msg: "Input should be a valid integer, unable to parse string as an integer", input: "" }],
  ])("answers %s with FastAPI's 422 body", async (qs, detail) => {
    const response = await list(qs, user.cookie)
    expect(response.status).toBe(422)
    await expect(response.json()).resolves.toEqual({ detail: [detail] })
  })

  it("reports every bad query parameter in one 422, as FastAPI did", async () => {
    const response = await list("?page=0&per_page=201", user.cookie)
    expect(response.status).toBe(422)
    const body = (await response.json()) as { detail: { loc: string[] }[] }
    expect(body.detail.map((d) => d.loc)).toEqual([
      ["query", "page"],
      ["query", "per_page"],
    ])
  })

  it("rejects a malformed profile_id with a uuid_parsing 422", async () => {
    const response = await list("?profile_id=nope", user.cookie)
    expect(response.status).toBe(422)
    await expect(response.json()).resolves.toEqual({
      detail: [
        {
          type: "uuid_parsing",
          loc: ["query", "profile_id"],
          msg: "Input should be a valid UUID",
          input: "nope",
        },
      ],
    })
  })

  it("accepts per_page at its bounds", async () => {
    await insertProfile(user.userId)
    expect((await list("?per_page=1", user.cookie)).status).toBe(200)
    expect((await list("?per_page=200", user.cookie)).status).toBe(200)
  })
})

describe("GET /api/posts/{post_id}", () => {
  it("rejects an unauthenticated request", async () => {
    const response = await getById("11111111-1111-1111-1111-111111111111")
    expect(response.status).toBe(401)
  })

  it("returns the caller's post", async () => {
    const profileId = await insertProfile(user.userId)
    const row = await insertPost({ slug: `${PREFIX}mine`, profileId })

    const response = await getById(row.id, user.cookie)
    expect(response.status).toBe(200)
    await expect(response.json()).resolves.toEqual(serializePost(row))
  })

  it("answers another user's post with the same 404 as a missing one", async () => {
    const theirs = await insertProfile(other.userId)
    const row = await insertPost({ slug: `${PREFIX}theirs`, profileId: theirs })

    const cross = await getById(row.id, user.cookie)
    expect(cross.status).toBe(404)
    await expect(cross.json()).resolves.toEqual({ detail: "Post not found" })

    const missing = await getById("11111111-1111-1111-1111-111111111111", user.cookie)
    expect(missing.status).toBe(404)
    await expect(missing.json()).resolves.toEqual({ detail: "Post not found" })
  })

  it("rejects a malformed id with a 422 rather than letting Postgres raise", async () => {
    const response = await getById("not-a-uuid", user.cookie)
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
})

describe("PostRead serialization", () => {
  it("emits exactly PostRead's field set, in PostRead's order", async () => {
    const profileId = await insertProfile(user.userId)
    const row = await insertPost({ slug: `${PREFIX}shape`, profileId })

    const body = (await (await getById(row.id, user.cookie)).json()) as Record<string, unknown>
    // Copied from `list(PostRead.model_fields)` on the api/ interpreter.
    expect(Object.keys(body)).toEqual([
      "slug", "topic", "profile_id", "target_audience", "niche", "intent",
      "word_count", "tone", "output_format", "website_url", "related_keywords",
      "competitor_urls", "image_style", "image_brand_colors", "image_exclude",
      "brand_voice", "avoid", "required_mentions", "article_type",
      "additional_info", "stage_settings", "id", "current_stage",
      "stage_status", "stage_logs", "execution_logs", "priority",
      "research_content", "outline_content", "draft_content",
      "final_md_content", "final_html_content", "image_manifest",
      "ready_content", "wp_category_id", "wp_author_id", "wp_post_id",
      "wp_post_url", "wp_publish_status", "nextjs_publish_status",
      "nextjs_published_at", "created_at", "updated_at", "completed_at",
    ])
    expect(body).not.toHaveProperty("thread_id")
  })

  it("substitutes PostRead's declared default for a null non-optional column", async () => {
    const profileId = await insertProfile(user.userId)
    const row = await insertPost({
      slug: `${PREFIX}nulls`,
      profileId,
      wordCount: null,
      tone: null,
      outputFormat: null,
      relatedKeywords: null,
      competitorUrls: null,
      imageBrandColors: null,
      imageExclude: null,
      stageSettings: null,
      currentStage: null,
      stageStatus: null,
      stageLogs: null,
      priority: null,
    })

    const body = (await (await getById(row.id, user.cookie)).json()) as Record<string, unknown>
    expect(body).toMatchObject({
      word_count: 2000,
      tone: "Conversational and friendly",
      output_format: "markdown",
      related_keywords: [],
      competitor_urls: [],
      image_brand_colors: [],
      image_exclude: [],
      stage_settings: {
        research: "auto", outline: "auto", write: "auto",
        edit: "auto", images: "auto", ready: "auto",
      },
      current_stage: "pending",
      stage_status: {},
      stage_logs: {},
      execution_logs: [],
      priority: 0,
    })
  })

  it("formats timestamps the way pydantic 2.12 does", () => {
    // Right-hand sides pasted from `jsonable_encoder(PostRead.model_validate(...))`.
    expect(toPydanticIso(new Date("2026-08-22T12:34:56.789Z"))).toBe("2026-08-22T12:34:56.789Z")
    expect(toPydanticIso(new Date("2026-08-22T12:34:56.000Z"))).toBe("2026-08-22T12:34:56Z")
    expect(toPydanticIso(new Date("2026-08-22T12:34:56.700Z"))).toBe("2026-08-22T12:34:56.7Z")
    expect(toPydanticIso(null)).toBeNull()
  })

  it("carries a stored image_manifest and stage_status through unchanged", async () => {
    const profileId = await insertProfile(user.userId)
    const manifest = { images: [{ path: "hero.png", prompt: "a hero" }] }
    const row = await insertPost({
      slug: `${PREFIX}manifest`,
      profileId,
      imageManifest: manifest,
      stageStatus: { research: "complete", outline: "running" },
      executionLogs: [{ stage: "research", event: "start" }],
    })

    const body = (await (await getById(row.id, user.cookie)).json()) as Record<string, unknown>
    expect(body.image_manifest).toEqual(manifest)
    expect(body.stage_status).toEqual({ research: "complete", outline: "running" })
    expect(body.execution_logs).toEqual([{ stage: "research", event: "start" }])
  })
})
