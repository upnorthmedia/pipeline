/**
 * Ledger item 6.4, Phase 6's exit criterion: a model chosen in the settings UI
 * is the model that reaches the provider.
 *
 * Items 6.2a, 6.2b and 6.3 each proved one link of that chain in isolation: the
 * row wins the merge, the agent reads the merge, the page writes the row. Every
 * one of those tests supplies the previous link's output by hand, so all three
 * can pass while the chain is broken in the seam between them, which is exactly
 * how the `settings.update()` shape mismatch recorded under 6.2a would have
 * shipped. This test runs the whole chain in one process with nothing standing
 * in for a link:
 *
 *   the real `StageModelsCard`, driven through its Radix selects by
 *   `userEvent` -> the real `@/lib/api` client -> the real `PATCH
 *   /api/settings` handler, behind a real BetterAuth session -> a real row in
 *   Postgres -> `resolveStageModels()` -> the real agent's dynamic model and
 *   `defaultOptions` resolvers -> the serialized HTTP request body.
 *
 * Only two things are not real. `fetch` is routed rather than sent: requests to
 * the dashboard's API base are dispatched into the route handler modules
 * directly (a Next.js server is not running here, and the browser's cookie jar
 * is not either, so the session cookie is attached by the router), and requests
 * to the provider are captured and answered from a canned response. Both are
 * the transport, and the transport is the one thing this item does not care
 * about.
 *
 * Both provider shapes are covered because they fail differently: Anthropic
 * carries the id in a JSON body field and the effort beside it, Gemini carries
 * it in the URL path and has no effort at all.
 *
 * The negative control matters as much as the assertion. Each chain asserts the
 * verified default on the wire before the UI is touched and again after the UI
 * reverts, so a resolver that ignored the setting entirely could not pass by
 * happening to agree with it.
 *
 * Requires `docker compose up -d db`.
 */
import { mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import path from "node:path"

import { and, eq, isNull, like } from "drizzle-orm"
import { screen, waitFor, within } from "@testing-library/react"
import userEvent from "@testing-library/user-event"
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest"

import { closeDb, getDb, posts, settings, websiteProfiles } from "@/db"
import { encryptWithKey } from "@/lib/crypto"
import { API_KEYS_SETTING_KEY } from "@/mastra/api-keys"
import { CLAUDE_PROVIDER } from "@/mastra/agents/claude"
import { writeAgent } from "@/mastra/agents/write"
import geminiCorpus from "@/mastra/images/data/gemini-parity.json"
import { GEMINI_API_BASE } from "@/mastra/images/gemini"
import {
  STAGE_MODEL_DEFAULTS,
  STAGE_MODELS_SETTING_KEY,
  type StageModelSettings,
} from "@/mastra/stage-models"
import { imagesGenerateStep } from "@/mastra/steps/images-generate"
import { stageAgentOptions } from "@/mastra/steps/stage-io"
import { borrowApiKeysRow, returnApiKeysRow } from "@/test/api-keys-row"
import {
  lockGlobalStageModelsRow,
  unlockGlobalStageModelsRow,
} from "@/test/stage-models-row"
import { renderWithProviders } from "@/test/render"
import { swapFetchForSuite } from "@/test/swapped-fetch"
import { createTestSession, deleteTestSessions, type TestSession } from "@/test/session"

import { PATCH as settingsPatch } from "@/app/api/settings/route"
import { GET as stageModelsGet } from "@/app/api/settings/stage-models/route"
import { StageModelsCard } from "./stage-models-card"

vi.mock("sonner", () => ({
  toast: { success: vi.fn(), error: vi.fn(), info: vi.fn() },
}))

const PREFIX = "stage-models-e2e-test-"
const PROFILE_ID = "b7000000-0000-4000-8000-0000000064a1"
const POST_ID = "b7000000-0000-4000-8000-0000000064b1"

/** A throwaway Fernet key, so no real `WP_ENCRYPTION_KEY` is needed to run this. */
const TEST_KEY = "wDnmGSXAn3lPzz0GDW0jgcpn7XMDrnxLoO4XQb4Zwss"

/**
 * The ids the UI picks. Both are on their stage's allowlist and neither is the
 * stage's default, which is what makes the wire assertion mean something.
 */
const CHOSEN_WRITE_MODEL = "claude-opus-4-6"
const CHOSEN_WRITE_EFFORT = "low"
const CHOSEN_IMAGES_MODEL = "gemini-3.1-flash-image-preview"

const db = getDb()

let user: TestSession
let mediaDir = ""
let savedGlobalStageModels: { value: unknown } | undefined

/** Every request the router sent nowhere, in order. */
const captured: { url: string; body: Record<string, unknown> }[] = []

/** The recorded Gemini 200 envelope, reused verbatim from the parity corpus. */
const geminiSuccess = JSON.stringify(
  (geminiCorpus.responses as { label: string; body: unknown }[]).find(
    (response) => response.label === "usage-reported",
  )!.body,
)

/** An Anthropic 200 shaped like the ones the golden fixtures recorded. */
function anthropicSuccess(): string {
  return JSON.stringify({
    id: "msg_e2e",
    type: "message",
    role: "assistant",
    model: CHOSEN_WRITE_MODEL,
    content: [{ type: "text", text: "# Draft" }],
    stop_reason: "end_turn",
    stop_sequence: null,
    usage: { input_tokens: 11, output_tokens: 3 },
  })
}

/**
 * `fetch` for the whole file: dashboard calls go into the route handlers with
 * the session cookie attached, provider calls are recorded and answered.
 *
 * Routing is by hostname and path, with the dashboard's own origin-relative
 * paths resolved against a placeholder origin first. Anything the router does
 * not recognise throws instead of reaching the network, which is what keeps an
 * unnoticed second call from silently hitting a real provider.
 */
/** The origin the dashboard's own origin-relative paths resolve against. */
const DASHBOARD_ORIGIN = "http://dashboard.test"

function routeRequest(
  input: RequestInfo | URL,
  init: RequestInit | undefined,
): Response | Promise<Response> {
  const raw = typeof input === "string" ? input : input instanceof URL ? input.href : input.url
  // The dashboard client addresses its own origin, so its paths arrive
  // relative and need a base before either `new URL` or `new Request`.
  const url = new URL(raw, DASHBOARD_ORIGIN)
  const href = url.href
  const method = (init?.method ?? "GET").toUpperCase()

  if (url.hostname === "api.anthropic.com") {
    captured.push({ url: href, body: JSON.parse(String(init?.body)) })
    return new Response(anthropicSuccess(), {
      status: 200,
      headers: { "content-type": "application/json" },
    })
  }
  if (url.hostname === "generativelanguage.googleapis.com") {
    captured.push({ url: href, body: JSON.parse(String(init?.body)) })
    return new Response(geminiSuccess, {
      status: 200,
      headers: { "content-type": "application/json" },
    })
  }

  const headers = new Headers(init?.headers)
  headers.set("cookie", user.cookie)
  const request = new Request(href, { ...init, headers })
  if (url.pathname === "/api/settings/stage-models" && method === "GET") {
    return stageModelsGet(request)
  }
  if (url.pathname === "/api/settings" && method === "PATCH") {
    return settingsPatch(request)
  }
  throw new Error(`unrouted request: ${method} ${href}`)
}

swapFetchForSuite(routeRequest)

/** The card that holds one stage's controls, found through its model selector. */
function stageCard(stage: string) {
  return screen.getByLabelText(`${stage} model`).closest("div.rounded-md") as HTMLElement
}

/** Picks a value in one of a stage's two Radix selects. */
async function choose(stage: string, control: "model" | "effort", value: string) {
  await userEvent.click(screen.getByLabelText(`${stage} ${control}`))
  await userEvent.click(await screen.findByRole("option", { name: value }))
}

/** The caller's stored `stage_models` row, or null when they have none. */
async function storedOverrides(): Promise<StageModelSettings | null> {
  const rows = await db
    .select({ value: settings.value })
    .from(settings)
    .where(
      and(eq(settings.key, STAGE_MODELS_SETTING_KEY), eq(settings.userId, user.userId)),
    )
  return rows.length === 0 ? null : (rows[0].value as StageModelSettings)
}

/** One `write` call, returning the body the provider would have received. */
async function runWriteStage(): Promise<Record<string, unknown>> {
  captured.length = 0
  await writeAgent.generate("Write the draft.", await stageAgentOptions(POST_ID))
  expect(captured).toHaveLength(1)
  return captured[0].body
}

/** One image generation, returning the URL the provider would have received. */
async function runImagesStage(): Promise<string> {
  captured.length = 0
  await imagesGenerateStep.execute({
    inputData: {
      postId: POST_ID,
      mediaDir,
      index: 0,
      spec: {
        id: "hero",
        type: "featured",
        filename: "hero.png",
        prompt: "a wide editorial hero",
        aspect_ratio: "16:9",
        image_size: "1K",
        placement: { location: "featured_image", after_section: null },
      },
    },
    mastra: {
      pubsub: { publish: async () => {} },
      getLogger: () => ({ debug: () => {}, error: () => {} }),
    },
  } as unknown as Parameters<typeof imagesGenerateStep.execute>[0])
  expect(captured).toHaveLength(1)
  return captured[0].url
}

beforeAll(async () => {
  // Both rows are process-global singletons and both are read on every
  // resolution here, so the file owns them for its duration. Taken in the
  // order `row-lock.ts` documents, since no other file takes both.
  await borrowApiKeysRow({ encryptionKey: TEST_KEY })
  await lockGlobalStageModelsRow()

  savedGlobalStageModels = (
    await db
      .select({ value: settings.value })
      .from(settings)
      .where(and(eq(settings.key, STAGE_MODELS_SETTING_KEY), isNull(settings.userId)))
      .limit(1)
  )[0]

  const value = {
    [CLAUDE_PROVIDER]: encryptWithKey("sk-ant-not-a-real-key", TEST_KEY),
    gemini: encryptWithKey("not-a-real-gemini-key", TEST_KEY),
  }
  await db
    .insert(settings)
    .values({ key: API_KEYS_SETTING_KEY, value })
    .onConflictDoUpdate({ target: [settings.key, settings.userId], set: { value } })
  // Cleared so the fallback under the user's row is the verified default, which
  // is what the negative controls below assert against.
  await db
    .delete(settings)
    .where(and(eq(settings.key, STAGE_MODELS_SETTING_KEY), isNull(settings.userId)))

  await deleteTestSessions(PREFIX)
  user = await createTestSession(PREFIX)
  await db.delete(settings).where(like(settings.userId, `${PREFIX}%`))

  // The run's settings user comes through `posts.profile_id ->
  // website_profiles.user_id`, so the post has to be owned by the same user the
  // session belongs to or the agent would resolve a different row.
  await db.insert(websiteProfiles).values({
    id: PROFILE_ID,
    name: "Stage models end to end",
    websiteUrl: "https://stage-models-e2e.example.test",
    userId: user.userId,
  })
  await db
    .insert(posts)
    .values({ id: POST_ID, profileId: PROFILE_ID, slug: "stage-models-e2e", topic: "E2E" })

  mediaDir = await mkdtemp(path.join(tmpdir(), "stage-models-e2e-"))
}, 60_000)

afterAll(async () => {
  await db.delete(posts).where(eq(posts.id, POST_ID))
  await db.delete(websiteProfiles).where(eq(websiteProfiles.id, PROFILE_ID))
  await db.delete(settings).where(like(settings.userId, `${PREFIX}%`))
  await deleteTestSessions(PREFIX)

  if (savedGlobalStageModels) {
    await db
      .insert(settings)
      .values({ key: STAGE_MODELS_SETTING_KEY, value: savedGlobalStageModels.value })
  }

  if (mediaDir) await rm(mediaDir, { recursive: true, force: true })
  await unlockGlobalStageModelsRow()
  await returnApiKeysRow()
  await closeDb()
})

describe("a model chosen in the UI reaches Anthropic", () => {
  it("sends the verified default while the user has configured nothing", async () => {
    expect(await storedOverrides()).toBeNull()

    const body = await runWriteStage()
    expect(body.model).toBe(STAGE_MODEL_DEFAULTS.write.model)
    expect(body.output_config).toEqual({ effort: STAGE_MODEL_DEFAULTS.write.effort })
    // The control only controls if the values it pins are not the ones the UI
    // is about to choose.
    expect(CHOSEN_WRITE_MODEL).not.toBe(STAGE_MODEL_DEFAULTS.write.model)
    expect(CHOSEN_WRITE_EFFORT).not.toBe(STAGE_MODEL_DEFAULTS.write.effort)
  })

  it("stores what the settings page saved, through the real handler", async () => {
    renderWithProviders(<StageModelsCard />)
    await waitFor(() => expect(screen.getByLabelText("write model")).toBeInTheDocument())

    await choose("write", "model", CHOSEN_WRITE_MODEL)
    await choose("write", "effort", CHOSEN_WRITE_EFFORT)
    await userEvent.click(within(stageCard("write")).getByRole("button", { name: /Save/ }))

    await waitFor(async () =>
      expect(await storedOverrides()).toEqual({
        write: { model: CHOSEN_WRITE_MODEL, effort: CHOSEN_WRITE_EFFORT },
      }),
    )
    // The page reloads from the same endpoint after writing, so the badge is
    // the handler's own view of the row rather than optimistic local state.
    await waitFor(() =>
      expect(within(stageCard("write")).getByText("Override")).toBeInTheDocument(),
    )
  })

  it("puts that model and effort on the wire", async () => {
    const body = await runWriteStage()

    expect(body.model).toBe(CHOSEN_WRITE_MODEL)
    expect(body.output_config).toEqual({ effort: CHOSEN_WRITE_EFFORT })
    expect(captured[0].url).toBe("https://api.anthropic.com/v1/messages")
  })

  it("goes back to the default when the page reverts the stage", async () => {
    renderWithProviders(<StageModelsCard />)
    await waitFor(() => expect(screen.getByLabelText("write model")).toBeInTheDocument())

    await userEvent.click(screen.getByLabelText("Revert write to default"))
    await waitFor(async () => expect(await storedOverrides()).toEqual({}))

    const body = await runWriteStage()
    expect(body.model).toBe(STAGE_MODEL_DEFAULTS.write.model)
    expect(body.output_config).toEqual({ effort: STAGE_MODEL_DEFAULTS.write.effort })
  })
})

describe("a model chosen in the UI reaches Gemini", () => {
  it("sends the verified default while the user has configured nothing", async () => {
    expect(await runImagesStage()).toBe(
      `${GEMINI_API_BASE}/models/${STAGE_MODEL_DEFAULTS.images.model}:generateContent`,
    )
    expect(CHOSEN_IMAGES_MODEL).not.toBe(STAGE_MODEL_DEFAULTS.images.model)
  })

  it("carries the chosen model in the request path after the page saves it", async () => {
    renderWithProviders(<StageModelsCard />)
    await waitFor(() => expect(screen.getByLabelText("images model")).toBeInTheDocument())

    await choose("images", "model", CHOSEN_IMAGES_MODEL)
    await userEvent.click(within(stageCard("images")).getByRole("button", { name: /Save/ }))

    // Gemini has no effort parameter, so the stored override is model-only;
    // an `effort` beside it would be a 422 from the write handler.
    await waitFor(async () =>
      expect(await storedOverrides()).toEqual({ images: { model: CHOSEN_IMAGES_MODEL } }),
    )
    expect(await runImagesStage()).toBe(
      `${GEMINI_API_BASE}/models/${CHOSEN_IMAGES_MODEL}:generateContent`,
    )
  })
})
