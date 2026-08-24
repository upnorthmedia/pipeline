// @vitest-environment node
/**
 * `GET /api/posts/{post_id}/logs` and `GET /api/posts/{post_id}/analytics`.
 *
 * Both filter behaviour and analytics wiring replay
 * `data/logs-analytics-parity.json`, which
 * `api/scripts/export_post_logs_analytics_parity.py` produced by driving the
 * two real endpoint coroutines. Everything runs against the real database and
 * real BetterAuth sessions, so the `website_profiles.user_id` scoping is
 * exercised for real; neither endpoint enqueues anything.
 *
 * Requires `docker compose up -d db`.
 */
import { randomUUID } from "node:crypto"

import { like } from "drizzle-orm"
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest"

import { closeDb, getDb, posts, websiteProfiles } from "@/db"
import { ABSENT_POST_ID } from "@/test/absent-ids"
import { apiRequest, createTestSession, deleteTestSessions, type TestSession } from "@/test/session"

import { GET as getAnalytics } from "./[id]/analytics/route"
import { GET as getLogs } from "./[id]/logs/route"
import parity from "./data/logs-analytics-parity.json"

const PREFIX = "posts-logs-analytics-test-"
const URL_BASE = "http://test/api/posts"
const MISSING_ID = ABSENT_POST_ID

/** Discard port on loopback: nothing here should ever reach a real site. */
const SITE = "http://127.0.0.1:9/site"

const db = getDb()

let user: TestSession
let other: TestSession

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

function logs(id: string, query = "", cookie?: string) {
  return getLogs(apiRequest(`${URL_BASE}/${id}/logs${query}`, { cookie }), {
    params: Promise.resolve({ id }),
  })
}

function analytics(id: string, cookie?: string) {
  return getAnalytics(apiRequest(`${URL_BASE}/${id}/analytics`, { cookie }), {
    params: Promise.resolve({ id }),
  })
}

/** The oracle's Python call arguments, rendered as the query string FastAPI parsed them from. */
function queryString(entry: { level: string[] | null; stage: string | null; since: string | null }) {
  const parts: string[] = []
  for (const value of entry.level ?? []) parts.push(`level=${encodeURIComponent(value)}`)
  if (entry.stage !== null) parts.push(`stage=${encodeURIComponent(entry.stage)}`)
  if (entry.since !== null) parts.push(`since=${encodeURIComponent(entry.since)}`)
  return parts.length > 0 ? `?${parts.join("&")}` : ""
}

beforeAll(async () => {
  await clearFixtures()
  await deleteTestSessions(PREFIX)
  user = await createTestSession(PREFIX)
  other = await createTestSession(PREFIX)
})

afterEach(clearFixtures)

afterAll(async () => {
  await deleteTestSessions(PREFIX)
  await closeDb()
})

