// @vitest-environment node
/**
 * `GET /api/analytics/models`.
 *
 * Runs against the real database and real BetterAuth sessions. Nearly all the
 * arithmetic under test happens in Postgres (`AVG`, `SUM`, the two `jsonb_each`
 * unrolls, the `_`-prefixed key filter, the `user_id` scoping), and the parts
 * that do not depend on the exact doubles Postgres hands back, so a stubbed
 * database would prove none of it.
 *
 * Requires `docker compose up -d db`.
 */
import { randomUUID } from "node:crypto"

import { like } from "drizzle-orm"
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest"

import { closeDb, getDb, posts, websiteProfiles, type StageStatusJson } from "@/db"
import { apiRequest, createTestSession, deleteTestSessions, type TestSession } from "@/test/session"

import { GET } from "./models/route"

const PREFIX = "analytics-models-test-"
const URL_BASE = "http://test/api/analytics/models"

/** Discard port on loopback, on a path this file owns, so no other suite's cleanup matches. */
const SITE = "http://127.0.0.1:9/analytics-models"

interface ModelsBody {
  models: {
    model: string
    call_count: number
    avg_tokens_in: number
    avg_tokens_out: number
    avg_duration_s: number
    total_cost: number
  }[]
  stage_performance: {
    stage: string
    runs: number
    avg_duration_s: number
    total_cost: number
  }[]
  stage_success_rates: {
    stage: string
    total: number
    complete: number
    failed: number
    success_rate: number
  }[]
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
function stageLog(overrides: Record<string, unknown> = {}) {
  return {
    tokens_in: 1000,
    tokens_out: 2000,
    duration_s: 4,
    model: "sonar-pro",
    cost_usd: 0.033,
    ...overrides,
  }
}

type PostOverrides = {
  stageLogs?: Record<string, unknown> | null
  stageStatus?: StageStatusJson | null
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

async function body(query = "", cookie = user.cookie): Promise<ModelsBody> {
  const response = await call(query, cookie)
  expect(response.status).toBe(200)
  return (await response.json()) as ModelsBody
}

/** The `stage_success_rates` row for a stage that has never run. */
function zeroRate(stage: string) {
  return { stage, total: 0, complete: 0, failed: 0, success_rate: 0 }
}

const ALL_STAGES = ["research", "outline", "write", "edit", "images", "ready"]
const NO_RATES = ALL_STAGES.map(zeroRate)

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
})

afterAll(async () => {
  await clearFixtures()
  await deleteTestSessions(PREFIX)
  await closeDb()
})

