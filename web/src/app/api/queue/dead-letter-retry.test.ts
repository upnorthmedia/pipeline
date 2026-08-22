// @vitest-environment node
/**
 * Item 5.4d-iii-a: `POST /api/queue/dead-letter/{post_id}/retry`, and the
 * acknowledgement rule it rests on.
 *
 * The first suite is the round trip the endpoint exists for, end to end and for
 * real: the real workflow on a real evented engine over real Redis Streams
 * fails inside `write`, the failure recorder stamps `_error` on the post, the
 * list endpoint reports the entry, the retry resets the post, and the entry is
 * gone. Only the two provider boundaries the run reaches are stubbed.
 *
 * `startPipeline` is recorded rather than executed for every test but one,
 * because a retry starts a *full* pipeline: letting each of them run for real
 * would put a live provider call on a Redis bus a dev worker may be consuming.
 * The one real start uses a post whose `stage_status` already calls every stage
 * complete, so the run it starts has nothing to execute and reaches no
 * provider.
 *
 * Requires `docker compose up -d db redis`.
 */
import { randomUUID } from "node:crypto"

import { Mastra } from "@mastra/core"
import { PostgresStore } from "@mastra/pg"
import { RedisStreamsPubSub } from "@mastra/redis-streams"
import { eq, like } from "drizzle-orm"
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest"

import { closeDb, getDb, getPool, posts, websiteProfiles } from "@/db"
import { editAgent } from "@/mastra/agents/edit"
import { imagesAgent } from "@/mastra/agents/images"
import { outlineAgent } from "@/mastra/agents/outline"
import { readyAgent } from "@/mastra/agents/ready"
import { researchAgent } from "@/mastra/agents/research"
import { writeAgent } from "@/mastra/agents/write"
import { createWorkerEvents } from "@/mastra/failure-recorder"
import { pubsub as productionPubsub } from "@/mastra/index"
import { STAGES } from "@/mastra/state"
import { imagesWorkflow } from "@/mastra/workflows/images"
import { pipelineWorkflow } from "@/mastra/workflows/pipeline"
import { apiRequest, createTestSession, deleteTestSessions, type TestSession } from "@/test/session"

vi.mock("@/mastra/api-keys", () => ({
  PROVIDERS: ["anthropic", "perplexity", "gemini"],
  API_KEYS_SETTING_KEY: "api_keys",
  getApiKeys: async () => ({ anthropic: "stub", perplexity: "stub", gemini: "stub" }),
  requireApiKey: async () => "test-key-not-a-real-credential",
}))

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

const { POST: retry } = await import("./dead-letter/[post_id]/retry/route")
const { GET: listDeadLetter } = await import("./dead-letter/route")

const PREFIX = "dlq-retry-test-"
const LIST_URL = "http://test/api/queue/dead-letter"

/** Discard port on loopback: nothing here should ever reach a real site. */
const SITE = "http://127.0.0.1:9/site"

/** Text that passes `research`'s meta-response validator on the first attempt. */
const RESEARCH = [
  "## Keyword analysis",
  "primary keyword: retrying a dead run",
  "## Pain point",
  "a failed run has to be startable again.",
  "## Competitor coverage",
  "## Search intent: informational",
].join("\n\n")

/** What the `write` agent throws, and so what the entry's `error` carries. */
const BOOM = "provider exploded while drafting"

/** A stage's own log entry, seeded to prove the `_error` pop leaves the map alone. */
const SIBLING_LOG = { started_at: "2026-01-01T00:00:00Z" }

const ALL_COMPLETE = Object.fromEntries(STAGES.map((stage) => [stage, "complete"]))

type Entry = { post_id: string }
type PostRow = typeof posts.$inferSelect
type StageLogs = Record<string, unknown>
type StartEvent = { type: string; data?: { workflowId?: string; prevResult?: { output?: unknown } } }

const db = getDb()

const pubsub = new RedisStreamsPubSub({
  url: process.env.REDIS_URL!,
  keyPrefix: "mastra:test:dead-letter-retry",
})
const storage = new PostgresStore({ id: "dead-letter-retry-test", pool: getPool() })