describe("GET /api/posts/{post_id}/logs", () => {
  it("rejects an unauthenticated request", async () => {
    const response = await logs(MISSING_ID)
    expect(response.status).toBe(401)
  })

  it("answers a malformed path uuid with FastAPI's 422", async () => {
    const response = await logs("not-a-uuid", "", user.cookie)
    expect(response.status).toBe(422)
    expect(await response.json()).toEqual({
      detail: [
        { type: "uuid_parsing", loc: ["path", "post_id"], msg: "Input should be a valid UUID", input: "not-a-uuid" },
      ],
    })
  })

  it("answers a post that does not exist with a 404", async () => {
    const response = await logs(MISSING_ID, "", user.cookie)
    expect(response.status).toBe(404)
    expect(await response.json()).toEqual({ detail: "Post not found" })
  })

  it("answers another user's post with the same 404", async () => {
    const post = await insertPost(other.userId, { executionLogs: [{ level: "info" }] })
    const response = await logs(post.id, "", user.cookie)
    expect(response.status).toBe(404)
  })

  it("answers a post whose profile_id is null with a 404", async () => {
    const post = await insertPost(null, { executionLogs: [{ level: "info" }] })
    const response = await logs(post.id, "", user.cookie)
    expect(response.status).toBe(404)
  })

  it("returns a bare array, not an envelope", async () => {
    const post = await insertPost(user.userId, {
      executionLogs: [{ ts: "2026-08-01T00:00:00Z", level: "info", stage: "write", message: "m" }],
    })
    const response = await logs(post.id, "", user.cookie)
    expect(response.status).toBe(200)
    expect(await response.json()).toEqual([
      { ts: "2026-08-01T00:00:00Z", level: "info", stage: "write", message: "m" },
    ])
  })

  describe("matches the Python filters", () => {
    for (const entry of parity.logs) {
      it(entry.name, async () => {
        const post = await insertPost(user.userId, {
          executionLogs: entry.execution_logs as never,
        })
        const response = await logs(post.id, queryString(entry as never), user.cookie)
        expect(response.status).toBe(200)
        expect(await response.json()).toEqual(entry.expected)
      })
    }
  })

  it("collects every occurrence of level, unlike the scalar parameters", async () => {
    const post = await insertPost(user.userId, {
      executionLogs: [{ level: "info" }, { level: "warning" }, { level: "error" }],
    })
    const response = await logs(post.id, "?level=info&level=error", user.cookie)
    expect(await response.json()).toEqual([{ level: "info" }, { level: "error" }])
  })

  it("keeps the last occurrence of stage, matching Starlette's QueryParams", async () => {
    const post = await insertPost(user.userId, {
      executionLogs: [{ stage: "write" }, { stage: "edit" }],
    })
    const response = await logs(post.id, "?stage=write&stage=edit", user.cookie)
    expect(await response.json()).toEqual([{ stage: "edit" }])
  })

  it("keeps the last occurrence of since", async () => {
    const post = await insertPost(user.userId, {
      executionLogs: [{ ts: "2026-08-01" }, { ts: "2026-08-05" }],
    })
    const response = await logs(post.id, "?since=2026-01-01&since=2026-08-03", user.cookie)
    expect(await response.json()).toEqual([{ ts: "2026-08-05" }])
  })

  it("treats a valueless level as the empty string, which matches nothing", async () => {
    const post = await insertPost(user.userId, { executionLogs: [{ level: "info" }] })
    const response = await logs(post.id, "?level", user.cookie)
    expect(await response.json()).toEqual([])
  })

  it("treats a valueless stage as absent, since the empty string is falsy in Python", async () => {
    const post = await insertPost(user.userId, { executionLogs: [{ stage: "write" }] })
    const response = await logs(post.id, "?stage", user.cookie)
    expect(await response.json()).toEqual([{ stage: "write" }])
  })

  it("compares since by code point, where JavaScript's > compares UTF-16 code units", async () => {
    const post = await insertPost(user.userId, { executionLogs: [{ ts: "\u{10000}" }] })
    // "\u{10000}" > "�" is true in Python and false for JavaScript's own `>`.
    const response = await logs(post.id, `?since=${encodeURIComponent("�")}`, user.cookie)
    expect(await response.json()).toEqual([{ ts: "\u{10000}" }])
  })
})

describe("GET /api/posts/{post_id}/analytics", () => {
  it("rejects an unauthenticated request", async () => {
    const response = await analytics(MISSING_ID)
    expect(response.status).toBe(401)
  })

  it("answers a malformed path uuid with FastAPI's 422", async () => {
    const response = await analytics("not-a-uuid", user.cookie)
    expect(response.status).toBe(422)
  })

  it("answers a post that does not exist with a 404", async () => {
    const response = await analytics(MISSING_ID, user.cookie)
    expect(response.status).toBe(404)
    expect(await response.json()).toEqual({ detail: "Post not found" })
  })

  it("answers another user's post with the same 404", async () => {
    const post = await insertPost(other.userId, { draftContent: "Words here." })
    const response = await analytics(post.id, user.cookie)
    expect(response.status).toBe(404)
  })

  it("answers a post whose profile_id is null with a 404", async () => {
    const post = await insertPost(null, { draftContent: "Words here." })
    const response = await analytics(post.id, user.cookie)
    expect(response.status).toBe(404)
  })

  it("emits exactly the seven keys PostAnalytics declares, in order", async () => {
    const post = await insertPost(user.userId, { draftContent: "Words here." })
    const response = await analytics(post.id, user.cookie)
    expect(response.status).toBe(200)
    expect(Object.keys(await response.json())).toEqual([
      "word_count",
      "sentence_count",
      "paragraph_count",
      "avg_sentence_length",
      "flesch_reading_ease",
      "keyword_density",
      "seo_checklist",
    ])
  })

  describe("matches the Python wiring", () => {
    for (const entry of parity.analytics) {
      it(entry.name, async () => {
        const post = await insertPost(user.userId, {
          topic: entry.post.topic,
          websiteUrl: entry.post.website_url,
          relatedKeywords: entry.post.related_keywords as never,
          draftContent: entry.post.draft_content,
          finalMdContent: entry.post.final_md_content,
          readyContent: entry.post.ready_content,
        })
        const response = await analytics(post.id, user.cookie)
        expect(response.status).toBe(200)
        expect(await response.json()).toEqual(entry.expected)
      })
    }
  })
})