describe("GET /api/analytics/models", () => {
  it("rejects an unauthenticated request", async () => {
    const response = await call()
    expect(response.status).toBe(401)
    expect(await response.json()).toEqual({ detail: "Not authenticated" })
  })

  it("answers an empty history with no models, no stages and six zeroed rates", async () => {
    expect(await body()).toEqual({
      models: [],
      stage_performance: [],
      stage_success_rates: NO_RATES,
    })
  })

  describe("models", () => {
    it("averages tokens and duration and sums cost across every call of a model", async () => {
      await insertPost(profileId, {
        stageLogs: {
          research: stageLog({ tokens_in: 1000, tokens_out: 2000, duration_s: 4, cost_usd: 0.03 }),
          outline: stageLog({ tokens_in: 3000, tokens_out: 6000, duration_s: 6, cost_usd: 0.05 }),
        },
      })

      expect((await body()).models).toEqual([
        {
          model: "sonar-pro",
          call_count: 2,
          avg_tokens_in: 2000,
          avg_tokens_out: 4000,
          avg_duration_s: 5,
          total_cost: 0.08,
        },
      ])
    })

    it("reports call_count as a number, not the string pg decodes bigint to", async () => {
      await insertPost(profileId, { stageLogs: { research: stageLog() } })

      const [row] = (await body()).models
      expect(typeof row.call_count).toBe("number")
      expect(row.call_count).toBe(1)
    })

    it("groups by model and orders by call count descending", async () => {
      await insertPost(profileId, {
        stageLogs: {
          research: stageLog({ model: "sonar-pro" }),
          outline: stageLog({ model: "claude-opus-4-6" }),
          write: stageLog({ model: "claude-opus-4-6" }),
          edit: stageLog({ model: "claude-opus-4-6" }),
        },
      })

      expect((await body()).models.map((row) => [row.model, row.call_count])).toEqual([
        ["claude-opus-4-6", 3],
        ["sonar-pro", 1],
      ])

      // Flip which model leads. The counts and the alphabet now disagree, so a
      // handler that ordered by model name instead would answer the reverse.
      await insertPost(profileId, {
        stageLogs: {
          research: stageLog({ model: "sonar-pro" }),
          outline: stageLog({ model: "sonar-pro" }),
          write: stageLog({ model: "sonar-pro" }),
        },
      })

      expect((await body()).models.map((row) => [row.model, row.call_count])).toEqual([
        ["sonar-pro", 4],
        ["claude-opus-4-6", 3],
      ])
    })

    it("excludes a call that recorded no model, while stage_performance keeps it", async () => {
      await insertPost(profileId, {
        stageLogs: {
          research: stageLog({ model: "sonar-pro" }),
          images: stageLog({ model: null }),
        },
      })

      const result = await body()
      expect(result.models.map((row) => row.model)).toEqual(["sonar-pro"])
      expect(result.stage_performance.map((row) => row.stage)).toEqual(["images", "research"])
    })

    it("treats a missing numeric key as zero rather than dropping the call", async () => {
      await insertPost(profileId, {
        stageLogs: {
          research: { model: "sonar-pro", cost_usd: 0.02 },
          outline: stageLog({ tokens_in: 1000, tokens_out: 2000, duration_s: 4, cost_usd: 0.02 }),
        },
      })

      expect((await body()).models).toEqual([
        {
          model: "sonar-pro",
          call_count: 2,
          avg_tokens_in: 500,
          avg_tokens_out: 1000,
          avg_duration_s: 2,
          total_cost: 0.04,
        },
      ])
    })

    it("rounds the token averages half to even, where Math.round would round up", async () => {
      // Averages of exactly 2.5 and 3.5: Python answers 2 and 4, `Math.round`
      // answers 3 and 4.
      await insertPost(profileId, {
        stageLogs: {
          research: stageLog({ tokens_in: 2, tokens_out: 3, cost_usd: 0 }),
          outline: stageLog({ tokens_in: 3, tokens_out: 4, cost_usd: 0 }),
        },
      })

      const [row] = (await body()).models
      expect(row.avg_tokens_in).toBe(2)
      expect(row.avg_tokens_out).toBe(4)
    })

    it("rounds avg_duration_s half to even at one place, where toFixed rounds away", async () => {
      // 0.25 is exact in binary, so this is a true tie: Python answers 0.2 and
      // `(0.25).toFixed(1)` answers "0.3".
      await insertPost(profileId, {
        stageLogs: { research: stageLog({ duration_s: 0.25, cost_usd: 0 }) },
      })

      expect((await body()).models[0].avg_duration_s).toBe(0.2)
    })

    it("rounds total_cost half to even at six places", async () => {
      // 1/128 is exact in binary and its seventh decimal place is a 5, so the
      // kept digit decides: Python answers 0.007812, `toFixed(6)` answers
      // "0.007813".
      await insertPost(profileId, {
        stageLogs: { research: stageLog({ cost_usd: 0.0078125 }) },
      })

      expect((await body()).models[0].total_cost).toBe(0.007812)
    })

    it("filters both rollups by model, leaving the success rates alone", async () => {
      await insertPost(profileId, {
        stageLogs: {
          research: stageLog({ model: "sonar-pro" }),
          outline: stageLog({ model: "claude-opus-4-6" }),
        },
        stageStatus: { research: "complete", outline: "failed" },
      })

      const result = await body("?model=sonar-pro")
      expect(result.models.map((row) => row.model)).toEqual(["sonar-pro"])
      expect(result.stage_performance.map((row) => row.stage)).toEqual(["research"])
      expect(result.stage_success_rates.find((row) => row.stage === "outline")).toEqual({
        stage: "outline",
        total: 1,
        complete: 0,
        failed: 1,
        success_rate: 0,
      })
    })

    it("treats an empty model parameter as no filter at all", async () => {
      await insertPost(profileId, { stageLogs: { research: stageLog() } })

      expect((await body("?model=")).models.map((row) => row.model)).toEqual(["sonar-pro"])
    })

    it("takes the last value of a repeated model parameter, as Starlette does", async () => {
      await insertPost(profileId, {
        stageLogs: {
          research: stageLog({ model: "sonar-pro" }),
          outline: stageLog({ model: "claude-opus-4-6" }),
        },
      })

      const result = await body("?model=sonar-pro&model=claude-opus-4-6")
      expect(result.models.map((row) => row.model)).toEqual(["claude-opus-4-6"])
    })

    it("answers no rows for a model nobody used", async () => {
      await insertPost(profileId, { stageLogs: { research: stageLog() } })

      const result = await body("?model=no-such-model")
      expect(result.models).toEqual([])
      expect(result.stage_performance).toEqual([])
    })
  })

  describe("stage_performance", () => {
    it("groups by stage key and orders by that key, not by pipeline order", async () => {
      await insertPost(profileId, {
        stageLogs: {
          research: stageLog({ duration_s: 10, cost_usd: 0.01 }),
          write: stageLog({ duration_s: 20, cost_usd: 0.02 }),
          edit: stageLog({ duration_s: 30, cost_usd: 0.03 }),
        },
      })

      expect((await body()).stage_performance).toEqual([
        { stage: "edit", runs: 1, avg_duration_s: 30, total_cost: 0.03 },
        { stage: "research", runs: 1, avg_duration_s: 10, total_cost: 0.01 },
        { stage: "write", runs: 1, avg_duration_s: 20, total_cost: 0.02 },
      ])
    })

    it("averages duration and sums cost across every post that ran the stage", async () => {
      await insertPost(profileId, {
        stageLogs: { research: stageLog({ duration_s: 4, cost_usd: 0.01 }) },
      })
      await insertPost(profileId, {
        stageLogs: { research: stageLog({ duration_s: 6, cost_usd: 0.02 }) },
      })

      expect((await body()).stage_performance).toEqual([
        { stage: "research", runs: 2, avg_duration_s: 5, total_cost: 0.03 },
      ])
    })

    it("reports runs as a number, not the string pg decodes bigint to", async () => {
      await insertPost(profileId, { stageLogs: { research: stageLog() } })

      expect(typeof (await body()).stage_performance[0].runs).toBe("number")
    })
  })

  describe("excluded rows", () => {
    it("excludes keys beginning with an underscore from both rollups", async () => {
      await insertPost(profileId, {
        stageLogs: {
          research: stageLog({ cost_usd: 0.01 }),
          _error: stageLog({ cost_usd: 99 }),
        },
      })

      const result = await body()
      expect(result.models).toEqual([
        {
          model: "sonar-pro",
          call_count: 1,
          avg_tokens_in: 1000,
          avg_tokens_out: 2000,
          avg_duration_s: 4,
          total_cost: 0.01,
        },
      ])
      expect(result.stage_performance.map((row) => row.stage)).toEqual(["research"])
    })

    it("keeps a stage whose name merely contains an underscore", async () => {
      await insertPost(profileId, { stageLogs: { re_search: stageLog() } })

      expect((await body()).stage_performance.map((row) => row.stage)).toEqual(["re_search"])
    })

    it("excludes a post with an empty stage_logs object", async () => {
      await insertPost(profileId, { stageLogs: {} })

      expect((await body()).models).toEqual([])
    })

    it("excludes another user's posts from every rollup", async () => {
      await insertPost(otherProfileId, {
        stageLogs: { research: stageLog() },
        stageStatus: { research: "complete" },
      })

      expect(await body()).toEqual({
        models: [],
        stage_performance: [],
        stage_success_rates: NO_RATES,
      })
      expect(await body("", other.cookie)).toMatchObject({
        models: [{ model: "sonar-pro", call_count: 1 }],
      })
    })

    it("excludes a post with no profile, which has no owner to scope by", async () => {
      await insertPost(null, {
        stageLogs: { research: stageLog() },
        stageStatus: { research: "complete" },
      })

      expect(await body()).toEqual({
        models: [],
        stage_performance: [],
        stage_success_rates: NO_RATES,
      })
    })
  })

  describe("stage_success_rates", () => {
    it("counts complete and failed separately and totals every status", async () => {
      await insertPost(profileId, { stageStatus: { research: "complete" } })
      await insertPost(profileId, { stageStatus: { research: "failed" } })
      await insertPost(profileId, { stageStatus: { research: "running" } })

      expect((await body()).stage_success_rates[0]).toEqual({
        stage: "research",
        total: 3,
        complete: 1,
        failed: 1,
        success_rate: 33.3,
      })
    })

    it("reports every stage in pipeline order, zeroed when it never ran", async () => {
      await insertPost(profileId, { stageStatus: { images: "complete" } })

      expect((await body()).stage_success_rates).toEqual([
        zeroRate("research"),
        zeroRate("outline"),
        zeroRate("write"),
        zeroRate("edit"),
        { stage: "images", total: 1, complete: 1, failed: 0, success_rate: 100 },
        zeroRate("ready"),
      ])
    })

    it("rounds the success rate half to even, where toFixed rounds away", async () => {
      // 1 complete of 16 is exactly 6.25: Python answers 6.2 and
      // `(6.25).toFixed(1)` answers "6.3".
      await insertPost(profileId, { stageStatus: { research: "complete" } })
      for (let i = 0; i < 15; i += 1) {
        await insertPost(profileId, { stageStatus: { research: "pending" } })
      }

      expect((await body()).stage_success_rates[0]).toEqual({
        stage: "research",
        total: 16,
        complete: 1,
        failed: 0,
        success_rate: 6.2,
      })
    })

    it("ignores a stage_status key that is not a pipeline stage", async () => {
      await insertPost(profileId, {
        stageStatus: { research: "complete", publish: "complete" } as StageStatusJson,
      })

      const result = await body()
      expect(result.stage_success_rates.map((row) => row.stage)).toEqual(ALL_STAGES)
      expect(result.stage_success_rates[0].total).toBe(1)
    })

    it("excludes a post with an empty stage_status object", async () => {
      await insertPost(profileId, { stageStatus: {} })

      expect((await body()).stage_success_rates).toEqual(NO_RATES)
    })

    it("counts a stage_status entry even when the post logged no stages", async () => {
      await insertPost(profileId, { stageLogs: {}, stageStatus: { write: "failed" } })

      const result = await body()
      expect(result.models).toEqual([])
      expect(result.stage_success_rates[2]).toEqual({
        stage: "write",
        total: 1,
        complete: 0,
        failed: 1,
        success_rate: 0,
      })
    })
  })
})
