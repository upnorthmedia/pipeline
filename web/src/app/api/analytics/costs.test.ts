// @vitest-environment node
/**
 * `GET /api/analytics/costs`.
 *
 * Runs against the real database and real BetterAuth sessions. Everything under
 * test either happens in Postgres (the `jsonb_each` unroll, the `_`-prefixed key
 * filter, the `user_id` scoping) or depends on the exact numbers Postgres hands
 * back, so a stubbed database would prove none of it.
 *
 * Requires `docker compose up -d db`.
 */
import { randomUUID } from "node:crypto"

import { like } from "drizzle-orm"
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest"

import { closeDb, getDb, getPool, posts, websiteProfiles } from "@/db"
import { MODEL_COSTS } from "@/mastra/model-costs"
import { apiRequest, createTestSession, deleteTestSessions, type TestSession } from "@/test/session"

import { GET } from "./costs/route"

const PREFIX = "analytics-costs-test-"
const URL_BASE = "http://test/api/analytics/costs"

/** Discard port on loopback, on a path this file owns, so no other suite's cleanup matches. */
const SITE = "http://127.0.0.1:9/analytics-costs"

const DAY_MS = 24 * 60 * 60 * 1000

interface Totals {
  tokens_in: number
  tokens_out: number
  cost_usd: number
  calls: number
}

