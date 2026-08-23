// @vitest-environment node
/**
 * The six pipeline-control endpoints on a single post: `/run`, `/run-all`,
 * `/rerun`, `/restart`, `/pause` and `/publish`.
 *
 * They run against the real database and real BetterAuth sessions, so the
 * `website_profiles.user_id` scoping is exercised for real, and the enqueues
 * are read back off the real Redis Streams bus rather than asserted against a
 * spy.
 *
 * Every real enqueue in this file starts a run that cannot reach a provider,
 * because a worker started by another test file shares the bus and would
 * otherwise consume it:
 *
 * - the `/run` case leaves `stage_settings` gating `research` at "review", so
 *   the run suspends at its first stage before it spends anything;
 * - the `/run-all` case uses a post whose six stages are all complete, so every
 *   stage is skipped and only the completion step runs;
 * - the stage-selection case starts `startPipeline()` on a post id that does
 *   not exist, so the step throws out of `loadPipelineState()` before it
 *   renders a prompt.
 *
 * Every other test replaces the start with a recorded no-op, which is also how
 * the `?stage=` mapping is asserted: those runs name a stage, and a named stage
 * skips the review gate by design (`stageNeedsReview()`), so starting one for
 * real would put a live provider call on the bus.
 *
 * Requires `docker compose up -d db redis`.
 */
import { randomUUID } from "node:crypto"

import { RedisStreamsPubSub } from "@mastra/redis-streams"
import { eq, like } from "drizzle-orm"
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest"

import { closeDb, getDb, posts, websiteProfiles } from "@/db"
import { STAGE_CONTENT_MAP } from "@/mastra/state"
import { apiRequest, createTestSession, deleteTestSessions, type TestSession } from "@/test/session"

import { POST as pausePost } from "./[id]/pause/route"
import { POST as restartPipeline } from "./[id]/restart/route"
import { POST as rerunStage } from "./[id]/rerun/route"
import { POST as runStage } from "./[id]/run/route"
import { POST as publishPost } from "./[id]/publish/route"
import { POST as runAll } from "./[id]/run-all/route"
import { STAGE_CONTENT_COLUMN } from "./run-control"

const start = vi.hoisted(() => ({
  mode: "skip" as "real" | "skip",
  calls: [] as { postId: string; stages?: string[] }[],
}))

vi.mock("@/mastra/start-pipeline", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/mastra/start-pipeline")>()
  return {
    startPipeline: async (postId: string, stages?: string[]) => {
      start.calls.push({ postId, stages })
      if (start.mode === "skip") return "not-started"
      return actual.startPipeline(postId, stages as never)
    },
  }
})

/**
 * `/publish` starts a different workflow from the other five, so it gets its
 * own recorder. The mock reads the row back before handing the start on, which
 * is the only way to see that Python committed `wp_publish_status = "pending"`
 * *before* it enqueued: the worker overwrites the value as soon as it picks the
 * event up, so an assertion made after the response cannot tell the two orders
 * apart.
 */
const wpStart = vi.hoisted(() => ({
  mode: "skip" as "real" | "skip",
  calls: [] as { postId: string; statusAtStart: string | null }[],
}))

vi.mock("@/mastra/start-wordpress-publish", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/mastra/start-wordpress-publish")>()
  const { getDb, posts } = await import("@/db")
  const { eq } = await import("drizzle-orm")
  return {
    startWordPressPublish: async (postId: string) => {
      const [row] = await getDb()
        .select({ status: posts.wpPublishStatus })
        .from(posts)
        .where(eq(posts.id, postId))
        .limit(1)
      wpStart.calls.push({ postId, statusAtStart: row?.status ?? null })
      if (wpStart.mode === "skip") return "not-started"
      return actual.startWordPressPublish(postId)
    },
  }
})

const PREFIX = "posts-runctl-test-"
const URL_BASE = "http://test/api/posts"
const MISSING_ID = "00000000-0000-4000-8000-000000000000"

/** Discard port on loopback: nothing here should ever reach a real site. */
const SITE = "http://127.0.0.1:9/site"

const ALL_STAGES = ["research", "outline", "write", "edit", "images", "ready"] as const

/** `stage_settings` that pause a full run at its first stage. */
const GATED_STAGE_SETTINGS = {
  research: "review",
  outline: "auto",
  write: "auto",
  edit: "auto",
  images: "auto",
  ready: "auto",
}

const ALL_COMPLETE = Object.fromEntries(ALL_STAGES.map((stage) => [stage, "complete"]))

type StartEvent = { type: string; data?: { workflowId?: string; prevResult?: { output?: unknown } } }

const db = getDb()
const observer = new RedisStreamsPubSub({ url: process.env.REDIS_URL! })
const started: StartEvent[] = []

let user: TestSession
let other: TestSession

async function clearFixtures() {
  await db.delete(posts).where(like(posts.slug, `${PREFIX}%`))
  await db.delete(websiteProfiles).where(like(websiteProfiles.userId, `${PREFIX}%`))
}

