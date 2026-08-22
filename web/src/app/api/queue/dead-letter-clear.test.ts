// @vitest-environment node
/**
 * Item 5.4d-iii-b: `DELETE /api/queue/dead-letter`.
 *
 * The first suite is the round trip for real: the real workflow on a real
 * evented engine over real Redis Streams fails inside `write`, the failure
 * recorder stamps `_error`, `GET` reports the entry, `DELETE` retires it, and
 * the entry is gone while the post's stage, its other log entries and the
 * engine's run row all survive. Only the two provider boundaries the run
 * reaches are stubbed.
 *
 * The second suite persists run snapshots through the same storage adapter for
 * the shapes one failure cannot produce: two failed runs on one post, an
 * already-retired post, and the two rows a clear must not touch.
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
import { listFailedRuns } from "@/mastra/dead-letter"
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

const { GET: listDeadLetter, DELETE: clearDeadLetter } = await import("./dead-letter/route")

const PREFIX = "dlq-clear-test-"
const URL = "http://test/api/queue/dead-letter"

/** Discard port on loopback: nothing here should ever reach a real site. */
const SITE = "http://127.0.0.1:9/site"

/** Text that passes `research`'s meta-response validator on the first attempt. */
const RESEARCH = [
  "## Keyword analysis",
  "primary keyword: clearing a dead run",
  "## Pain point",
  "a failed run has to be dismissable.",
  "## Competitor coverage",
  "## Search intent: informational",
].join("\n\n")

/** What the `write` agent throws, and so what the entry's `error` carries. */
const BOOM = "provider exploded while drafting"

/** A stage's own log entry, seeded to prove the `_error` pop leaves the map alone. */
const SIBLING_LOG = { started_at: "2026-01-01T00:00:00Z" }

type Entry = { post_id: string }
type PostRow = typeof posts.$inferSelect
type StageLogs = Record<string, unknown>

const db = getDb()

const pubsub = new RedisStreamsPubSub({
  url: process.env.REDIS_URL!,
  keyPrefix: "mastra:test:dead-letter-clear",
})
const storage = new PostgresStore({ id: "dead-letter-clear-test", pool: getPool() })

