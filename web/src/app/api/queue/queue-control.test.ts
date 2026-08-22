// @vitest-environment node
/**
 * `POST /api/queue/pause-all` and `POST /api/queue/resume-all`.
 *
 * Runs against the real database and real BetterAuth sessions, so the
 * `website_profiles.user_id` scoping and the inner join are exercised for
 * real. The one test that starts a run for real reads it back off the real
 * Redis Streams bus rather than off a spy; every other test replaces the start
 * with a recorded no-op, because `resume-all` enqueues the single-stage form
 * and a named stage skips the review gate by design, so starting one for real
 * would put a live provider call on the bus that a worker sharing this Redis
 * could consume.
 *
 * The one real start uses a post id no row has, so the first step throws out
 * of `loadPipelineState()` before it renders a prompt.
 *
 * Requires `docker compose up -d db redis`.
 */
import { randomUUID } from "node:crypto"

import { RedisStreamsPubSub } from "@mastra/redis-streams"
import { eq, like } from "drizzle-orm"
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest"

import { closeDb, getDb, posts, websiteProfiles } from "@/db"
import { STAGES } from "@/mastra/state"
import { apiRequest, createTestSession, deleteTestSessions, type TestSession } from "@/test/session"

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

const { POST: pauseAll } = await import("./pause-all/route")
const { POST: resumeAll } = await import("./resume-all/route")

const PREFIX = "queue-control-test-"
const PAUSE_URL = "http://test/api/queue/pause-all"
const RESUME_URL = "http://test/api/queue/resume-all"

/** Discard port on loopback: nothing here should ever reach a real site. */
const SITE = "http://127.0.0.1:9/site"

const ALL_COMPLETE = Object.fromEntries(STAGES.map((stage) => [stage, "complete"]))

type StartEvent = { type: string; data?: { workflowId?: string; prevResult?: { output?: unknown } } }

const db = getDb()
const observer = new RedisStreamsPubSub({ url: process.env.REDIS_URL! })
const started: StartEvent[] = []

let user: TestSession
let other: TestSession
let profileId: string
let otherProfileId: string

/** The two profiles outlive the posts: `afterEach` clears only the posts. */
async function clearPosts() {
  await db.delete(posts).where(like(posts.slug, `${PREFIX}%`))
}

async function clearFixtures() {
  await clearPosts()
  await db.delete(websiteProfiles).where(like(websiteProfiles.userId, `${PREFIX}%`))
}

async function createProfile(userId: string): Promise<string> {
  const [profile] = await db
    .insert(websiteProfiles)
    .values({ userId, name: "Test Blog", websiteUrl: SITE })
    .returning()
  return profile.id
}

/** `stage` is passed straight through, so `null` and unknown values are expressible. */
async function insertPost(
  owner: string | null,
  values: Partial<typeof posts.$inferInsert> = {},
): Promise<string> {
  const [row] = await db
    .insert(posts)
    .values({
      slug: `${PREFIX}${randomUUID()}`,
      topic: "A topic",
      profileId: owner,
      ...values,
    })
    .returning({ id: posts.id })
  return row.id
}

async function readPost(id: string) {
  const [row] = await db.select().from(posts).where(eq(posts.id, id)).limit(1)
  return row
}

function pause(cookie?: string) {
  return pauseAll(apiRequest(PAUSE_URL, { cookie, method: "POST" }))
}

function resume(cookie?: string) {
  return resumeAll(apiRequest(RESUME_URL, { cookie, method: "POST" }))
}

async function body(response: Response) {
  expect(response.status).toBe(200)
  return (await response.json()) as { status: string; count: number }
}