async function insertProfile(userId: string) {
  const [row] = await db
    .insert(websiteProfiles)
    .values({ userId, name: "Test Blog", websiteUrl: SITE })
    .returning()
  return row
}

async function insertPost(
  userId: string,
  values: Partial<typeof posts.$inferInsert> = {},
): Promise<typeof posts.$inferSelect> {
  const profile = await insertProfile(userId)
  const [row] = await db
    .insert(posts)
    .values({
      slug: `${PREFIX}${randomUUID()}`,
      topic: "A topic",
      profileId: profile.id,
      stageSettings: GATED_STAGE_SETTINGS,
      ...values,
    })
    .returning()
  return row
}

async function readPost(id: string) {
  const [row] = await db.select().from(posts).where(eq(posts.id, id)).limit(1)
  return row
}

function run(id: string, query = "", cookie?: string) {
  return runStage(apiRequest(`${URL_BASE}/${id}/run${query}`, { cookie, method: "POST" }), {
    params: Promise.resolve({ id }),
  })
}

function all(id: string, cookie?: string) {
  return runAll(apiRequest(`${URL_BASE}/${id}/run-all`, { cookie, method: "POST" }), {
    params: Promise.resolve({ id }),
  })
}

function rerun(id: string, cookie?: string) {
  return rerunStage(apiRequest(`${URL_BASE}/${id}/rerun`, { cookie, method: "POST" }), {
    params: Promise.resolve({ id }),
  })
}

function pause(id: string, cookie?: string) {
  return pausePost(apiRequest(`${URL_BASE}/${id}/pause`, { cookie, method: "POST" }), {
    params: Promise.resolve({ id }),
  })
}

function restart(id: string, cookie?: string) {
  return restartPipeline(apiRequest(`${URL_BASE}/${id}/restart`, { cookie, method: "POST" }), {
    params: Promise.resolve({ id }),
  })
}

function publish(id: string, cookie?: string) {
  return publishPost(apiRequest(`${URL_BASE}/${id}/publish`, { cookie, method: "POST" }), {
    params: Promise.resolve({ id }),
  })
}

/** Resolves once a `workflow.start` for `workflowId` carrying `postId` arrives. */
async function waitForStart(
  postId: string,
  timeoutMs = 15_000,
  workflowId = "pipeline",
): Promise<StartEvent> {
  const deadline = Date.now() + timeoutMs
  for (;;) {
    const match = started.find(
      (event) =>
        event.data?.workflowId === workflowId &&
        (event.data?.prevResult?.output as { postId?: string } | undefined)?.postId === postId,
    )
    if (match) return match
    if (Date.now() > deadline) {
      throw new Error(`no workflow.start for ${postId} within ${timeoutMs}ms`)
    }
    await new Promise((resolve) => setTimeout(resolve, 25))
  }
}

beforeAll(async () => {
  // No `group`, so this subscription is its own fan-out consumer group and can
  // never take an event away from a worker.
  await observer.subscribe("workflows", (event: unknown) => {
    started.push(event as StartEvent)
  })
  await clearFixtures()
  await deleteTestSessions(PREFIX)
  user = await createTestSession(PREFIX)
  other = await createTestSession(PREFIX)
})

afterEach(async () => {
  start.mode = "skip"
  start.calls.length = 0
  wpStart.mode = "skip"
  wpStart.calls.length = 0
  started.length = 0
  await clearFixtures()
})

afterAll(async () => {
  await clearFixtures()
  await deleteTestSessions(PREFIX)
  await observer.close()
  await closeDb()
})

// --- POST /api/posts/{post_id}/run ------------------------------------------

