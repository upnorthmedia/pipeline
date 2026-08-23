// @vitest-environment node
/**
 * The TypeScript replacement for `api/tests/phase4/test_settings.py`, plus the
 * multi-tenancy cases that suite never had. The handlers are called directly
 * with a `Request`, against the real database and a real BetterAuth session,
 * so the row scoping is genuinely exercised rather than mocked away.
 *
 * The Python suite's four cases map to `lists nothing`, `creates rows`,
 * `updates an existing row` and `lists a row it just wrote`. Those four fail in
 * pytest today (401, because the fixtures never build a session), which is part
 * of the Phase 0 baseline.
 */
import { and, eq, like, or } from "drizzle-orm"
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest"

import { closeDb, getDb, settings } from "@/db"
import { resolveStageModels, STAGE_MODELS_SETTING_KEY } from "@/mastra/stage-models"
import { apiRequest, createTestSession, deleteTestSessions, type TestSession } from "@/test/session"

import { GET, PATCH } from "./route"

const PREFIX = "settings-route-test-"
const URL = "http://test/api/settings"

const db = getDb()

let user: TestSession
let other: TestSession

/**
 * Keyed on both columns: every row this file writes has a prefixed key, and the
 * null-`user_id` case has no owner to match on.
 */
async function clearSettings() {
  await db
    .delete(settings)
    .where(or(like(settings.key, `${PREFIX}%`), like(settings.userId, `${PREFIX}%`)))
}

beforeAll(async () => {
  await clearSettings()
  await deleteTestSessions(PREFIX)
  user = await createTestSession(PREFIX)
  other = await createTestSession(PREFIX)
})

afterEach(clearSettings)

afterAll(async () => {
  await clearSettings()
  await deleteTestSessions(PREFIX)
  await closeDb()
})

describe("GET /api/settings", () => {
  it("401s without a session", async () => {
    const response = await GET(apiRequest(URL))

    expect(response.status).toBe(401)
    expect(await response.json()).toEqual({ detail: "Not authenticated" })
  })

  it("lists nothing for a user with no settings", async () => {
    const response = await GET(apiRequest(URL, { cookie: user.cookie }))

    expect(response.status).toBe(200)
    expect(await response.json()).toEqual([])
  })

  it("returns the user's rows ordered by key, as SettingRead", async () => {
    await db.insert(settings).values([
      { key: `${PREFIX}zulu`, userId: user.userId, value: { a: 1 } },
      { key: `${PREFIX}alpha`, userId: user.userId, value: { b: 2 } },
    ])

    const body = await (await GET(apiRequest(URL, { cookie: user.cookie }))).json()

    expect(body.map((row: { key: string }) => row.key)).toEqual([
      `${PREFIX}alpha`,
      `${PREFIX}zulu`,
    ])
    expect(Object.keys(body[0]).sort()).toEqual(["key", "updated_at", "value"])
    expect(body[0].value).toEqual({ b: 2 })
    expect(new Date(body[0].updated_at).getTime()).toBeGreaterThan(0)
  })

  it("never returns another user's settings", async () => {
    await db
      .insert(settings)
      .values({ key: `${PREFIX}private`, userId: other.userId, value: { secret: true } })

    const body = await (await GET(apiRequest(URL, { cookie: user.cookie }))).json()

    expect(body).toEqual([])
  })

  it("hides rows that belong to no user, which is where the api_keys row lives", async () => {
    await db.insert(settings).values({ key: `${PREFIX}global`, userId: null, value: { x: 1 } })

    const body = await (await GET(apiRequest(URL, { cookie: user.cookie }))).json()

    expect(body).toEqual([])
  })
})

describe("PATCH /api/settings", () => {
  it("401s without a session", async () => {
    const response = await PATCH(apiRequest(URL, { method: "PATCH", body: "{}" }))

    expect(response.status).toBe(401)
  })

  it("creates rows for keys the user does not have yet", async () => {
    const response = await PATCH(
      apiRequest(URL, {
        method: "PATCH",
        cookie: user.cookie,
        body: JSON.stringify({
          [`${PREFIX}worker_concurrency`]: { max_jobs: 5 },
          [`${PREFIX}default_stage_settings`]: { research: "auto", outline: "auto" },
        }),
      }),
    )

    expect(response.status).toBe(200)
    const body = await response.json()
    expect(body.map((row: { key: string }) => row.key)).toEqual([
      `${PREFIX}default_stage_settings`,
      `${PREFIX}worker_concurrency`,
    ])
    expect(body[1].value).toEqual({ max_jobs: 5 })
  })

  it("updates a key the user already has instead of adding a second row", async () => {
    const patch = (max_jobs: number) =>
      PATCH(
        apiRequest(URL, {
          method: "PATCH",
          cookie: user.cookie,
          body: JSON.stringify({ [`${PREFIX}worker_concurrency`]: { max_jobs } }),
        }),
      )

    await patch(3)
    const body = await (await patch(10)).json()

    expect(body).toHaveLength(1)
    expect(body[0].value).toEqual({ max_jobs: 10 })
  })

  it("stores the value verbatim, including api.ts's { value: ... } wrapper", async () => {
    await PATCH(
      apiRequest(URL, {
        method: "PATCH",
        cookie: user.cookie,
        body: JSON.stringify({ [`${PREFIX}wrapped`]: { value: { claude: "on" } } }),
      }),
    )

    const [row] = await db
      .select()
      .from(settings)
      .where(and(eq(settings.key, `${PREFIX}wrapped`), eq(settings.userId, user.userId)))

    expect(row.value).toEqual({ value: { claude: "on" } })
  })

  it("keeps one value per user for the same key", async () => {
    await db
      .insert(settings)
      .values({ key: `${PREFIX}shared`, userId: other.userId, value: { owner: "other" } })

    const response = await PATCH(
      apiRequest(URL, {
        method: "PATCH",
        cookie: user.cookie,
        body: JSON.stringify({ [`${PREFIX}shared`]: { owner: "user" } }),
      }),
    )

    expect(response.status).toBe(200)
    expect(await response.json()).toEqual([
      expect.objectContaining({ key: `${PREFIX}shared`, value: { owner: "user" } }),
    ])

    const rows = await db
      .select()
      .from(settings)
      .where(eq(settings.key, `${PREFIX}shared`))

    expect(
      Object.fromEntries(rows.map((row) => [row.userId, row.value])),
    ).toEqual({ [user.userId]: { owner: "user" }, [other.userId]: { owner: "other" } })
  })

  it("coexists with the global row for the same key, which is where api_keys lives", async () => {
    await db
      .insert(settings)
      .values({ key: `${PREFIX}shared`, userId: null, value: { owner: "global" } })

    await PATCH(
      apiRequest(URL, {
        method: "PATCH",
        cookie: user.cookie,
        body: JSON.stringify({ [`${PREFIX}shared`]: { owner: "user" } }),
      }),
    )

    const rows = await db.select().from(settings).where(eq(settings.key, `${PREFIX}shared`))

    expect(rows).toHaveLength(2)
    expect(rows.find((row) => row.userId === null)?.value).toEqual({ owner: "global" })
  })

  it("422s on a body that is not a JSON object", async () => {
    const response = await PATCH(
      apiRequest(URL, { method: "PATCH", cookie: user.cookie, body: "[]" }),
    )

    expect(response.status).toBe(422)
    expect(await response.json()).toEqual({ detail: "Body must be an object of key to value" })
  })

  it("422s on a body that is not JSON at all", async () => {
    const response = await PATCH(
      apiRequest(URL, { method: "PATCH", cookie: user.cookie, body: "not json" }),
    )

    expect(response.status).toBe(422)
    expect(await response.json()).toEqual({ detail: "Invalid JSON body" })
  })
})

