// @vitest-environment node
/**
 * Ledger item 6.2a: the `settings`-backed per-stage model configuration.
 *
 * Everything here runs against the real `settings` table, because the whole
 * point of the module is which row wins, and a mocked query cannot be wrong
 * about that in the way a real one can.
 *
 * The global row is the hazard this file has to handle carefully. It is keyed
 * `stage_models` with a null `user_id`, so unlike the prefixed keys other
 * settings tests use, it is a row a real operator could own. It is captured
 * before the suite writes to it and restored afterwards, following the lesson
 * from iteration 132 where a failed restore destroyed live credentials.
 */
import { and, eq, isNull } from "drizzle-orm"
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest"

import { closeDb, getDb, settings } from "@/db"
import { createTestSession, deleteTestSessions, type TestSession } from "@/test/session"

import { EDIT_MODEL_ID } from "./agents/edit"
import { IMAGES_MODEL_ID } from "./agents/images"
import { CLAUDE_DEFAULT_EFFORT } from "./agents/claude"
import { OUTLINE_MODEL_ID } from "./agents/outline"
import { READY_MODEL_ID } from "./agents/ready"
import { RESEARCH_MODEL_ID } from "./agents/research"
import { WRITE_MODEL_ID } from "./agents/write"
import { GEMINI_IMAGE_MODEL_ID } from "./images/gemini"
import {
  CLAUDE_EFFORTS,
  parseStageModelSettings,
  resolveStageModel,
  resolveStageModels,
  STAGE_EFFORT_ALLOWLIST,
  STAGE_MODEL_ALLOWLIST,
  STAGE_MODEL_DEFAULTS,
  STAGE_MODEL_PROVIDER,
  STAGE_MODELS_SETTING_KEY,
  type StageModelSettings,
} from "./stage-models"
import { STAGES } from "./state"

const PREFIX = "stage-models-test-"

const db = getDb()

let user: TestSession
let other: TestSession
/** The global row as the suite found it, or null when there was none. */
let existingGlobal: { value: unknown; updatedAt: Date | null } | null = null

async function setGlobal(value: StageModelSettings) {
  await db
    .insert(settings)
    .values({ key: STAGE_MODELS_SETTING_KEY, value })
    .onConflictDoUpdate({
      target: [settings.key, settings.userId],
      set: { value, updatedAt: new Date() },
    })
}

async function setUser(userId: string, value: StageModelSettings) {
  await db.insert(settings).values({ key: STAGE_MODELS_SETTING_KEY, userId, value })
}

async function clearGlobal() {
  await db
    .delete(settings)
    .where(and(eq(settings.key, STAGE_MODELS_SETTING_KEY), isNull(settings.userId)))
}

async function clearRows() {
  await clearGlobal()
  for (const session of [user, other]) {
    if (!session) continue
    await db
      .delete(settings)
      .where(
        and(eq(settings.key, STAGE_MODELS_SETTING_KEY), eq(settings.userId, session.userId)),
      )
  }
}

beforeAll(async () => {
  const rows = await db
    .select({ value: settings.value, updatedAt: settings.updatedAt })
    .from(settings)
    .where(and(eq(settings.key, STAGE_MODELS_SETTING_KEY), isNull(settings.userId)))
    .limit(1)
  existingGlobal = rows[0] ?? null

  await deleteTestSessions(PREFIX)
  user = await createTestSession(PREFIX)
  other = await createTestSession(PREFIX)
  await clearRows()
})

afterEach(clearRows)

afterAll(async () => {
  await clearRows()
  if (existingGlobal) {
    await db.insert(settings).values({
      key: STAGE_MODELS_SETTING_KEY,
      value: existingGlobal.value,
      updatedAt: existingGlobal.updatedAt ?? undefined,
    })
  }
  await deleteTestSessions(PREFIX)
  await closeDb()
})