interface CostsBody {
  total_tokens_in: number
  total_tokens_out: number
  total_cost: number
  avg_cost_per_post: number
  by_model: Record<string, Totals>
  by_stage: Record<string, Totals>
  by_profile: { name: string; cost_usd: number }[]
  cost_over_time: { date: string; cost_usd: number }[]
  model_costs_reference: Record<string, { input: number; output: number }>
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

/** One `stage_logs` entry, in the shape `log_stage_execution()` writes. */
function stageLog(overrides: Partial<Record<string, unknown>> = {}) {
  return { tokens_in: 1000, tokens_out: 2000, model: "sonar-pro", cost_usd: 0.033, ...overrides }
}

type PostOverrides = {
  stageLogs?: Record<string, unknown> | null
  createdAt?: Date
  completedAt?: Date | null
}

async function insertPost(profile: string | null, overrides: PostOverrides = {}): Promise<string> {
  const [row] = await db
    .insert(posts)
    .values({
      slug: `${PREFIX}${randomUUID()}`,
      topic: "A topic",
      profileId: profile,
      ...overrides,
    })
    .returning({ id: posts.id })
  return row.id
}

function call(query = "", cookie?: string) {
  return GET(apiRequest(`${URL_BASE}${query}`, { cookie }))
}

async function body(query = "", cookie = user.cookie): Promise<CostsBody> {
  const response = await call(query, cookie)
  expect(response.status).toBe(200)
  return (await response.json()) as CostsBody
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

describe("GET /api/analytics/costs", () => {
  it("rejects an unauthenticated request", async () => {
    const response = await call()
    expect(response.status).toBe(401)
    expect(await response.json()).toEqual({ detail: "Not authenticated" })
  })

  it("answers an empty history with zeros and empty breakdowns", async () => {
    expect(await body()).toEqual({
      total_tokens_in: 0,
      total_tokens_out: 0,
      total_cost: 0,
      avg_cost_per_post: 0,
      by_model: {},
      by_stage: {},
      by_profile: [],
      cost_over_time: [],
      model_costs_reference: MODEL_COSTS,
    })
  })

  it("serves the model price table as the cost reference", async () => {
    const reference = (await body()).model_costs_reference
    expect(reference["sonar-pro"]).toEqual({ input: 3.0, output: 15.0 })
    expect(reference["claude-opus-4-6"]).toEqual({ input: 15.0, output: 75.0 })
    expect(reference["gemini-3.1-flash-image-preview"]).toEqual({ input: 0.1, output: 60.0 })
  })

  describe("aggregation", () => {
    it("sums tokens and cost across every stage of every post", async () => {
      await insertPost(profileId, {
        stageLogs: {
          research: stageLog({ tokens_in: 1000, tokens_out: 2000, cost_usd: 0.033 }),
          outline: stageLog({
            tokens_in: 3000,
            tokens_out: 4000,
            cost_usd: 0.345,
            model: "claude-opus-4-6",
          }),
        },
      })

      const data = await body()
      expect(data.total_tokens_in).toBe(4000)
      expect(data.total_tokens_out).toBe(6000)
      expect(data.total_cost).toBe(0.378)
    })

    it("breaks the totals down by model with a call count", async () => {
      await insertPost(profileId, {
        stageLogs: {
          research: stageLog({ tokens_in: 100, tokens_out: 200, cost_usd: 0.01 }),
          outline: stageLog({ tokens_in: 300, tokens_out: 400, cost_usd: 0.02 }),
        },
      })

      expect((await body()).by_model).toEqual({
        "sonar-pro": { tokens_in: 400, tokens_out: 600, cost_usd: 0.03, calls: 2 },
      })
    })

    it("breaks the totals down by stage name", async () => {
      await insertPost(profileId, { stageLogs: { research: stageLog({ cost_usd: 0.01 }) } })
      await insertPost(profileId, { stageLogs: { research: stageLog({ cost_usd: 0.02 }) } })

      expect((await body()).by_stage).toEqual({
        research: { tokens_in: 2000, tokens_out: 4000, cost_usd: 0.03, calls: 2 },
      })
    })

    it("rounds each breakdown's cost to six places after summing, as Python does", async () => {
      // 0.1 + 0.2 is 0.30000000000000004 as doubles, in both languages, and it
      // is `round(..., 6)` that flattens it. Two posts rather than two stages
      // of one post, so `by_stage` carries the sum too.
      await insertPost(profileId, { stageLogs: { research: stageLog({ cost_usd: 0.1 }) } })
      await insertPost(profileId, { stageLogs: { research: stageLog({ cost_usd: 0.2 }) } })

      const data = await body()
      expect(data.by_model["sonar-pro"].cost_usd).toBe(0.3)
      expect(data.by_stage.research.cost_usd).toBe(0.3)
      expect(data.total_cost).toBe(0.3)
    })

    it("counts a stage with no model in by_stage but not in by_model", async () => {
      await insertPost(profileId, {
        stageLogs: { images: { tokens_in: 10, tokens_out: 20, cost_usd: 0.5 } },
      })

      const data = await body()
      expect(data.by_model).toEqual({})
      expect(data.by_stage.images).toEqual({
        tokens_in: 10,
        tokens_out: 20,
        cost_usd: 0.5,
        calls: 1,
      })
      expect(data.total_cost).toBe(0.5)
    })

    it("treats a missing token or cost field as zero rather than dropping the row", async () => {
      await insertPost(profileId, { stageLogs: { research: { model: "sonar-pro" } } })

      const data = await body()
      expect(data.total_tokens_in).toBe(0)
      expect(data.by_stage.research).toEqual({
        tokens_in: 0,
        tokens_out: 0,
        cost_usd: 0,
        calls: 1,
      })
    })

    it("truncates a fractional token total the way Python's int() does", async () => {
      // The columns are cast to `float`, not to `int`, so a fractional count
      // survives the sum and only `int()` removes it. It truncates toward zero
      // rather than rounding, so 1000.9 reports as 1000.
      await insertPost(profileId, {
        stageLogs: { research: stageLog({ tokens_in: 1000.9, tokens_out: 2000.5 }) },
      })

      const data = await body()
      expect(data.total_tokens_in).toBe(1000)
      expect(data.total_tokens_out).toBe(2000)
      // The un-truncated value is still what the per-stage breakdown reports.
      expect(data.by_stage.research.tokens_in).toBe(1000.9)
    })

    it("excludes keys that begin with an underscore, which is how _error stays out", async () => {
      await insertPost(profileId, {
        stageLogs: {
          research: stageLog({ cost_usd: 0.01 }),
          _error: { stage: "write", error: "boom", cost_usd: 999 },
        },
      })

      const data = await body()
      expect(Object.keys(data.by_stage)).toEqual(["research"])
      expect(data.total_cost).toBe(0.01)
    })

    it("keeps a stage whose name merely contains an underscore", async () => {
      await insertPost(profileId, { stageLogs: { image_gen: stageLog({ cost_usd: 0.01 }) } })

      expect(Object.keys((await body()).by_stage)).toEqual(["image_gen"])
    })

    it("ignores a post with no stage logs at all", async () => {
      await insertPost(profileId, { stageLogs: {} })
      await insertPost(profileId, { stageLogs: null })

      expect(await body()).toMatchObject({ total_cost: 0, by_stage: {}, avg_cost_per_post: 0 })
    })
  })

  describe("avg_cost_per_post", () => {
    it("divides the total by the number of distinct posts, not the number of stages", async () => {
      await insertPost(profileId, {
        stageLogs: {
          research: stageLog({ cost_usd: 0.01 }),
          outline: stageLog({ cost_usd: 0.03 }),
        },
      })
      await insertPost(profileId, { stageLogs: { research: stageLog({ cost_usd: 0.04 }) } })

      const data = await body()
      expect(data.total_cost).toBe(0.08)
      expect(data.avg_cost_per_post).toBe(0.04)
    })

    it("rounds to four places the way Python's round() does, half to even", async () => {
      // 1/32 is exactly representable, so 0.0625 / 2 posts is exactly 0.03125:
      // a real tie at the fourth place rather than a decimal that only looks
      // like one. Python's round() takes it to the even digit, 0.0312, where
      // `toFixed(4)` and `Math.round` both answer 0.0313.
      await insertPost(profileId, { stageLogs: { research: stageLog({ cost_usd: 0.03125 }) } })
      await insertPost(profileId, { stageLogs: { research: stageLog({ cost_usd: 0.03125 }) } })

      const data = await body()
      expect(data.total_cost).toBe(0.0625)
      expect(data.avg_cost_per_post).toBe(0.0312)
    })
  })

  describe("cost_over_time", () => {
    it("buckets by the UTC date the post completed, ascending and rounded", async () => {
      // Inserted newest first so the ascending order cannot come from row
      // order, and the 1st's two posts cost 0.1 + 0.2, which is
      // 0.30000000000000004 until `round(..., 6)` flattens it.
      await insertPost(profileId, {
        completedAt: new Date("2026-03-02T05:00:00.000Z"),
        stageLogs: { research: stageLog({ cost_usd: 0.02 }) },
      })
      await insertPost(profileId, {
        completedAt: new Date("2026-03-01T23:30:00.000Z"),
        stageLogs: { research: stageLog({ cost_usd: 0.1 }) },
      })
      await insertPost(profileId, {
        completedAt: new Date("2026-03-01T01:00:00.000Z"),
        stageLogs: { research: stageLog({ cost_usd: 0.2 }) },
      })

      expect((await body()).cost_over_time).toEqual([
        { date: "2026-03-01", cost_usd: 0.3 },
        { date: "2026-03-02", cost_usd: 0.02 },
      ])
    })

    it("uses UTC rather than the session time zone for the date boundary", async () => {
      // This server runs its sessions in UTC, so the handler cannot be made to
      // disagree with itself through a request. The `at time zone 'UTC'` in the
      // statement is what keeps that from mattering, and the only way to see it
      // is to run the two expressions side by side on a connection that is not
      // in UTC. 23:30 UTC on the 1st is already the 2nd in Kiritimati.
      const client = await getPool().connect()
      try {
        await client.query("set time zone 'Pacific/Kiritimati'")
        const { rows } = await client.query(
          `select to_char($1::timestamptz at time zone 'UTC', 'YYYY-MM-DD') as utc,
                  to_char($1::timestamptz, 'YYYY-MM-DD') as session`,
          ["2026-03-01T23:30:00.000Z"],
        )
        expect(rows[0]).toEqual({ utc: "2026-03-01", session: "2026-03-02" })
      } finally {
        await client.query("set time zone default")
        client.release()
      }

      // And the handler agrees with the UTC half.
      await insertPost(profileId, {
        completedAt: new Date("2026-03-01T23:30:00.000Z"),
        stageLogs: { research: stageLog({ cost_usd: 0.01 }) },
      })
      expect((await body()).cost_over_time.map((point) => point.date)).toEqual(["2026-03-01"])
    })

    it("omits a post that has not completed, while still counting its cost", async () => {
      await insertPost(profileId, {
        completedAt: null,
        stageLogs: { research: stageLog({ cost_usd: 0.07 }) },
      })

      const data = await body()
      expect(data.cost_over_time).toEqual([])
      expect(data.total_cost).toBe(0.07)
    })
  })

  describe("by_profile", () => {
    it("resolves profile names and orders them by cost, most expensive first", async () => {
      const cheap = await createProfile(user.userId, `${PREFIX}Cheap`)
      await insertPost(profileId, { stageLogs: { research: stageLog({ cost_usd: 0.09 }) } })
      await insertPost(cheap, { stageLogs: { research: stageLog({ cost_usd: 0.01 }) } })

      expect((await body()).by_profile).toEqual([
        { name: "Main Blog", cost_usd: 0.09 },
        { name: `${PREFIX}Cheap`, cost_usd: 0.01 },
      ])
    })

    it("keeps two profiles with the same cost as separate rows", async () => {
      const twin = await createProfile(user.userId, `${PREFIX}Twin`)
      await insertPost(profileId, { stageLogs: { research: stageLog({ cost_usd: 0.02 }) } })
      await insertPost(twin, { stageLogs: { research: stageLog({ cost_usd: 0.02 }) } })

      const rows = (await body()).by_profile
      expect(rows).toHaveLength(2)
      expect(rows.map((row) => row.cost_usd)).toEqual([0.02, 0.02])
      expect(new Set(rows.map((row) => row.name))).toEqual(new Set(["Main Blog", `${PREFIX}Twin`]))
    })
  })

  describe("scoping", () => {
    it("never reports another user's costs", async () => {
      await insertPost(otherProfileId, { stageLogs: { research: stageLog({ cost_usd: 5 }) } })

      expect(await body()).toMatchObject({ total_cost: 0, by_stage: {}, by_profile: [] })
      expect(await body("", other.cookie)).toMatchObject({ total_cost: 5 })
    })

    // The join type is not what does this: `wp.user_id = <id>` is NULL for an
    // unmatched row under a left join too, so the WHERE clause drops it either
    // way. Python's inner join is reproduced anyway because the statement is a
    // port, but the behaviour under test belongs to the predicate.
    it("is blind to a post whose profile_id is null", async () => {
      await insertPost(null, { stageLogs: { research: stageLog({ cost_usd: 5 }) } })

      expect((await body()).total_cost).toBe(0)
    })
  })

  describe("filters", () => {
    it("windows on created_at with days", async () => {
      await insertPost(profileId, {
        createdAt: new Date(Date.now() - 40 * DAY_MS),
        stageLogs: { research: stageLog({ cost_usd: 0.5 }) },
      })
      await insertPost(profileId, { stageLogs: { research: stageLog({ cost_usd: 0.25 }) } })

      expect((await body()).total_cost).toBe(0.25)
      expect((await body("?days=60")).total_cost).toBe(0.75)
    })

    it("restricts to one profile with profile_id", async () => {
      const second = await createProfile(user.userId, `${PREFIX}Second`)
      await insertPost(profileId, { stageLogs: { research: stageLog({ cost_usd: 0.5 }) } })
      await insertPost(second, { stageLogs: { research: stageLog({ cost_usd: 0.25 }) } })

      expect((await body(`?profile_id=${second}`)).total_cost).toBe(0.25)
    })

    it("restricts to one model with model", async () => {
      await insertPost(profileId, {
        stageLogs: {
          research: stageLog({ cost_usd: 0.5 }),
          outline: stageLog({ cost_usd: 0.25, model: "claude-opus-4-6" }),
        },
      })

      const data = await body("?model=claude-opus-4-6")
      expect(data.total_cost).toBe(0.25)
      expect(Object.keys(data.by_stage)).toEqual(["outline"])
    })

    it("treats an empty profile_id or model as no filter, matching Python's `if value:`", async () => {
      await insertPost(profileId, { stageLogs: { research: stageLog({ cost_usd: 0.25 }) } })

      expect((await body("?profile_id=&model=")).total_cost).toBe(0.25)
    })

    it("answers a profile_id that is not a uuid with pydantic's uuid_parsing 422", async () => {
      const response = await call("?profile_id=nope", user.cookie)
      expect(response.status).toBe(422)
      expect(await response.json()).toEqual({
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

    it("answers a non-numeric days with pydantic's int_parsing 422", async () => {
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

    it("answers days=0 with pydantic's greater_than_equal 422", async () => {
      const response = await call("?days=0", user.cookie)
      expect(response.status).toBe(422)
      expect((await response.json()).detail[0]).toMatchObject({
        type: "greater_than_equal",
        loc: ["query", "days"],
      })
    })

    it("answers days=366 with pydantic's less_than_equal 422", async () => {
      const response = await call("?days=366", user.cookie)
      expect(response.status).toBe(422)
      expect((await response.json()).detail[0]).toMatchObject({
        type: "less_than_equal",
        loc: ["query", "days"],
      })
    })
  })
})
