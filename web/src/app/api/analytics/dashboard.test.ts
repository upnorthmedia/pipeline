// @vitest-environment node
/**
 * `GET /api/analytics/dashboard`.
 *
 * Runs against the real database and real BetterAuth sessions: the five
 * aggregates are all `user_id`-scoped inner joins, and the rounding and
 * grouping behaviours under test are Postgres behaviours, so a stubbed
 * database would prove none of it.
 *
 * Requires `docker compose up -d db`.
 */
import { randomUUID } from "node:crypto"

import { like } from "drizzle-orm"
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest"

import { closeDb, getDb, posts, websiteProfiles } from "@/db"
import { apiRequest, createTestSession, deleteTestSessions, type TestSession } from "@/test/session"

import { GET } from "./dashboard/route"

const PREFIX = "analytics-dashboard-test-"
const URL_BASE = "http://test/api/analytics/dashboard"

/** Discard port on loopback, on a path this file owns, so no other suite's cleanup matches. */
const SITE = "http://127.0.0.1:9/analytics-dashboard"

const DAY_MS = 24 * 60 * 60 * 1000

interface DashboardBody {
  by_status: Record<string, number>
  total: number
  complete: number
  completion_rate: number
  avg_duration_s: number | null
  by_profile: { name: string; count: number }[]
  over_time: { date: string; count: number }[]
  posts_today: number
}

const db = getDb()

let user: TestSession
let other: TestSession
let profileId: string
let otherProfileId: string

async function clearPosts() {
  await db.delete(posts).where(like(posts.slug, `${PREFIX}%`))
}

async function clearFixtures() {
  await clearPosts()
  await db.delete(websiteProfiles).where(like(websiteProfiles.userId, `${PREFIX}%`))
}

async function createProfile(userId: string, name = "Main Blog"): Promise<string> {
  const [profile] = await db
    .insert(websiteProfiles)
    .values({ userId, name, websiteUrl: SITE })
    .returning()
  return profile.id
}

type PostOverrides = {
  currentStage?: string | null
  createdAt?: Date
  completedAt?: Date | null
}

function postRow(profile: string | null, overrides: PostOverrides = {}) {
  return {
    slug: `${PREFIX}${randomUUID()}`,
    topic: "A topic",
    profileId: profile,
    ...overrides,
  }
}

async function insertPost(profile: string | null, overrides: PostOverrides = {}) {
  await db.insert(posts).values(postRow(profile, overrides))
}

/** One statement, so the ten-profile cap does not cost 66 round trips. */
async function insertPosts(profile: string, howMany: number) {
  await db.insert(posts).values(Array.from({ length: howMany }, () => postRow(profile)))
}

function call(query = "", cookie?: string) {
  return GET(apiRequest(`${URL_BASE}${query}`, { cookie }))
}

async function body(query = "", cookie = user.cookie): Promise<DashboardBody> {
  const response = await call(query, cookie)
  expect(response.status).toBe(200)
  return (await response.json()) as DashboardBody
}

beforeAll(async () => {
  await clearFixtures()
  await deleteTestSessions(PREFIX)
  user = await createTestSession(PREFIX)
  other = await createTestSession(PREFIX)
  profileId = await createProfile(user.userId)
  otherProfileId = await createProfile(other.userId, "Other Blog")
})

afterEach(async () => {
  await clearPosts()
  // Only the two profiles created in `beforeAll` survive a test.
  await db.delete(websiteProfiles).where(like(websiteProfiles.name, `${PREFIX}%`))
})

afterAll(async () => {
  await clearFixtures()
  await deleteTestSessions(PREFIX)
  await closeDb()
})