describe("POST /api/posts/{post_id}/run", () => {
  it("rejects an unauthenticated request", async () => {
    const response = await run(MISSING_ID)
    expect(response.status).toBe(401)
    expect(start.calls).toEqual([])
  })

  it("answers a malformed path uuid with FastAPI's 422", async () => {
    const response = await run("not-a-uuid", "", user.cookie)
    expect(response.status).toBe(422)
    expect(await response.json()).toEqual({
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

  it("answers a post that does not exist with a 404", async () => {
    const response = await run(MISSING_ID, "", user.cookie)
    expect(response.status).toBe(404)
    expect(await response.json()).toEqual({ detail: "Post not found" })
    expect(start.calls).toEqual([])
  })

  it("answers another user's post with the same 404, starting nothing", async () => {
    const post = await insertPost(other.userId)
    const response = await run(post.id, "", user.cookie)
    expect(response.status).toBe(404)
    expect(start.calls).toEqual([])
    expect((await readPost(post.id)).currentStage).toBe("pending")
  })

  it("prefers the 404 over the invalid-stage 400 on another user's post", async () => {
    // Python resolved the post before it looked at `stage`, so a bad stage
    // never confirms that someone else's post exists.
    const post = await insertPost(other.userId)
    const response = await run(post.id, "?stage=bogus", user.cookie)
    expect(response.status).toBe(404)
  })

  it("answers a stage outside STAGES with a 400 naming it", async () => {
    const post = await insertPost(user.userId)
    const response = await run(post.id, "?stage=bogus", user.cookie)
    expect(response.status).toBe(400)
    expect(await response.json()).toEqual({ detail: "Invalid stage: bogus" })
    expect(start.calls).toEqual([])
    expect((await readPost(post.id)).currentStage).toBe("pending")
  })

  it("answers a fully complete pipeline with a 400, starting nothing", async () => {
    const post = await insertPost(user.userId, { stageStatus: ALL_COMPLETE })
    const response = await run(post.id, "", user.cookie)
    expect(response.status).toBe(400)
    expect(await response.json()).toEqual({ detail: "Pipeline already complete" })
    expect(start.calls).toEqual([])
  })

  it("targets the first stage of a post that has run nothing", async () => {
    const post = await insertPost(user.userId)
    const response = await run(post.id, "", user.cookie)

    expect(response.status).toBe(202)
    expect(await response.json()).toEqual({
      status: "queued",
      stage: "research",
      post_id: post.id,
    })

    const row = await readPost(post.id)
    expect(row.currentStage).toBe("research")
    expect(row.stageStatus).toEqual({ research: "running" })
    // No stage was named, so the run is a full pipeline that re-derives the
    // same starting point from the row rather than being pinned to it.
    expect(start.calls).toEqual([{ postId: post.id, stages: undefined }])
  })

  it("targets the first incomplete stage, preserving the statuses around it", async () => {
    const post = await insertPost(user.userId, {
      stageStatus: { research: "complete", outline: "complete", write: "failed" },
    })
    const response = await run(post.id, "", user.cookie)

    expect(await response.json()).toMatchObject({ stage: "write" })
    expect((await readPost(post.id)).stageStatus).toEqual({
      research: "complete",
      outline: "complete",
      write: "running",
    })
  })

  it("treats an empty ?stage= as absent, the way a falsy Python string was", async () => {
    const post = await insertPost(user.userId)
    const response = await run(post.id, "?stage=", user.cookie)

    expect(response.status).toBe(202)
    expect(await response.json()).toMatchObject({ stage: "research" })
    expect(start.calls).toEqual([{ postId: post.id, stages: undefined }])
  })

  it("keeps the last value of a repeated ?stage=, as Starlette's QueryParams does", async () => {
    const post = await insertPost(user.userId)
    const response = await run(post.id, "?stage=write&stage=edit", user.cookie)

    expect(await response.json()).toMatchObject({ stage: "edit" })
    expect(start.calls).toEqual([{ postId: post.id, stages: ["edit"] }])
  })

  it("runs a named stage that is already complete, marking only that stage running", async () => {
    const post = await insertPost(user.userId, { stageStatus: ALL_COMPLETE })
    const response = await run(post.id, "?stage=edit", user.cookie)

    expect(response.status).toBe(202)
    expect(await response.json()).toEqual({ status: "queued", stage: "edit", post_id: post.id })

    const row = await readPost(post.id)
    expect(row.currentStage).toBe("edit")
    expect(row.stageStatus).toEqual({ ...ALL_COMPLETE, edit: "running" })
    expect(start.calls).toEqual([{ postId: post.id, stages: ["edit"] }])
  })

  it("publishes a real workflow.start for the gated full run", async () => {
    start.mode = "real"
    const post = await insertPost(user.userId)

    const response = await run(post.id, "", user.cookie)
    expect(response.status).toBe(202)

    const event = await waitForStart(post.id)
    expect(event.type).toBe("workflow.start")
    expect((event.data?.prevResult?.output as { stages?: unknown }).stages).toBeUndefined()
  })

  it("carries a named stage selection across the bus", async () => {
    // Started directly on an id no post has, so a worker that picks it up
    // throws out of `loadPipelineState()` instead of calling a provider: a
    // named stage skips the review gate, so a real post here could spend.
    const { startPipeline } = await import("@/mastra/start-pipeline")
    start.mode = "real"
    const orphan = randomUUID()

    await startPipeline(orphan, ["outline"] as never)

    const event = await waitForStart(orphan)
    expect((event.data?.prevResult?.output as { stages?: unknown }).stages).toEqual(["outline"])
  })
})

// --- POST /api/posts/{post_id}/run-all --------------------------------------

describe("POST /api/posts/{post_id}/run-all", () => {
  it("rejects an unauthenticated request", async () => {
    const response = await all(MISSING_ID)
    expect(response.status).toBe(401)
    expect(start.calls).toEqual([])
  })

  it("answers a malformed path uuid with FastAPI's 422", async () => {
    const response = await all("not-a-uuid", user.cookie)
    expect(response.status).toBe(422)
    expect(await response.json()).toMatchObject({
      detail: [{ type: "uuid_parsing", loc: ["path", "post_id"] }],
    })
  })

  it("answers a post that does not exist with a 404", async () => {
    const response = await all(MISSING_ID, user.cookie)
    expect(response.status).toBe(404)
    expect(await response.json()).toEqual({ detail: "Post not found" })
    expect(start.calls).toEqual([])
  })

  it("answers another user's post with the same 404, writing nothing", async () => {
    const post = await insertPost(other.userId)
    const response = await all(post.id, user.cookie)
    expect(response.status).toBe(404)
    expect(start.calls).toEqual([])
    expect((await readPost(post.id)).stageSettings).toEqual(GATED_STAGE_SETTINGS)
  })

  it("forces every incomplete stage to auto and starts an unselected run", async () => {
    const post = await insertPost(user.userId)
    const response = await all(post.id, user.cookie)

    expect(response.status).toBe(202)
    expect(await response.json()).toEqual({
      status: "queued",
      mode: "run-all",
      post_id: post.id,
    })

    expect((await readPost(post.id)).stageSettings).toEqual({
      research: "auto",
      outline: "auto",
      write: "auto",
      edit: "auto",
      images: "auto",
      ready: "auto",
    })
    expect(start.calls).toEqual([{ postId: post.id, stages: undefined }])
  })

  it("leaves a completed stage's mode alone", async () => {
    // Python's guard was on `stage_status`, not on the mode, so a stage that
    // already ran keeps its review setting for the next rerun.
    const post = await insertPost(user.userId, {
      stageSettings: { research: "review", outline: "review", write: "review" },
      stageStatus: { research: "complete", outline: "complete" },
    })
    await all(post.id, user.cookie)

    expect((await readPost(post.id)).stageSettings).toEqual({
      research: "review",
      outline: "review",
      write: "auto",
      edit: "auto",
      images: "auto",
      ready: "auto",
    })
  })

  it("preserves stage_settings keys that are not stage names", async () => {
    // `dict(post.stage_settings or {})` copied the whole map and only wrote the
    // six stage keys back, so anything else stored there survived.
    const post = await insertPost(user.userId, {
      stageSettings: { research: "review", legacy_key: "kept" } as never,
    })
    await all(post.id, user.cookie)

    expect((await readPost(post.id)).stageSettings).toMatchObject({
      research: "auto",
      legacy_key: "kept",
    })
  })

  it("changes no mode when every stage is complete", async () => {
    const post = await insertPost(user.userId, { stageStatus: ALL_COMPLETE })
    await all(post.id, user.cookie)

    expect((await readPost(post.id)).stageSettings).toEqual(GATED_STAGE_SETTINGS)
  })

  it("publishes a real workflow.start for a post with nothing left to run", async () => {
    // Every stage complete, so the run this starts skips all six and reaches
    // only the completion step: a real enqueue that cannot call a provider.
    start.mode = "real"
    const post = await insertPost(user.userId, { stageStatus: ALL_COMPLETE })

    const response = await all(post.id, user.cookie)
    expect(response.status).toBe(202)

    const event = await waitForStart(post.id)
    expect(event.type).toBe("workflow.start")
    expect((event.data?.prevResult?.output as { stages?: unknown }).stages).toBeUndefined()
  })
})

// --- POST /api/posts/{post_id}/rerun ----------------------------------------

/** Every content column populated, so a reset is visible wherever it lands. */
const FULL_CONTENT = {
  researchContent: "research",
  outlineContent: "outline",
  draftContent: "draft",
  finalMdContent: "final md",
  finalHtmlContent: "<p>final html</p>",
  imageManifest: { images: [{ filename: "hero.webp" }] },
  readyContent: "ready",
}

const ALL_PENDING = Object.fromEntries(ALL_STAGES.map((stage) => [stage, "pending"]))

describe("STAGE_CONTENT_COLUMN", () => {
  it("names the same columns STAGE_CONTENT_MAP does", async () => {
    const { getTableColumns } = await import("drizzle-orm")
    const columns = getTableColumns(posts)
    for (const stage of ALL_STAGES) {
      expect(columns[STAGE_CONTENT_COLUMN[stage]].name).toBe(STAGE_CONTENT_MAP[stage])
    }
  })
})

describe("POST /api/posts/{post_id}/rerun", () => {
  it("rejects an unauthenticated request", async () => {
    const response = await rerun(MISSING_ID)
    expect(response.status).toBe(401)
    expect(start.calls).toEqual([])
  })

  it("answers a malformed path uuid with FastAPI's 422", async () => {
    const response = await rerun("not-a-uuid", user.cookie)
    expect(response.status).toBe(422)
    expect(await response.json()).toMatchObject({
      detail: [{ type: "uuid_parsing", loc: ["path", "post_id"] }],
    })
  })

  it("answers a post that does not exist with a 404", async () => {
    const response = await rerun(MISSING_ID, user.cookie)
    expect(response.status).toBe(404)
    expect(await response.json()).toEqual({ detail: "Post not found" })
    expect(start.calls).toEqual([])
  })

  it("answers another user's post with the same 404, clearing nothing", async () => {
    const post = await insertPost(other.userId, {
      ...FULL_CONTENT,
      stageStatus: ALL_COMPLETE,
    })
    const response = await rerun(post.id, user.cookie)

    expect(response.status).toBe(404)
    expect(start.calls).toEqual([])
    const row = await readPost(post.id)
    expect(row.readyContent).toBe("ready")
    expect(row.stageStatus).toEqual(ALL_COMPLETE)
  })

  it("reruns from research on a post that has run nothing", async () => {
    const post = await insertPost(user.userId, { ...FULL_CONTENT, completedAt: new Date() })
    const response = await rerun(post.id, user.cookie)

    expect(response.status).toBe(202)
    expect(await response.json()).toEqual({
      status: "queued",
      mode: "rerun",
      rerun_from: "research",
      post_id: post.id,
    })

    const row = await readPost(post.id)
    expect(row.stageStatus).toEqual(ALL_PENDING)
    expect(row.currentStage).toBe("pending")
    expect(row.completedAt).toBeNull()
    expect(row.researchContent).toBeNull()
    expect(row.imageManifest).toBeNull()
    expect(row.readyContent).toBeNull()
    // The run is a plain full pipeline: the stage to resume from is re-derived
    // from the row the handler just committed.
    expect(start.calls).toEqual([{ postId: post.id, stages: undefined }])
  })

  it("reruns from the first non-complete stage, leaving the completed ones alone", async () => {
    const post = await insertPost(user.userId, {
      ...FULL_CONTENT,
      stageStatus: { research: "complete", outline: "complete", write: "running" },
    })
    const response = await rerun(post.id, user.cookie)

    expect(await response.json()).toMatchObject({ rerun_from: "write" })

    const row = await readPost(post.id)
    expect(row.stageStatus).toEqual({
      research: "complete",
      outline: "complete",
      write: "pending",
      edit: "pending",
      images: "pending",
      ready: "pending",
    })
    expect(row.researchContent).toBe("research")
    expect(row.outlineContent).toBe("outline")
    expect(row.draftContent).toBeNull()
    expect(row.finalMdContent).toBeNull()
    expect(row.imageManifest).toBeNull()
    expect(row.readyContent).toBeNull()
  })

  it("falls back to the last stage when every stage is complete", async () => {
    // No stage is non-complete, so `rerun_from` is `STAGES[-1]`: rerun on a
    // finished post re-runs `ready` alone rather than doing nothing.
    const post = await insertPost(user.userId, {
      ...FULL_CONTENT,
      stageStatus: ALL_COMPLETE,
    })
    const response = await rerun(post.id, user.cookie)

    expect(await response.json()).toMatchObject({ rerun_from: "ready" })

    const row = await readPost(post.id)
    expect(row.stageStatus).toEqual({ ...ALL_COMPLETE, ready: "pending" })
    expect(row.readyContent).toBeNull()
    expect(row.finalMdContent).toBe("final md")
    expect(row.imageManifest).toEqual(FULL_CONTENT.imageManifest)
  })

  it("leaves final_html_content alone, since no stage owns that column", async () => {
    // `content_map` in `rerun_stage()` has six entries and none of them is
    // `final_html_content`, unlike `restart_pipeline()`, which clears it.
    const post = await insertPost(user.userId, FULL_CONTENT)
    await rerun(post.id, user.cookie)

    expect((await readPost(post.id)).finalHtmlContent).toBe("<p>final html</p>")
  })

  it("preserves stage_status keys that are not stage names", async () => {
    // `dict(post.stage_status or {})` copied the whole map and only wrote the
    // slice from `rerun_from` back.
    const post = await insertPost(user.userId, {
      stageStatus: { legacy_key: "kept", research: "complete" } as never,
    })
    await rerun(post.id, user.cookie)

    expect((await readPost(post.id)).stageStatus).toEqual({
      legacy_key: "kept",
      research: "complete",
      outline: "pending",
      write: "pending",
      edit: "pending",
      images: "pending",
      ready: "pending",
    })
  })

  it("leaves stage_settings untouched", async () => {
    const post = await insertPost(user.userId)
    await rerun(post.id, user.cookie)

    expect((await readPost(post.id)).stageSettings).toEqual(GATED_STAGE_SETTINGS)
  })

  it("publishes a real workflow.start that parks at the gated first stage", async () => {
    start.mode = "real"
    const post = await insertPost(user.userId, { stageStatus: { research: "failed" } })

    const response = await rerun(post.id, user.cookie)
    expect(response.status).toBe(202)

    const event = await waitForStart(post.id)
    expect(event.type).toBe("workflow.start")
    expect((event.data?.prevResult?.output as { stages?: unknown }).stages).toBeUndefined()
  })
})

// --- POST /api/posts/{post_id}/restart --------------------------------------

describe("POST /api/posts/{post_id}/restart", () => {
  it("rejects an unauthenticated request", async () => {
    const response = await restart(MISSING_ID)
    expect(response.status).toBe(401)
    expect(start.calls).toEqual([])
  })

  it("answers a malformed path uuid with FastAPI's 422", async () => {
    const response = await restart("not-a-uuid", user.cookie)
    expect(response.status).toBe(422)
    expect(await response.json()).toMatchObject({
      detail: [{ type: "uuid_parsing", loc: ["path", "post_id"] }],
    })
  })

  it("answers a post that does not exist with a 404", async () => {
    const response = await restart(MISSING_ID, user.cookie)
    expect(response.status).toBe(404)
    expect(await response.json()).toEqual({ detail: "Post not found" })
    expect(start.calls).toEqual([])
  })

  it("answers another user's post with the same 404, clearing nothing", async () => {
    const post = await insertPost(other.userId, {
      ...FULL_CONTENT,
      stageStatus: ALL_COMPLETE,
    })
    const response = await restart(post.id, user.cookie)

    expect(response.status).toBe(404)
    expect(start.calls).toEqual([])
    expect((await readPost(post.id)).researchContent).toBe("research")
  })

  it("clears every content column, every stage status and the logs", async () => {
    const post = await insertPost(user.userId, {
      ...FULL_CONTENT,
      stageStatus: ALL_COMPLETE,
      currentStage: "complete",
      completedAt: new Date(),
      stageLogs: { research: ["done"] },
    })
    const response = await restart(post.id, user.cookie)

    expect(response.status).toBe(202)
    expect(await response.json()).toEqual({
      status: "queued",
      mode: "restart",
      post_id: post.id,
    })

    const row = await readPost(post.id)
    expect(row.stageStatus).toEqual(ALL_PENDING)
    expect(row.currentStage).toBe("pending")
    expect(row.completedAt).toBeNull()
    expect(row.stageLogs).toEqual({})
    expect({
      researchContent: row.researchContent,
      outlineContent: row.outlineContent,
      draftContent: row.draftContent,
      finalMdContent: row.finalMdContent,
      finalHtmlContent: row.finalHtmlContent,
      imageManifest: row.imageManifest,
      readyContent: row.readyContent,
    }).toEqual({
      researchContent: null,
      outlineContent: null,
      draftContent: null,
      finalMdContent: null,
      finalHtmlContent: null,
      imageManifest: null,
      readyContent: null,
    })
    expect(start.calls).toEqual([{ postId: post.id, stages: undefined }])
  })

  it("replaces stage_status rather than updating it, dropping other keys", async () => {
    // `{s: "pending" for s in STAGES}` is a fresh dict, unlike `/rerun`'s copy,
    // so a key outside the six stage names does not survive a restart.
    const post = await insertPost(user.userId, {
      stageStatus: { legacy_key: "dropped", research: "complete" } as never,
    })
    await restart(post.id, user.cookie)

    expect((await readPost(post.id)).stageStatus).toEqual(ALL_PENDING)
  })

  it("leaves stage_settings untouched, so the configured gates still apply", async () => {
    const post = await insertPost(user.userId, { stageStatus: ALL_COMPLETE })
    await restart(post.id, user.cookie)

    expect((await readPost(post.id)).stageSettings).toEqual(GATED_STAGE_SETTINGS)
  })

  it("publishes a real workflow.start that parks at the gated first stage", async () => {
    start.mode = "real"
    const post = await insertPost(user.userId, {
      ...FULL_CONTENT,
      stageStatus: ALL_COMPLETE,
    })

    const response = await restart(post.id, user.cookie)
    expect(response.status).toBe(202)

    const event = await waitForStart(post.id)
    expect(event.type).toBe("workflow.start")
    expect((event.data?.prevResult?.output as { stages?: unknown }).stages).toBeUndefined()
  })
})

// --- POST /api/posts/{post_id}/pause ----------------------------------------

describe("POST /api/posts/{post_id}/pause", () => {
  it("rejects an unauthenticated request", async () => {
    const response = await pause(MISSING_ID)
    expect(response.status).toBe(401)
  })

  it("answers a malformed path uuid with FastAPI's 422", async () => {
    const response = await pause("not-a-uuid", user.cookie)
    expect(response.status).toBe(422)
    expect(await response.json()).toMatchObject({
      detail: [{ type: "uuid_parsing", loc: ["path", "post_id"] }],
    })
  })

  it("answers a post that does not exist with a 404", async () => {
    const response = await pause(MISSING_ID, user.cookie)
    expect(response.status).toBe(404)
    expect(await response.json()).toEqual({ detail: "Post not found" })
  })

  it("answers another user's post with the same 404, pausing nothing", async () => {
    const post = await insertPost(other.userId, { currentStage: "write" })
    const response = await pause(post.id, user.cookie)

    expect(response.status).toBe(404)
    expect((await readPost(post.id)).currentStage).toBe("write")
  })

  it("answers a post whose profile_id is null with a 404", async () => {
    // The inner join in `_get_user_post()` makes an orphan post invisible.
    const [orphan] = await db
      .insert(posts)
      .values({ slug: `${PREFIX}${randomUUID()}`, topic: "Orphan", currentStage: "write" })
      .returning()

    expect((await pause(orphan.id, user.cookie)).status).toBe(404)
    expect((await readPost(orphan.id)).currentStage).toBe("write")
  })

  it("writes current_stage = paused and answers 200", async () => {
    const post = await insertPost(user.userId, { currentStage: "write" })
    const response = await pause(post.id, user.cookie)

    expect(response.status).toBe(200)
    expect(await response.json()).toEqual({ status: "paused", post_id: post.id })
    expect((await readPost(post.id)).currentStage).toBe("paused")
  })

  it("enqueues nothing, unlike every other pipeline-control endpoint", async () => {
    const post = await insertPost(user.userId, { currentStage: "write" })
    await pause(post.id, user.cookie)

    expect(start.calls).toEqual([])
  })

  it("overwrites the stage the post was on rather than remembering it", async () => {
    // Python stored no "stage before pause", so `/api/queue/resume-all` has to
    // recover the next stage from `stage_status`. Nothing else is touched.
    const post = await insertPost(user.userId, {
      currentStage: "edit",
      stageStatus: { research: "complete", outline: "complete", write: "complete" } as never,
    })
    await pause(post.id, user.cookie)

    const row = await readPost(post.id)
    expect(row.currentStage).toBe("paused")
    expect(row.stageStatus).toEqual({
      research: "complete",
      outline: "complete",
      write: "complete",
    })
    expect(row.stageSettings).toEqual(GATED_STAGE_SETTINGS)
  })

  it("pauses a finished post too, since the endpoint filters on no stage", async () => {
    // `POST /api/queue/pause-all` restricts to `["pending", *STAGES]`; the
    // per-post endpoint has no such guard.
    const post = await insertPost(user.userId, {
      currentStage: "complete",
      stageStatus: ALL_COMPLETE,
    })
    const response = await pause(post.id, user.cookie)

    expect(response.status).toBe(200)
    expect((await readPost(post.id)).currentStage).toBe("paused")
  })

  it("is idempotent: pausing an already paused post answers 200 again", async () => {
    const post = await insertPost(user.userId, { currentStage: "paused" })

    expect((await pause(post.id, user.cookie)).status).toBe(200)
    expect((await readPost(post.id)).currentStage).toBe("paused")
  })
})

// --- POST /api/posts/{post_id}/publish --------------------------------------

describe("POST /api/posts/{post_id}/publish", () => {
  /** A post that has content and asks for WordPress: the branch this item ports. */
  function wordpressPost(userId: string, values: Partial<typeof posts.$inferInsert> = {}) {
    return insertPost(userId, {
      outputFormat: "wordpress",
      finalMdContent: "# Draft\n\nBody.",
      ...values,
    })
  }

  it("rejects an unauthenticated request", async () => {
    const response = await publish(MISSING_ID)
    expect(response.status).toBe(401)
    expect(wpStart.calls).toEqual([])
  })

  it("answers a malformed path uuid with FastAPI's 422", async () => {
    const response = await publish("not-a-uuid", user.cookie)
    expect(response.status).toBe(422)
    expect(await response.json()).toMatchObject({
      detail: [{ type: "uuid_parsing", loc: ["path", "post_id"] }],
    })
  })

  it("answers a post that does not exist with a 404", async () => {
    const response = await publish(MISSING_ID, user.cookie)
    expect(response.status).toBe(404)
    expect(await response.json()).toEqual({ detail: "Post not found" })
    expect(wpStart.calls).toEqual([])
  })

  it("answers another user's post with the same 404, starting nothing", async () => {
    const post = await wordpressPost(other.userId)
    const response = await publish(post.id, user.cookie)

    expect(response.status).toBe(404)
    expect(wpStart.calls).toEqual([])
    expect((await readPost(post.id)).wpPublishStatus).toBeNull()
  })

  it("answers a post whose profile_id is null with a 404", async () => {
    // The inner join in `_get_user_post()` makes an orphan post invisible, even
    // though a publish needs the profile it is missing.
    const [orphan] = await db
      .insert(posts)
      .values({
        slug: `${PREFIX}${randomUUID()}`,
        topic: "Orphan",
        outputFormat: "wordpress",
        finalMdContent: "# Draft",
      })
      .returning()

    expect((await publish(orphan.id, user.cookie)).status).toBe(404)
    expect(wpStart.calls).toEqual([])
  })

  it("refuses a post with neither ready_content nor final_md_content", async () => {
    const post = await wordpressPost(user.userId, { finalMdContent: null })
    const response = await publish(post.id, user.cookie)

    expect(response.status).toBe(400)
    expect(await response.json()).toEqual({ detail: "No content to publish" })
    expect(wpStart.calls).toEqual([])
    expect((await readPost(post.id)).wpPublishStatus).toBeNull()
  })

  it("treats empty content as absent, the way a falsy Python string was", async () => {
    const post = await wordpressPost(user.userId, { readyContent: "", finalMdContent: "" })
    const response = await publish(post.id, user.cookie)

    expect(response.status).toBe(400)
    expect(await response.json()).toEqual({ detail: "No content to publish" })
  })

  it("publishes a post whose only content is ready_content", async () => {
    const post = await wordpressPost(user.userId, {
      readyContent: "# Ready",
      finalMdContent: null,
    })

    expect((await publish(post.id, user.cookie)).status).toBe(202)
    expect(wpStart.calls).toEqual([{ postId: post.id, statusAtStart: "pending" }])
  })

  it("publishes a post whose ready_content is empty but has a draft to fall back on", async () => {
    const post = await wordpressPost(user.userId, { readyContent: "" })

    expect((await publish(post.id, user.cookie)).status).toBe(202)
    expect(wpStart.calls).toEqual([{ postId: post.id, statusAtStart: "pending" }])
  })

  it("checks for content before it looks at output_format", async () => {
    // Python's order: an unsupported format with nothing to publish is the
    // content 400, not the format one.
    const post = await insertPost(user.userId, { outputFormat: "both" })
    const response = await publish(post.id, user.cookie)

    expect(response.status).toBe(400)
    expect(await response.json()).toEqual({ detail: "No content to publish" })
  })

  it("writes wp_publish_status = pending and answers 202", async () => {
    const post = await wordpressPost(user.userId)
    const response = await publish(post.id, user.cookie)

    expect(response.status).toBe(202)
    expect(await response.json()).toEqual({ status: "queued", post_id: post.id })
    expect((await readPost(post.id)).wpPublishStatus).toBe("pending")
  })

  it("commits pending before it starts the run, so the worker never races the write", async () => {
    const post = await wordpressPost(user.userId)
    await publish(post.id, user.cookie)

    // Read from inside the start, not after it: `wordpressPublishStep`
    // overwrites `pending` with `publishing` as soon as it runs.
    expect(wpStart.calls).toEqual([{ postId: post.id, statusAtStart: "pending" }])
  })

  it("leaves the Next.js publish column alone", async () => {
    const post = await wordpressPost(user.userId, { nextjsPublishStatus: "published" })
    await publish(post.id, user.cookie)

    const row = await readPost(post.id)
    expect(row.wpPublishStatus).toBe("pending")
    expect(row.nextjsPublishStatus).toBe("published")
  })

  it("re-publishes a post that already failed, clearing the status back to pending", async () => {
    const post = await wordpressPost(user.userId, { wpPublishStatus: "failed" })

    expect((await publish(post.id, user.cookie)).status).toBe(202)
    expect((await readPost(post.id)).wpPublishStatus).toBe("pending")
  })

  it("starts nothing for a pipeline run: publishing is its own workflow", async () => {
    const post = await wordpressPost(user.userId)
    await publish(post.id, user.cookie)

    expect(start.calls).toEqual([])
  })

  it("answers an output_format Python had no branch for with a 400 naming it", async () => {
    const post = await wordpressPost(user.userId, { outputFormat: "markdown" })
    const response = await publish(post.id, user.cookie)

    expect(response.status).toBe(400)
    expect(await response.json()).toEqual({
      detail: "Publishing not supported for output_format 'markdown'",
    })
    expect(wpStart.calls).toEqual([])
  })

  it("renders a null output_format the way Python interpolated None", async () => {
    const post = await wordpressPost(user.userId, { outputFormat: null })
    const response = await publish(post.id, user.cookie)

    expect(await response.json()).toEqual({
      detail: "Publishing not supported for output_format 'None'",
    })
  })

  it("takes that same 400 for nextjs, which is this item's one divergence", async () => {
    // Python enqueued `publish_to_nextjs` here. The workflow behind it is
    // ledger item 5.3c-iii-b-2 and does not exist yet, so the format falls
    // through to the trailing 400 until it lands.
    const post = await wordpressPost(user.userId, { outputFormat: "nextjs" })
    const response = await publish(post.id, user.cookie)

    expect(response.status).toBe(400)
    expect(await response.json()).toEqual({
      detail: "Publishing not supported for output_format 'nextjs'",
    })
    expect((await readPost(post.id)).nextjsPublishStatus).toBeNull()
  })

  it("echoes the stored id, not the path casing, as `str(post_id)` did", async () => {
    // FastAPI parsed the path into a `uuid.UUID`, so `str(post_id)` was the
    // lowercase canonical form however the client cased it, and Postgres
    // compares the `uuid` column case-insensitively either way.
    const post = await wordpressPost(user.userId)
    const response = await publish(post.id.toUpperCase(), user.cookie)

    expect(response.status).toBe(202)
    expect(await response.json()).toEqual({ status: "queued", post_id: post.id })
    expect(wpStart.calls).toEqual([{ postId: post.id, statusAtStart: "pending" }])
  })

  it("publishes a real workflow.start for wordpress-publish", async () => {
    // The profile carries no WordPress credentials, so a worker that picks this
    // event up stops at the credentials guard: no upload, no outbound request.
    wpStart.mode = "real"
    const post = await wordpressPost(user.userId)

    expect((await publish(post.id, user.cookie)).status).toBe(202)

    const event = await waitForStart(post.id, 15_000, "wordpress-publish")
    expect(event.type).toBe("workflow.start")
    expect(event.data?.prevResult?.output).toEqual({ postId: post.id })
  })
})
