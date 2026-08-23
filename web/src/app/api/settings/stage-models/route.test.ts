// @vitest-environment node
/**
 * Coverage for `GET /api/settings/stage-models`, the read side of item 6.3.
 *
 * Against the real database and a real BetterAuth session, because the whole
 * point of the endpoint is which row wins: a mocked resolver would prove
 * nothing about the layering it exists to expose.
 *
 * The global (`user_id IS NULL`) `stage_models` row is shared state on the dev
 * database, so it is captured before the suite and restored after, per the
 * hazard recorded in ledger item 6.0's evidence.
 */
import { and, eq, isNull, like } from "drizzle-orm"
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest"

import { closeDb, getDb, settings } from "@/db"
import {
  STAGE_MODEL_ALLOWLIST,
  STAGE_MODEL_DEFAULTS,
  STAGE_MODELS_SETTING_KEY,
  type StageModelSettings,
} from "@/mastra/stage-models"
import { STAGES } from "@/mastra/state"
import { apiRequest, createTestSession, deleteTestSessions, type TestSession } from "@/test/session"

import { GET } from "./route"

const PREFIX = "stage-models-route-test-"
const URL = "http://test/api/settings/stage-models"

const db = getDb()

let user: TestSession
let globalRowBefore: { value: unknown } | undefined

async function clearOwn() {
  await db.delete(settings).where(like(settings.userId, `${PREFIX}%`))
}

async function setGlobal(value: StageModelSettings | null) {
  await db
    .delete(settings)
    .where(and(eq(settings.key, STAGE_MODELS_SETTING_KEY), isNull(settings.userId)))
  if (value !== null) {
    await db.insert(settings).values({ key: STAGE_MODELS_SETTING_KEY, userId: null, value })
  }
}

async function setOwn(value: unknown) {
  await db
    .insert(settings)
    .values({ key: STAGE_MODELS_SETTING_KEY, userId: user.userId, value })
}

/** The response row for one stage, so a test reads by name not by index. */
async function stageRow(stage: string, cookie: string) {
  const body = await (await GET(apiRequest(URL, { cookie }))).json()
  return body.stages.find((row: { stage: string }) => row.stage === stage)
}

beforeAll(async () => {
  globalRowBefore = (
    await db
      .select({ value: settings.value })
      .from(settings)
      .where(and(eq(settings.key, STAGE_MODELS_SETTING_KEY), isNull(settings.userId)))
      .limit(1)
  )[0]

  await deleteTestSessions(PREFIX)
  user = await createTestSession(PREFIX)
  await clearOwn()
  await setGlobal(null)
})

afterEach(async () => {
  await clearOwn()
  await setGlobal(null)
})

afterAll(async () => {
  await clearOwn()
  await setGlobal(globalRowBefore ? (globalRowBefore.value as StageModelSettings) : null)
  await deleteTestSessions(PREFIX)
  await closeDb()
})

describe("GET /api/settings/stage-models", () => {
  it("401s without a session", async () => {
    const response = await GET(apiRequest(URL))

    expect(response.status).toBe(401)
    expect(await response.json()).toEqual({ detail: "Not authenticated" })
  })

  it("returns every stage in pipeline order with no rows stored", async () => {
    const body = await (await GET(apiRequest(URL, { cookie: user.cookie }))).json()

    expect(body.stages.map((row: { stage: string }) => row.stage)).toEqual([...STAGES])
    expect(body.overrides).toEqual({})
  })

  it("reports the verified defaults and their origin when nothing is stored", async () => {
    const write = await stageRow("write", user.cookie)

    expect(write).toMatchObject({
      provider: "anthropic",
      model: STAGE_MODEL_DEFAULTS.write.model,
      effort: STAGE_MODEL_DEFAULTS.write.effort,
      model_source: "default",
      effort_source: "default",
      fallback_model: STAGE_MODEL_DEFAULTS.write.model,
      fallback_effort: STAGE_MODEL_DEFAULTS.write.effort,
    })
  })

  it("carries each stage's allowlist, empty where the provider has no effort", async () => {
    const write = await stageRow("write", user.cookie)
    const images = await stageRow("images", user.cookie)

    expect(write.models).toEqual([...STAGE_MODEL_ALLOWLIST.write])
    expect(write.efforts).toEqual(["low", "medium", "high", "xhigh", "max"])
    expect(images.models).toEqual([...STAGE_MODEL_ALLOWLIST.images])
    expect(images.efforts).toEqual([])
  })

  it("resolves the global row when the user has none", async () => {
    await setGlobal({ write: { model: "claude-opus-4-6" } })

    const write = await stageRow("write", user.cookie)

    expect(write.model).toBe("claude-opus-4-6")
    expect(write.model_source).toBe("global")
    expect(write.fallback_model).toBe("claude-opus-4-6")
  })

  it("lets the user's row win and reports the global row as the fallback", async () => {
    await setGlobal({ write: { model: "claude-opus-4-6", effort: "low" } })
    await setOwn({ write: { model: "claude-fable-5" } })

    const write = await stageRow("write", user.cookie)

    expect(write).toMatchObject({
      model: "claude-fable-5",
      model_source: "user",
      // The user overrode only the model, so the global effort still applies.
      effort: "low",
      effort_source: "global",
      // What reverting this stage would produce, which is the global row and
      // not the hardcoded default.
      fallback_model: "claude-opus-4-6",
      fallback_effort: "low",
    })
  })

  it("returns the user's own row as overrides, for the client to write back", async () => {
    await setOwn({ edit: { effort: "max" } })

    const body = await (await GET(apiRequest(URL, { cookie: user.cookie }))).json()

    expect(body.overrides).toEqual({ edit: { effort: "max" } })
  })

  it("ignores a stored row that no longer validates, as the resolver does", async () => {
    await setOwn({ write: { model: "claude-retired-9" } })

    const body = await (await GET(apiRequest(URL, { cookie: user.cookie }))).json()

    expect(body.overrides).toEqual({})
    expect(body.stages.find((row: { stage: string }) => row.stage === "write").model).toBe(
      STAGE_MODEL_DEFAULTS.write.model,
    )
  })

  it("never reads another user's overrides", async () => {
    const other = await createTestSession(PREFIX)
    await db
      .insert(settings)
      .values({
        key: STAGE_MODELS_SETTING_KEY,
        userId: other.userId,
        value: { write: { model: "claude-fable-5" } },
      })

    const body = await (await GET(apiRequest(URL, { cookie: user.cookie }))).json()

    expect(body.overrides).toEqual({})
    expect(body.stages.find((row: { stage: string }) => row.stage === "write").model).toBe(
      STAGE_MODEL_DEFAULTS.write.model,
    )
  })
})