/** Resolves once a `workflow.start` for `pipeline` carrying `postId` arrives. */
async function waitForStart(postId: string, timeoutMs = 15_000): Promise<StartEvent> {
  const deadline = Date.now() + timeoutMs
  for (;;) {
    const match = started.find(
      (event) =>
        event.data?.workflowId === "pipeline" &&
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
  profileId = await createProfile(user.userId)
  otherProfileId = await createProfile(other.userId)
})

afterEach(async () => {
  start.mode = "skip"
  start.calls.length = 0
  started.length = 0
  await clearPosts()
})

afterAll(async () => {
  await clearFixtures()
  await deleteTestSessions(PREFIX)
  await observer.close()
  await closeDb()
})

// --- POST /api/queue/pause-all ----------------------------------------------

describe("POST /api/queue/pause-all", () => {
  it("rejects an unauthenticated request", async () => {
    const response = await pause()
    expect(response.status).toBe(401)
    expect(await response.json()).toEqual({ detail: "Not authenticated" })
  })

  it("reports zero when the caller has no posts", async () => {
    expect(await body(await pause(user.cookie))).toEqual({ status: "paused", count: 0 })
  })

  it("pauses a post sitting at 'pending'", async () => {
    const id = await insertPost(profileId, { currentStage: "pending" })
    expect(await body(await pause(user.cookie))).toEqual({ status: "paused", count: 1 })
    expect((await readPost(id)).currentStage).toBe("paused")
  })

  it("pauses a post sitting at any of the six stage names", async () => {
    const ids = await Promise.all(
      STAGES.map((stage) => insertPost(profileId, { currentStage: stage })),
    )
    expect(await body(await pause(user.cookie))).toEqual({ status: "paused", count: 6 })
    for (const id of ids) expect((await readPost(id)).currentStage).toBe("paused")
  })

  it("leaves complete, failed, already-paused and null-stage posts alone", async () => {
    const untouched: [string | null, string][] = []
    for (const stage of ["complete", "failed", "paused", "wat", null]) {
      untouched.push([stage, await insertPost(profileId, { currentStage: stage })])
    }
    expect(await body(await pause(user.cookie))).toEqual({ status: "paused", count: 0 })
    for (const [stage, id] of untouched) {
      expect((await readPost(id)).currentStage).toBe(stage)
    }
  })

  it("does not pause another user's post", async () => {
    const mine = await insertPost(profileId, { currentStage: "write" })
    const theirs = await insertPost(otherProfileId, { currentStage: "write" })
    expect(await body(await pause(user.cookie))).toEqual({ status: "paused", count: 1 })
    expect((await readPost(mine)).currentStage).toBe("paused")
    expect((await readPost(theirs)).currentStage).toBe("write")
  })

  it("does not pause a post with no profile, because the join is inner", async () => {
    const orphan = await insertPost(null, { currentStage: "write" })
    expect(await body(await pause(user.cookie))).toEqual({ status: "paused", count: 0 })
    expect((await readPost(orphan)).currentStage).toBe("write")
  })

  it("starts nothing", async () => {
    await insertPost(profileId, { currentStage: "write" })
    await pause(user.cookie)
    expect(start.calls).toEqual([])
  })
})

// --- POST /api/queue/resume-all ---------------------------------------------

describe("POST /api/queue/resume-all", () => {
  it("rejects an unauthenticated request", async () => {
    const response = await resume()
    expect(response.status).toBe(401)
    expect(await response.json()).toEqual({ detail: "Not authenticated" })
  })

  it("reports zero and starts nothing when nothing is paused", async () => {
    await insertPost(profileId, { currentStage: "write" })
    expect(await body(await resume(user.cookie))).toEqual({ status: "resumed", count: 0 })
    expect(start.calls).toEqual([])
  })

  it("recovers the next stage from stage_status, not from current_stage", async () => {
    const id = await insertPost(profileId, {
      currentStage: "paused",
      stageStatus: { research: "complete", outline: "complete", write: "running" },
    })
    expect(await body(await resume(user.cookie))).toEqual({ status: "resumed", count: 1 })
    expect((await readPost(id)).currentStage).toBe("write")
    expect(start.calls).toEqual([{ postId: id, stages: ["write"] }])
  })

  it("treats an empty stage_status as 'start from research'", async () => {
    const id = await insertPost(profileId, { currentStage: "paused", stageStatus: {} })
    expect(await body(await resume(user.cookie))).toEqual({ status: "resumed", count: 1 })
    expect((await readPost(id)).currentStage).toBe("research")
    expect(start.calls).toEqual([{ postId: id, stages: ["research"] }])
  })

  it("marks an all-complete post 'complete' and starts nothing for it", async () => {
    const id = await insertPost(profileId, {
      currentStage: "paused",
      stageStatus: ALL_COMPLETE,
    })
    // It still counts: `count` is the number of paused posts, not the number
    // of runs started.
    expect(await body(await resume(user.cookie))).toEqual({ status: "resumed", count: 1 })
    expect((await readPost(id)).currentStage).toBe("complete")
    expect(start.calls).toEqual([])
  })

  it("enqueues the single-stage form, so the resumed stage skips its review gate", async () => {
    const id = await insertPost(profileId, {
      currentStage: "paused",
      stageStatus: { research: "complete" },
      stageSettings: { outline: "review" },
    })
    await resume(user.cookie)
    expect(start.calls).toEqual([{ postId: id, stages: ["outline"] }])
  })

  it("resumes several posts in one call, each at its own next stage", async () => {
    const a = await insertPost(profileId, {
      currentStage: "paused",
      stageStatus: { research: "complete" },
    })
    const b = await insertPost(profileId, {
      currentStage: "paused",
      stageStatus: ALL_COMPLETE,
    })
    const c = await insertPost(profileId, { currentStage: "paused", stageStatus: {} })
    expect(await body(await resume(user.cookie))).toEqual({ status: "resumed", count: 3 })
    expect((await readPost(a)).currentStage).toBe("outline")
    expect((await readPost(b)).currentStage).toBe("complete")
    expect((await readPost(c)).currentStage).toBe("research")
    expect(start.calls.map((call) => call.postId).sort()).toEqual([a, c].sort())
  })

  it("does not resume another user's paused post", async () => {
    const theirs = await insertPost(otherProfileId, { currentStage: "paused", stageStatus: {} })
    expect(await body(await resume(user.cookie))).toEqual({ status: "resumed", count: 0 })
    expect((await readPost(theirs)).currentStage).toBe("paused")
    expect(start.calls).toEqual([])
  })

  it("does not resume a paused post with no profile, because the join is inner", async () => {
    const orphan = await insertPost(null, { currentStage: "paused", stageStatus: {} })
    expect(await body(await resume(user.cookie))).toEqual({ status: "resumed", count: 0 })
    expect((await readPost(orphan)).currentStage).toBe("paused")
  })

  it("puts a real single-stage workflow.start on the Redis Streams bus", async () => {
    // A post id no row has: the run crosses the bus and then throws out of
    // `loadPipelineState()` before any prompt is rendered.
    start.mode = "real"
    const missing = randomUUID()
    const { startPipeline } = await import("@/mastra/start-pipeline")
    await startPipeline(missing, ["write"])

    const event = await waitForStart(missing)
    expect(event.data?.workflowId).toBe("pipeline")
    expect(event.data?.prevResult?.output).toMatchObject({ postId: missing, stages: ["write"] })
  })
})

// --- pause-all then resume-all ----------------------------------------------

describe("pause-all followed by resume-all", () => {
  it("round-trips a running post back to the stage it was on", async () => {
    const id = await insertPost(profileId, {
      currentStage: "write",
      stageStatus: { research: "complete", outline: "complete", write: "running" },
    })

    expect(await body(await pause(user.cookie))).toEqual({ status: "paused", count: 1 })
    expect((await readPost(id)).currentStage).toBe("paused")

    expect(await body(await resume(user.cookie))).toEqual({ status: "resumed", count: 1 })
    expect((await readPost(id)).currentStage).toBe("write")
  })

  it("loses the stage a post was on when stage_status does not agree with it", async () => {
    // `pause_all()` overwrites `current_stage` and remembers nothing, so the
    // stage a resumed post lands on is whatever `stage_status` says, even when
    // the post was demonstrably further along.
    const id = await insertPost(profileId, { currentStage: "ready", stageStatus: {} })
    await pause(user.cookie)
    await resume(user.cookie)
    expect((await readPost(id)).currentStage).toBe("research")
  })
})