const testMastra = new Mastra({
  storage,
  pubsub,
  workflows: { pipeline: pipelineWorkflow, images: imagesWorkflow },
  // The failure recorder, so the failing run stamps `_error` the way it does in
  // the worker service. That key is what makes the run a dead-letter entry.
  events: createWorkerEvents(pubsub),
  agents: {
    research: researchAgent,
    outline: outlineAgent,
    write: writeAgent,
    edit: editAgent,
    images: imagesAgent,
    ready: readyAgent,
  },
})

/**
 * The `workflow.start` events this file's one real start publishes.
 *
 * Read off `pubsub`, this file's own transport, and not off a second client on
 * the default key prefix: both `Mastra` constructors call `__registerMastra` on
 * the same `pipelineWorkflow` object and the last one wins, so `startPipeline`
 * publishes through `testMastra`. A subscription on the production prefix sees
 * nothing, which is how this was found.
 */
const started: StartEvent[] = []

let user: TestSession
let other: TestSession
let profileId: string
let otherProfileId: string
/** The post the real failing run is started for. */
let realPostId: string
/** What the engine printed while the run failed, so it is asserted on and not left on stderr. */
let logged: string[]

async function createProfile(userId: string): Promise<string> {
  const [profile] = await db
    .insert(websiteProfiles)
    .values({ userId, name: "Test Blog", websiteUrl: SITE })
    .returning()
  return profile.id
}

async function insertPost(
  owner: string | null,
  values: Partial<typeof posts.$inferInsert> = {},
): Promise<string> {
  const [row] = await db
    .insert(posts)
    .values({
      slug: `${PREFIX}${randomUUID()}`,
      topic: "retrying a dead run",
      profileId: owner,
      currentStage: "pending",
      // Explicit, for the reason `pipeline.test.ts` records: the column default
      // predates the gate removal and would park the run at the first gate.
      stageSettings: Object.fromEntries(STAGES.map((stage) => [stage, "auto"])),
      stageStatus: {},
      stageLogs: {},
      ...values,
    })
    .returning({ id: posts.id })
  return row.id
}

/** `stage_logs._error` as the failure recorder writes it, for a persisted run. */
function errorLog(): StageLogs {
  return { _error: { message: BOOM, attempts: 1, failed_at: new Date().toISOString() } }
}

/** Persist a failed run row for a post, for the branches a real failure cannot reach. */
async function persistFailedRun(postId: string): Promise<string> {
  const runId = randomUUID()
  const workflows = await storage.getStore("workflows")
  if (!workflows) throw new Error("no workflow storage")
  await workflows.persistWorkflowSnapshot({
    workflowName: pipelineWorkflow.id,
    runId,
    snapshot: {
      runId,
      status: "failed",
      error: { name: "Error", message: BOOM },
      value: {},
      context: {
        __state: {},
        input: { postId },
        write: { status: "failed", error: { name: "Error", message: BOOM } },
      },
      serializedStepGraph: [],
      activePaths: [],
      activeStepsPath: {},
      suspendedPaths: {},
      resumeLabels: {},
      waitingPaths: {},
      timestamp: Date.now(),
    } as never,
  })
  return runId
}

function retryRequest(postId: string, cookie?: string): Promise<Response> {
  return retry(
    apiRequest(`http://test/api/queue/dead-letter/${postId}/retry`, { cookie, method: "POST" }),
    { params: Promise.resolve({ post_id: postId }) },
  )
}

async function readPost(id: string): Promise<PostRow> {
  const [row] = await db.select().from(posts).where(eq(posts.id, id)).limit(1)
  return row
}

async function entriesFor(cookie: string, postId: string): Promise<Entry[]> {
  const response = await listDeadLetter(apiRequest(LIST_URL, { cookie }))
  expect(response.status).toBe(200)
  const body = (await response.json()) as { entries: Entry[] }
  return body.entries.filter((entry) => entry.post_id === postId)
}

/** Resolves once the failure recorder has stamped `_error`, which lags `run.start()`. */
async function waitForError(postId: string, timeoutMs = 30_000): Promise<void> {
  const deadline = Date.now() + timeoutMs
  for (;;) {
    const row = await readPost(postId)
    if (row?.stageLogs && "_error" in (row.stageLogs as StageLogs)) return
    if (Date.now() > deadline) throw new Error(`post ${postId} never recorded _error`)
    await new Promise((resolve) => setTimeout(resolve, 100))
  }
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
    if (Date.now() > deadline) throw new Error(`no workflow.start for ${postId} within ${timeoutMs}ms`)
    await new Promise((resolve) => setTimeout(resolve, 25))
  }
}