describe("the allowlist and the defaults", () => {
  it("defaults are exactly the ids the stage agents run today", () => {
    // The agents still own their own constants until item 6.2b; this binds the
    // two so the settings page cannot advertise a default the pipeline
    // contradicts. `*_MODEL_ID` carries Mastra's router prefix, the setting
    // carries the bare provider id.
    expect(`anthropic/${STAGE_MODEL_DEFAULTS.outline.model}`).toBe(OUTLINE_MODEL_ID)
    expect(`anthropic/${STAGE_MODEL_DEFAULTS.write.model}`).toBe(WRITE_MODEL_ID)
    expect(`anthropic/${STAGE_MODEL_DEFAULTS.edit.model}`).toBe(EDIT_MODEL_ID)
    expect(`anthropic/${STAGE_MODEL_DEFAULTS.ready.model}`).toBe(READY_MODEL_ID)
    expect(`perplexity/${STAGE_MODEL_DEFAULTS.research.model}`).toBe(RESEARCH_MODEL_ID)
    expect(STAGE_MODEL_DEFAULTS.images.model).toBe(GEMINI_IMAGE_MODEL_ID)
    // The images stage's Claude half is not what this setting selects.
    expect(IMAGES_MODEL_ID).toBe("anthropic/claude-opus-5")
  })

  it("default effort is the one every Claude stage sends today", () => {
    for (const stage of ["outline", "write", "edit", "ready"] as const) {
      expect(STAGE_MODEL_DEFAULTS[stage].effort).toBe(CLAUDE_DEFAULT_EFFORT)
    }
  })

  it("every default is itself an allowed value", () => {
    for (const stage of STAGES) {
      expect(STAGE_MODEL_ALLOWLIST[stage]).toContain(STAGE_MODEL_DEFAULTS[stage].model)
      const effort = STAGE_MODEL_DEFAULTS[stage].effort
      if (effort === null) expect(STAGE_EFFORT_ALLOWLIST[stage]).toEqual([])
      else expect(STAGE_EFFORT_ALLOWLIST[stage]).toContain(effort)
    }
  })

  it("offers effort only on the Anthropic stages", () => {
    expect(STAGE_MODEL_PROVIDER).toEqual({
      research: "perplexity",
      outline: "anthropic",
      write: "anthropic",
      edit: "anthropic",
      images: "gemini",
      ready: "anthropic",
    })
    for (const stage of STAGES) {
      expect(STAGE_EFFORT_ALLOWLIST[stage]).toEqual(
        STAGE_MODEL_PROVIDER[stage] === "anthropic" ? CLAUDE_EFFORTS : [],
      )
    }
  })

  it("lists only ids with a live provider response behind them", () => {
    // Item 6.1's pasted evidence, and nothing else. A new entry needs a new
    // live call, not a plausible-looking id.
    expect(STAGE_MODEL_ALLOWLIST).toEqual({
      research: ["sonar-pro"],
      outline: ["claude-opus-5", "claude-fable-5", "claude-opus-4-6"],
      write: ["claude-opus-5", "claude-fable-5", "claude-opus-4-6"],
      edit: ["claude-opus-5", "claude-fable-5", "claude-opus-4-6"],
      images: ["gemini-3-pro-image", "gemini-3.1-flash-image-preview"],
      ready: ["claude-opus-5", "claude-fable-5", "claude-opus-4-6"],
    })
  })
})

describe("parseStageModelSettings", () => {
  it("accepts an empty object", () => {
    expect(parseStageModelSettings({})).toEqual({ ok: true, data: {} })
  })

  it("accepts a model and an effort on an Anthropic stage", () => {
    expect(parseStageModelSettings({ write: { model: "claude-fable-5", effort: "max" } })).toEqual({
      ok: true,
      data: { write: { model: "claude-fable-5", effort: "max" } },
    })
  })

  it("accepts a model alone", () => {
    expect(parseStageModelSettings({ images: { model: "gemini-3.1-flash-image-preview" } })).toEqual(
      { ok: true, data: { images: { model: "gemini-3.1-flash-image-preview" } } },
    )
  })

  it("drops an explicit null, which is how a client clears one field", () => {
    expect(parseStageModelSettings({ edit: { model: null, effort: "low" } })).toEqual({
      ok: true,
      data: { edit: { effort: "low" } },
    })
  })

  it("rejects a non-object body", () => {
    for (const value of [null, [], "claude-opus-5", 3]) {
      const result = parseStageModelSettings(value)
      expect(result.ok).toBe(false)
      expect(result.ok === false && result.detail).toContain("must be an object keyed by stage")
    }
  })

  it("rejects an unknown stage", () => {
    const result = parseStageModelSettings({ publish: { model: "claude-opus-5" } })
    expect(result).toEqual({
      ok: false,
      detail:
        "Unknown stage 'publish'. Stages are research, outline, write, edit, images, ready",
    })
  })

  it("rejects a non-object stage entry", () => {
    const result = parseStageModelSettings({ write: "claude-opus-5" })
    expect(result.ok === false && result.detail).toBe(
      "Stage 'write' must be an object with 'model' and 'effort'",
    )
  })

  it("rejects an unknown field", () => {
    const result = parseStageModelSettings({ write: { temperature: 0.7 } })
    expect(result.ok === false && result.detail).toBe("Stage 'write' has no setting 'temperature'")
  })

  it("rejects a model id that is not on the allowlist", () => {
    const result = parseStageModelSettings({ write: { model: "claude-opus-9" } })
    expect(result.ok === false && result.detail).toBe(
      "Invalid model 'claude-opus-9' for stage 'write'. " +
        "Verified values are claude-opus-5, claude-fable-5, claude-opus-4-6",
    )
  })

  it("rejects a model that is allowed on a different stage", () => {
    const result = parseStageModelSettings({ research: { model: "claude-opus-5" } })
    expect(result.ok === false && result.detail).toContain("Verified values are sonar-pro")
  })

  it("rejects an effort on a provider that has none", () => {
    for (const stage of ["research", "images"] as const) {
      const result = parseStageModelSettings({ [stage]: { effort: "high" } })
      expect(result.ok === false && result.detail).toBe(
        `Stage '${stage}' runs on ${STAGE_MODEL_PROVIDER[stage]}, which has no 'effort' setting`,
      )
    }
  })

  it("rejects an effort outside Anthropic's enum", () => {
    const result = parseStageModelSettings({ ready: { effort: "extreme" } })
    expect(result.ok === false && result.detail).toBe(
      "Invalid effort 'extreme' for stage 'ready'. " +
        "Verified values are low, medium, high, xhigh, max",
    )
  })

  it("rejects a non-string value", () => {
    const result = parseStageModelSettings({ write: { model: 5 } })
    expect(result.ok === false && result.detail).toContain("Invalid model '5'")
  })
})