describe("GET /api/analytics/dashboard", () => {
  it("rejects an unauthenticated request", async () => {
    const response = await call()
    expect(response.status).toBe(401)
    expect(await response.json()).toEqual({ detail: "Not authenticated" })
  })

  it("answers an empty history with zeros and a null average", async () => {
    expect(await body()).toEqual({
      by_status: {},
      total: 0,
      complete: 0,
      completion_rate: 0,
      avg_duration_s: null,
      by_profile: [],
      over_time: [],
      posts_today: 0,
    })
  })

  describe("the days query parameter", () => {
    it("answers a non-numeric value with pydantic's int_parsing 422", async () => {
      const response = await call("?days=abc", user.cookie)
      expect(response.status).toBe(422)
      expect(await response.json()).toEqual({
        detail: [
          {
            type: "int_parsing",
            loc: ["query", "days"],
            msg: "Input should be a valid integer, unable to parse string as an integer",
            input: "abc",
          },
        ],
      })
    })

    it("answers an empty value with a 422 rather than falling back to 30", async () => {
      const response = await call("?days=", user.cookie)
      expect(response.status).toBe(422)
      const payload = (await response.json()) as { detail: { type: string; input: string }[] }
      expect(payload.detail).toEqual([
        {
          type: "int_parsing",
          loc: ["query", "days"],
          msg: "Input should be a valid integer, unable to parse string as an integer",
          input: "",
        },
      ])
    })

    it("enforces ge=1 with pydantic's ctx bound", async () => {
      const response = await call("?days=0", user.cookie)
      expect(response.status).toBe(422)
      expect(await response.json()).toEqual({
        detail: [
          {
            type: "greater_than_equal",
            loc: ["query", "days"],
            msg: "Input should be greater than or equal to 1",
            input: "0",
            ctx: { ge: 1 },
          },
        ],
      })
    })

    it("enforces le=365 with pydantic's ctx bound", async () => {
      const response = await call("?days=366", user.cookie)
      expect(response.status).toBe(422)
      expect(await response.json()).toEqual({
        detail: [
          {
            type: "less_than_equal",
            loc: ["query", "days"],
            msg: "Input should be less than or equal to 365",
            input: "366",
            ctx: { le: 365 },
          },
        ],
      })
    })

    it("keeps the last value of a repeated key, as Starlette's QueryParams did", async () => {
      await insertPost(profileId, { createdAt: new Date(Date.now() - 200 * DAY_MS) })

      // First value 30 would exclude the post, last value 365 includes it.
      expect((await body("?days=30&days=365")).over_time).toHaveLength(1)
      // And the other way round, so the assertion cannot pass on either value.
      expect((await body("?days=365&days=30")).over_time).toEqual([])
    })
  })

  describe("by_status and the totals", () => {
    it("buckets by current_stage and sums every group into total", async () => {
      await insertPost(profileId, { currentStage: "pending" })
      await insertPost(profileId, { currentStage: "pending" })
      await insertPost(profileId, { currentStage: "write" })
      await insertPost(profileId, { currentStage: "complete" })

      const payload = await body()
      expect(payload.by_status).toEqual({ pending: 2, write: 1, complete: 1 })
      expect(payload.total).toBe(4)
      expect(payload.complete).toBe(1)
    })

    it("counts a null current_stage under the \"null\" key, as json.dumps did", async () => {
      await insertPost(profileId, { currentStage: null })
      await insertPost(profileId, { currentStage: "complete" })

      const payload = await body()
      expect(payload.by_status).toEqual({ null: 1, complete: 1 })
      expect(payload.total).toBe(2)
      // The null row is in the denominator, so the rate is 50 and not 100.
      expect(payload.completion_rate).toBe(50)
    })

    it("rounds completion_rate half to even, not half up", async () => {
      // 1 of 16 is 6.25 exactly, which Python's round takes down to 6.2.
      await insertPost(profileId, { currentStage: "complete" })
      await db
        .insert(posts)
        .values(Array.from({ length: 15 }, () => postRow(profileId, { currentStage: "pending" })))

      const payload = await body()
      expect(payload.total).toBe(16)
      expect(payload.completion_rate).toBe(6.2)
    })

    it("reports a completion rate of 0 rather than dividing by zero", async () => {
      expect((await body()).completion_rate).toBe(0)
    })
  })

  describe("avg_duration_s", () => {
    it("averages completed_at minus created_at and rounds to a whole number", async () => {
      const base = new Date(Date.now() - DAY_MS)
      await insertPost(profileId, {
        createdAt: base,
        completedAt: new Date(base.getTime() + 100_000),
      })
      await insertPost(profileId, {
        createdAt: base,
        completedAt: new Date(base.getTime() + 101_000),
      })
      // Never completed, so outside the average entirely.
      await insertPost(profileId, { createdAt: base })

      // The average is exactly 100.5, which Python's round takes to even.
      expect((await body()).avg_duration_s).toBe(100)
    })

    it("emits a number, not the numeric string pg hands back", async () => {
      const base = new Date(Date.now() - DAY_MS)
      await insertPost(profileId, {
        createdAt: base,
        completedAt: new Date(base.getTime() + 5_000),
      })

      const response = await call("", user.cookie)
      expect(await response.text()).toContain('"avg_duration_s":5,')
    })

    it("reports null when nothing has completed", async () => {
      await insertPost(profileId, { currentStage: "write" })
      expect((await body()).avg_duration_s).toBeNull()
    })

    it("reports null for an average of exactly zero, as Python's truthiness test did", async () => {
      const base = new Date(Date.now() - DAY_MS)
      await insertPost(profileId, { createdAt: base, completedAt: base })

      expect((await body()).avg_duration_s).toBeNull()
    })
  })

  describe("by_profile", () => {
    it("orders by post count descending", async () => {
      const busy = await createProfile(user.userId, `${PREFIX}busy`)
      const quiet = await createProfile(user.userId, `${PREFIX}quiet`)
      await insertPost(busy)
      await insertPost(busy)
      await insertPost(quiet)

      const names = (await body()).by_profile
      expect(names).toEqual([
        { name: `${PREFIX}busy`, count: 2 },
        { name: `${PREFIX}quiet`, count: 1 },
      ])
    })

    it("limits the list to ten rows", async () => {
      for (let i = 0; i < 11; i += 1) {
        const id = await createProfile(user.userId, `${PREFIX}p${i}`)
        await insertPosts(id, i + 1)
      }

      const rows = (await body()).by_profile
      expect(rows).toHaveLength(10)
      expect(rows[0]).toEqual({ name: `${PREFIX}p10`, count: 11 })
    })

    it("groups by profile name, so two profiles sharing a name are one row", async () => {
      const first = await createProfile(user.userId, `${PREFIX}same`)
      const second = await createProfile(user.userId, `${PREFIX}same`)
      await insertPost(first)
      await insertPost(second)

      expect((await body()).by_profile).toEqual([{ name: `${PREFIX}same`, count: 2 }])
    })
  })

  describe("over_time and posts_today", () => {
    it("groups by UTC date, ascending, within the days window", async () => {
      const older = new Date(Date.now() - 5 * DAY_MS)
      const newer = new Date(Date.now() - 2 * DAY_MS)
      await insertPost(profileId, { createdAt: older })
      await insertPost(profileId, { createdAt: newer })
      await insertPost(profileId, { createdAt: newer })

      expect((await body()).over_time).toEqual([
        { date: older.toISOString().slice(0, 10), count: 1 },
        { date: newer.toISOString().slice(0, 10), count: 2 },
      ])
    })

    it("excludes posts older than the days window", async () => {
      await insertPost(profileId, { createdAt: new Date(Date.now() - 200 * DAY_MS) })

      const payload = await body()
      expect(payload.over_time).toEqual([])
      // The row is still in by_status and total, which the window never filtered.
      expect(payload.total).toBe(1)
    })

    it("counts posts_today from UTC midnight, not from the days window", async () => {
      await insertPost(profileId)
      await insertPost(profileId, { createdAt: new Date(Date.now() - 2 * DAY_MS) })

      expect((await body()).posts_today).toBe(1)
    })
  })

  describe("scoping", () => {
    it("excludes another user's posts from every aggregate", async () => {
      await insertPost(otherProfileId, {
        currentStage: "complete",
        completedAt: new Date(),
      })

      expect(await body()).toEqual({
        by_status: {},
        total: 0,
        complete: 0,
        completion_rate: 0,
        avg_duration_s: null,
        by_profile: [],
        over_time: [],
        posts_today: 0,
      })
      // And the owner does see it, so the fixture is real.
      expect((await body("", other.cookie)).total).toBe(1)
    })

    it("excludes a post whose profile_id is null, through the inner join", async () => {
      await insertPost(null, { currentStage: "complete" })

      const payload = await body()
      expect(payload.total).toBe(0)
      expect(payload.by_profile).toEqual([])
    })
  })
})