beforeAll(async () => {
  logged = []
  vi.spyOn(console, "error").mockImplementation((...args: unknown[]) => {
    logged.push(args.map(String).join(" "))
  })
  vi.spyOn(researchAgent, "generate").mockImplementation((async () => ({
    text: RESEARCH,
    response: { modelId: "stub-research" },
    usage: { inputTokens: 100, outputTokens: 20 },
  })) as never)
  vi.spyOn(outlineAgent, "generate").mockImplementation((async () => ({
    text: "# Outline\n\n1. Opening\n2. Body\n3. Close",
    response: { modelId: "stub-outline" },
    usage: { inputTokens: 100, outputTokens: 20 },
  })) as never)
  vi.spyOn(writeAgent, "generate").mockImplementation((async () => {
    throw new Error(BOOM)
  }) as never)

  // No `group`, so this subscription is its own fan-out consumer group and can
  // never take an event away from a worker.
  await pubsub.subscribe("workflows", (event: unknown) => {
    started.push(event as StartEvent)
  })

  await deleteTestSessions(PREFIX)
  user = await createTestSession(PREFIX)
  other = await createTestSession(PREFIX)
  profileId = await createProfile(user.userId)
  otherProfileId = await createProfile(other.userId)

  realPostId = await insertPost(profileId)

  await storage.init()
  await testMastra.startWorkers()
  const run = await pipelineWorkflow.createRun()
  const result = await run.start({ inputData: { postId: realPostId } })
  expect(result.status).toBe("failed")
  await waitForError(realPostId)

  // A stage's own entry alongside `_error`, so the pop can be shown to remove
  // one key rather than the map.
  await db
    .update(posts)
    .set({ stageLogs: { ...(await readPost(realPostId)).stageLogs, research: SIBLING_LOG } })
    .where(eq(posts.id, realPostId))
}, 180_000)

afterAll(async () => {
  await testMastra.stopWorkers()
  await pubsub.close()
  // Importing `index.ts` (through the route handler) constructs the production
  // transport; close it so the suite leaves no Redis client open.
  await productionPubsub.close()
  await db.delete(posts).where(like(posts.slug, `${PREFIX}%`))
  await db.delete(websiteProfiles).where(like(websiteProfiles.userId, `${PREFIX}%`))
  await deleteTestSessions(PREFIX)
  await closeDb()
  vi.restoreAllMocks()
})

describe("POST /api/queue/dead-letter/{post_id}/retry, a real failed run", () => {
  let before: PostRow
  let listedBefore: Entry[]
  let response: Response
  let body: unknown

  beforeAll(async () => {
    before = await readPost(realPostId)
    listedBefore = await entriesFor(user.cookie, realPostId)
    start.calls.length = 0
    response = await retryRequest(realPostId, user.cookie)
    body = await response.json()
  })

  it("the run really failed and really reached the dead-letter list", () => {
    expect(before.currentStage).toBe("failed")
    expect(listedBefore).toHaveLength(1)
    expect(logged.some((line) => line.includes(BOOM))).toBe(true)
  })

  it("answers 202 with Python's body", () => {
    expect(response.status).toBe(202)
    expect(body).toEqual({ status: "retrying", post_id: realPostId })
  })

  it("resets current_stage to 'pending'", async () => {
    expect((await readPost(realPostId)).currentStage).toBe("pending")
  })

  it("pops _error out of stage_logs, as Python's logs.pop('_error') did", async () => {
    expect((await readPost(realPostId)).stageLogs).not.toHaveProperty("_error")
  })

  it("removes only that key, leaving the rest of stage_logs as it found it", async () => {
    expect((await readPost(realPostId)).stageLogs).toHaveProperty("research", SIBLING_LOG)
  })

  it("leaves stage_status alone, so the retried run resumes rather than restarts", async () => {
    expect((await readPost(realPostId)).stageStatus).toEqual(before.stageStatus)
    expect((before.stageStatus as Record<string, string>).research).toBe("complete")
  })

  it("leaves the stages that did complete in their columns", async () => {
    const after = await readPost(realPostId)
    expect(after.researchContent).toBe(before.researchContent)
    expect(after.outlineContent).toBe(before.outlineContent)
  })

  it("starts a full pipeline, which is what an unnamed stage meant to ARQ", () => {
    expect(start.calls).toEqual([{ postId: realPostId, stages: undefined }])
  })

  it("drops the post out of the dead-letter list", async () => {
    expect(await entriesFor(user.cookie, realPostId)).toHaveLength(0)
  })

  it("answers 404 the second time, because the entry is gone", async () => {
    start.calls.length = 0
    const second = await retryRequest(realPostId, user.cookie)
    expect(second.status).toBe(404)
    expect(await second.json()).toEqual({ detail: "Post not found in dead letter queue" })
    expect(start.calls).toEqual([])
  })
})