describe("resolveStageModels", () => {
  it("falls back to the verified defaults when nothing is stored", async () => {
    const resolved = await resolveStageModels(user.userId)

    for (const stage of STAGES) {
      expect(resolved[stage]).toEqual({
        stage,
        provider: STAGE_MODEL_PROVIDER[stage],
        model: STAGE_MODEL_DEFAULTS[stage].model,
        effort: STAGE_MODEL_DEFAULTS[stage].effort,
        modelSource: "default",
        effortSource: "default",
      })
    }
  })

  it("takes the global row when the user has no row", async () => {
    await setGlobal({ write: { model: "claude-opus-4-6", effort: "low" } })

    const resolved = await resolveStageModels(user.userId)

    expect(resolved.write).toMatchObject({
      model: "claude-opus-4-6",
      effort: "low",
      modelSource: "global",
      effortSource: "global",
    })
    expect(resolved.edit).toMatchObject({ model: "claude-opus-5", modelSource: "default" })
  })

  it("takes the user's row over the global row", async () => {
    await setGlobal({ write: { model: "claude-opus-4-6", effort: "low" } })
    await setUser(user.userId, { write: { model: "claude-fable-5", effort: "max" } })

    expect(await resolveStageModels(user.userId)).toMatchObject({
      write: { model: "claude-fable-5", effort: "max", modelSource: "user", effortSource: "user" },
    })
  })

  it("merges field by field, so a user override of one field keeps the other", async () => {
    await setGlobal({ write: { model: "claude-opus-4-6", effort: "low" } })
    await setUser(user.userId, { write: { effort: "xhigh" } })

    expect(await resolveStageModels(user.userId)).toMatchObject({
      write: {
        model: "claude-opus-4-6",
        effort: "xhigh",
        modelSource: "global",
        effortSource: "user",
      },
    })
  })

  it("does not leak one user's row into another user's resolution", async () => {
    await setUser(user.userId, { ready: { model: "claude-fable-5" } })

    expect(await resolveStageModels(other.userId)).toMatchObject({
      ready: { model: "claude-opus-5", modelSource: "default" },
    })
    expect(await resolveStageModels(user.userId)).toMatchObject({
      ready: { model: "claude-fable-5", modelSource: "user" },
    })
  })

  it("reads only the global row for an ownerless run", async () => {
    await setGlobal({ outline: { model: "claude-opus-4-6" } })
    await setUser(user.userId, { outline: { model: "claude-fable-5" } })

    expect(await resolveStageModels(null)).toMatchObject({
      outline: { model: "claude-opus-4-6", modelSource: "global" },
    })
  })

  it("ignores a stored value that no longer validates rather than failing a run", async () => {
    // A hand-edited row, or an id retired from the allowlist. The stage still
    // has a verified default; refusing to resolve would strand the pipeline.
    await setUser(user.userId, { write: { model: "claude-opus-retired" } } as StageModelSettings)

    expect(await resolveStageModels(user.userId)).toMatchObject({
      write: { model: "claude-opus-5", modelSource: "default" },
    })
  })

  it("resolveStageModel returns one stage's effective pair", async () => {
    await setUser(user.userId, { edit: { model: "claude-fable-5", effort: "medium" } })

    expect(await resolveStageModel("edit", user.userId)).toEqual({
      model: "claude-fable-5",
      effort: "medium",
    })
    expect(await resolveStageModel("research", user.userId)).toEqual({
      model: "sonar-pro",
      effort: null,
    })
  })
})