const testMastra = new Mastra({
  storage,
  pubsub,
  workflows: { pipeline: pipelineWorkflow, images: imagesWorkflow },
  // The failure recorder, so the failing run stamps `_error` the way it does in
  // the worker service. That key is what makes the run a dead-letter entry, and
  // so what this endpoint pops.
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

/** Suite one's owner: the post a real run fails on. */
let owner: TestSession
/** Suite two's caller, kept apart from `owner` so its counts are exact. */
let clearer: TestSession
/** The tenant whose entries a clear must leave alone. */
let bystander: TestSession
let ownerProfileId: string
let clearerProfileId: string
let bystanderProfileId: string
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
  profileId: string | null,
  values: Partial<typeof posts.$inferInsert> = {},
): Promise<string> {
  const [row] = await db
    .insert(posts)
    .values({
      slug: `${PREFIX}${randomUUID()}`,
      topic: "clearing a dead run",
      profileId,
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
  return {
    _error: { message: BOOM, attempts: 1, failed_at: new Date().toISOString() },
    research: SIBLING_LOG,
  }
}

/** Persist a failed run row for a post, for the shapes a real failure cannot reach. */
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

async function readPost(id: string): Promise<PostRow> {
  const [row] = await db.select().from(posts).where(eq(posts.id, id)).limit(1)
  return row
}

function hasError(row: PostRow): boolean {
  return "_error" in ((row.stageLogs ?? {}) as StageLogs)
}

async function listEntries(cookie: string): Promise<Entry[]> {
  const response = await listDeadLetter(apiRequest(URL, { cookie }))
  expect(response.status).toBe(200)
  const body = (await response.json()) as { entries: Entry[]; count: number }
  expect(body.count).toBe(body.entries.length)
  return body.entries
}

/** Resolves once the failure recorder has stamped `_error`, which lags `run.start()`. */
async function waitForError(postId: string, timeoutMs = 30_000): Promise<void> {
  const deadline = Date.now() + timeoutMs
  for (;;) {
    const row = await readPost(postId)
    if (row && hasError(row)) return
    if (Date.now() > deadline) throw new Error(`post ${postId} never recorded _error`)
    await new Promise((resolve) => setTimeout(resolve, 100))
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

  await deleteTestSessions(PREFIX)
  owner = await createTestSession(PREFIX)
  clearer = await createTestSession(PREFIX)
  bystander = await createTestSession(PREFIX)
  ownerProfileId = await createProfile(owner.userId)
  clearerProfileId = await createProfile(clearer.userId)
  bystanderProfileId = await createProfile(bystander.userId)

  realPostId = await insertPost(ownerProfileId)

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

describe("DELETE /api/queue/dead-letter, a real failed run", () => {
  let before: PostRow
  let listedBefore: Entry[]
  let runIdsBefore: string[]
  let response: Response
  let body: { status?: unknown; count?: unknown }

  beforeAll(async () => {
    before = await readPost(realPostId)
    listedBefore = await listEntries(owner.cookie)
    runIdsBefore = (await listFailedRuns())
      .filter((run) => run.postId === realPostId)
      .map((run) => run.runId)
    response = await clearDeadLetter(apiRequest(URL, { cookie: owner.cookie, method: "DELETE" }))
    body = (await response.json()) as typeof body
  })

  it("the run really failed inside write, and the engine said so", () => {
    expect(logged.join("\n")).toContain(BOOM)
    expect(before.currentStage).toBe("failed")
    expect((before.stageLogs as StageLogs)._error).toMatchObject({ message: BOOM })
  })

  it("the entry was listed before the clear", () => {
    expect(listedBefore.map((entry) => entry.post_id)).toContain(realPostId)
  })

  it("answers 200 with Python's cleared envelope", () => {
    expect(response.status).toBe(200)
    expect(body.status).toBe("cleared")
  })

  it("counts entries, matching what GET reported a moment earlier", () => {
    expect(body.count).toBe(listedBefore.length)
  })

  it("pops _error off the post", async () => {
    expect(hasError(await readPost(realPostId))).toBe(false)
  })

  it("leaves every other stage_logs entry alone", async () => {
    const logs = (await readPost(realPostId)).stageLogs as StageLogs
    expect(logs.research).toEqual(SIBLING_LOG)
    expect(logs.write).toEqual((before.stageLogs as StageLogs).write)
  })

  it("leaves current_stage on failed, so the queue's failed bucket is unchanged", async () => {
    expect((await readPost(realPostId)).currentStage).toBe("failed")
  })

  it("leaves stage_status alone, so a later retry still resumes", async () => {
    expect((await readPost(realPostId)).stageStatus).toEqual(before.stageStatus)
  })

  it("keeps the engine's failed run row", async () => {
    const after = (await listFailedRuns()).map((run) => run.runId)
    expect(runIdsBefore.length).toBeGreaterThan(0)
    for (const runId of runIdsBefore) expect(after).toContain(runId)
  })

  it("drops the entry out of GET", async () => {
    const entries = await listEntries(owner.cookie)
    expect(entries.map((entry) => entry.post_id)).not.toContain(realPostId)
  })

  it("is idempotent: a second clear finds nothing to clear", async () => {
    const again = await clearDeadLetter(
      apiRequest(URL, { cookie: owner.cookie, method: "DELETE" }),
    )
    expect(again.status).toBe(200)
    expect(await again.json()).toEqual({ status: "cleared", count: 0 })
  })
})

describe("DELETE /api/queue/dead-letter, scope and count", () => {
  /** One entry: one failed run, `_error` present. */
  let onePostId: string
  /** Two entries on one post: two failed runs, one `_error`. */
  let twicePostId: string
  /** A failed run whose `_error` was already retired, so not an entry. */
  let retiredPostId: string
  /** Another tenant's entry. */
  let bystanderPostId: string
  /** A failed run whose post has no profile, so it reaches no user. */
  let orphanPostId: string

  let retiredBefore: PostRow
  let response: Response
  let body: { status?: unknown; count?: unknown }

  beforeAll(async () => {
    onePostId = await insertPost(clearerProfileId, {
      currentStage: "failed",
      stageLogs: errorLog(),
    })
    twicePostId = await insertPost(clearerProfileId, {
      currentStage: "failed",
      stageLogs: errorLog(),
    })
    retiredPostId = await insertPost(clearerProfileId, {
      currentStage: "failed",
      stageLogs: { research: SIBLING_LOG },
    })
    bystanderPostId = await insertPost(bystanderProfileId, {
      currentStage: "failed",
      stageLogs: errorLog(),
    })
    orphanPostId = await insertPost(null, { currentStage: "failed", stageLogs: errorLog() })

    await persistFailedRun(onePostId)
    await persistFailedRun(twicePostId)
    await persistFailedRun(twicePostId)
    await persistFailedRun(retiredPostId)
    await persistFailedRun(bystanderPostId)
    await persistFailedRun(orphanPostId)

    retiredBefore = await readPost(retiredPostId)
    response = await clearDeadLetter(apiRequest(URL, { cookie: clearer.cookie, method: "DELETE" }))
    body = (await response.json()) as typeof body
  })

  it("counts runs, not posts: two failed runs on one post are two entries", () => {
    expect(response.status).toBe(200)
    expect(body.count).toBe(3)
  })

  it("retires every one of the caller's posts that carried _error", async () => {
    expect(hasError(await readPost(onePostId))).toBe(false)
    expect(hasError(await readPost(twicePostId))).toBe(false)
  })

  it("leaves the caller's already-retired post byte-identical", async () => {
    const after = await readPost(retiredPostId)
    expect(after.stageLogs).toEqual(retiredBefore.stageLogs)
    expect(after.updatedAt).toEqual(retiredBefore.updatedAt)
  })

  it("does not touch another tenant's entry", async () => {
    expect(hasError(await readPost(bystanderPostId))).toBe(true)
  })

  it("does not touch a post no profile owns", async () => {
    expect(hasError(await readPost(orphanPostId))).toBe(true)
  })

  it("leaves the bystander's own queue intact, and clearable by them", async () => {
    expect((await listEntries(bystander.cookie)).map((entry) => entry.post_id)).toEqual([
      bystanderPostId,
    ])
    const theirs = await clearDeadLetter(
      apiRequest(URL, { cookie: bystander.cookie, method: "DELETE" }),
    )
    expect(await theirs.json()).toEqual({ status: "cleared", count: 1 })
    expect(hasError(await readPost(bystanderPostId))).toBe(false)
  })

  it("rejects an unauthenticated clear", async () => {
    const anonymous = await clearDeadLetter(apiRequest(URL, { method: "DELETE" }))
    expect(anonymous.status).toBe(401)
    expect(hasError(await readPost(orphanPostId))).toBe(true)
  })
})