describe("POST /api/queue/dead-letter/{post_id}/retry, requests that cannot retry", () => {
  it("rejects a request with no session", async () => {
    const response = await retryRequest(randomUUID())
    expect(response.status).toBe(401)
    expect(await response.json()).toEqual({ detail: "Not authenticated" })
  })

  it("answers 422 for an id that is not a UUID, where Python reached the database", async () => {
    const response = await retryRequest("not-a-uuid", user.cookie)
    expect(response.status).toBe(422)
    const body = (await response.json()) as { detail: { type: string; loc: string[] }[] }
    expect(body.detail[0].type).toBe("uuid_parsing")
    expect(body.detail[0].loc).toEqual(["path", "post_id"])
  })

  it("answers 404 for a post that does not exist", async () => {
    start.calls.length = 0
    const response = await retryRequest(randomUUID(), user.cookie)
    expect(response.status).toBe(404)
    expect(await response.json()).toEqual({ detail: "Post not found" })
    expect(start.calls).toEqual([])
  })

  it("answers 404 for another user's dead-letter entry, which Python retried", async () => {
    const theirs = await insertPost(otherProfileId, {
      currentStage: "failed",
      stageLogs: errorLog(),
    })
    await persistFailedRun(theirs)
    start.calls.length = 0

    const response = await retryRequest(theirs, user.cookie)
    expect(response.status).toBe(404)
    expect(await response.json()).toEqual({ detail: "Post not found" })
    expect((await readPost(theirs)).currentStage).toBe("failed")
    expect((await readPost(theirs)).stageLogs).toHaveProperty("_error")
    expect(start.calls).toEqual([])
  })

  it("answers 404 for an owned post with no failed run", async () => {
    const id = await insertPost(profileId, { currentStage: "failed", stageLogs: errorLog() })
    start.calls.length = 0

    const response = await retryRequest(id, user.cookie)
    expect(response.status).toBe(404)
    expect(await response.json()).toEqual({ detail: "Post not found in dead letter queue" })
    expect((await readPost(id)).stageLogs).toHaveProperty("_error")
    expect(start.calls).toEqual([])
  })

  it("answers 404 for a failed run whose _error was already popped", async () => {
    const id = await insertPost(profileId, { currentStage: "failed", stageLogs: {} })
    await persistFailedRun(id)
    start.calls.length = 0

    const response = await retryRequest(id, user.cookie)
    expect(response.status).toBe(404)
    expect(await response.json()).toEqual({ detail: "Post not found in dead letter queue" })
    expect(start.calls).toEqual([])
  })

  it("answers 404 for a dead-letter entry whose post has no profile, so no owner", async () => {
    const orphan = await insertPost(null, { currentStage: "failed", stageLogs: errorLog() })
    await persistFailedRun(orphan)

    const response = await retryRequest(orphan, user.cookie)
    expect(response.status).toBe(404)
    expect(await response.json()).toEqual({ detail: "Post not found" })
  })
})

describe("POST /api/queue/dead-letter/{post_id}/retry, the run it starts", () => {
  it("publishes workflow.start for the post with no stages named", async () => {
    // Every stage already complete, so the run this starts executes nothing and
    // reaches no provider even if a worker elsewhere consumes it.
    const id = await insertPost(profileId, {
      currentStage: "failed",
      stageStatus: { ...ALL_COMPLETE },
      stageLogs: errorLog(),
    })
    await persistFailedRun(id)

    start.mode = "real"
    try {
      expect((await retryRequest(id, user.cookie)).status).toBe(202)
      const event = await waitForStart(id)
      expect((event.data?.prevResult?.output as { stages?: unknown }).stages).toBeUndefined()
    } finally {
      start.mode = "skip"
    }
  }, 30_000)
})