/**
 * Item 6.2's one exception to "store the value verbatim". `stage_models`
 * decides which model a paid provider call runs on, so it is checked against
 * the allowlist before it can reach a pipeline run.
 */
describe("PATCH /api/settings, the stage_models key", () => {
  async function stageModelsRow(userId: string) {
    const [row] = await db
      .select()
      .from(settings)
      .where(and(eq(settings.key, STAGE_MODELS_SETTING_KEY), eq(settings.userId, userId)))
    return row
  }

  it("stores a valid override under the calling user", async () => {
    const value = { write: { model: "claude-fable-5", effort: "max" } }

    const response = await PATCH(
      apiRequest(URL, {
        method: "PATCH",
        cookie: user.cookie,
        body: JSON.stringify({ [STAGE_MODELS_SETTING_KEY]: value }),
      }),
    )

    expect(response.status).toBe(200)
    expect((await stageModelsRow(user.userId)).value).toEqual(value)
    expect(await resolveStageModels(user.userId)).toMatchObject({
      write: { model: "claude-fable-5", effort: "max", modelSource: "user" },
    })
    expect(await resolveStageModels(other.userId)).toMatchObject({
      write: { model: "claude-opus-5", modelSource: "default" },
    })
  })

  it("422s on a model id that is not on the allowlist, and writes nothing", async () => {
    const response = await PATCH(
      apiRequest(URL, {
        method: "PATCH",
        cookie: user.cookie,
        body: JSON.stringify({ [STAGE_MODELS_SETTING_KEY]: { write: { model: "gpt-5" } } }),
      }),
    )

    expect(response.status).toBe(422)
    expect(await response.json()).toEqual({
      detail:
        "Invalid model 'gpt-5' for stage 'write'. " +
        "Verified values are claude-opus-5, claude-fable-5, claude-opus-4-6",
    })
    expect(await stageModelsRow(user.userId)).toBeUndefined()
  })

  it("422s on an effort for a provider that has none", async () => {
    const response = await PATCH(
      apiRequest(URL, {
        method: "PATCH",
        cookie: user.cookie,
        body: JSON.stringify({ [STAGE_MODELS_SETTING_KEY]: { images: { effort: "high" } } }),
      }),
    )

    expect(response.status).toBe(422)
    expect(await response.json()).toEqual({
      detail: "Stage 'images' runs on gemini, which has no 'effort' setting",
    })
  })

  it("rejects the whole batch before writing any of its keys", async () => {
    const response = await PATCH(
      apiRequest(URL, {
        method: "PATCH",
        cookie: user.cookie,
        body: JSON.stringify({
          [`${PREFIX}other`]: { kept: true },
          [STAGE_MODELS_SETTING_KEY]: { write: { effort: "extreme" } },
        }),
      }),
    )

    expect(response.status).toBe(422)
    const [row] = await db
      .select()
      .from(settings)
      .where(and(eq(settings.key, `${PREFIX}other`), eq(settings.userId, user.userId)))
    expect(row).toBeUndefined()
  })

  it("rejects the `{value: ...}` wrapper `api.ts` sends for other keys", async () => {
    // `settings.update()` types its body as `Record<string, {value: ...}>`,
    // which every other key stores verbatim. That wrapper is not a stage map,
    // so the settings page has to send the map itself.
    const response = await PATCH(
      apiRequest(URL, {
        method: "PATCH",
        cookie: user.cookie,
        body: JSON.stringify({
          [STAGE_MODELS_SETTING_KEY]: { value: { write: { model: "claude-opus-5" } } },
        }),
      }),
    )

    expect(response.status).toBe(422)
    expect((await response.json()).detail).toContain("Unknown stage 'value'")
  })
})
