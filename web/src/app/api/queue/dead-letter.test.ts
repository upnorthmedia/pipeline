// @vitest-environment node
/**
 * Item 5.4d-ii: `GET /api/queue/dead-letter`.
 *
 * The first suite is a real failed run: the real workflow on a real evented
 * engine over real Redis Streams, writing a real snapshot into the real
 * database, with the two provider boundaries it reaches stubbed (`research`
 * returns text, `write` throws). That is the only way to prove the snapshot
 * parsing in `src/mastra/dead-letter.ts` matches what the engine actually
 * writes rather than what this test thinks it writes.
 *
 * The second suite persists snapshots through the same storage adapter to reach
 * the branches one failing run cannot produce: another user's post, a post that
 * has since been deleted, a run with no post id, a run whose post id is not a
 * UUID, the string form of the snapshot column, a failure inside the nested
 * `images` workflow, and the ordering across several entries.
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
import { pubsub as productionPubsub, workerEvents } from "@/mastra/index"
import { imagesWorkflow } from "@/mastra/workflows/images"
import { pipelineWorkflow } from "@/mastra/workflows/pipeline"
import { apiRequest, createTestSession, deleteTestSessions, type TestSession } from "@/test/session"

import { GET } from "./dead-letter/route"

vi.mock("@/mastra/api-keys", () => ({
  PROVIDERS: ["anthropic", "perplexity", "gemini"],
  API_KEYS_SETTING_KEY: "api_keys",
  getApiKeys: async () => ({ anthropic: "stub", perplexity: "stub", gemini: "stub" }),
  requireApiKey: async () => "test-key-not-a-real-credential",
}))

const PREFIX = "dlq-list-test-"
const URL = "http://test/api/queue/dead-letter"

/** Discard port on loopback: nothing here should ever reach a real site. */
const SITE = "http://127.0.0.1:9/site"

/** Text that passes `research`'s meta-response validator on the first attempt. */
const RESEARCH = [
  "## Keyword analysis",
  "primary keyword: dead letter listing",
  "## Pain point",
  "a failed run has to be findable after the fact.",
  "## Competitor coverage",
  "## Search intent: informational",
].join("\n\n")

/** What the `write` agent throws, and so what the entry's `error` must carry. */
const BOOM = "provider exploded while drafting"

type Entry = {
  post_id: string
  stage: string | null
  error: string
  attempts: number
  failed_at: string
}

const db = getDb()

const pubsub = new RedisStreamsPubSub({
  url: process.env.REDIS_URL!,
  keyPrefix: "mastra:test:dead-letter",
})
const storage = new PostgresStore({ id: "dead-letter-test", pool: getPool() })

const testMastra = new Mastra({
  storage,
  pubsub,
  workflows: { pipeline: pipelineWorkflow, images: imagesWorkflow },
  // The failure recorder, so the real failing run stamps `_error` on its post
  // exactly as it does in the worker service. Item 5.4d-iii made that key the
  // acknowledgement that keeps an entry in the queue, so a suite that skipped
  // it would be listing runs the production handler would not.
  events: workerEvents,
  agents: {
    research: researchAgent,
    outline: outlineAgent,
    write: writeAgent,
    edit: editAgent,
    images: imagesAgent,
    ready: readyAgent,
  },
})

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

/**
 * A post carrying an unacknowledged failure.
 *
 * `stage_logs._error` is seeded here because these fixtures back *persisted*
 * run rows rather than real runs, so no failure recorder ever ran for them.
 * `listDeadLetterEntries` requires the key, so without it the run row exists
 * and the entry does not. The real failing run in the first suite gets its
 * `_error` from the recorder, not from here.
 */
async function insertPost(owner: string | null, failed = true): Promise<string> {
  const [row] = await db
    .insert(posts)
    .values({
      slug: `${PREFIX}${randomUUID()}`,
      topic: "listing a dead run",
      profileId: owner,
      currentStage: "pending",
      // Explicit, for the reason `pipeline.test.ts` records: the column default
      // predates the gate removal and would park the run at the first gate.
      stageSettings: {
        research: "auto",
        outline: "auto",
        write: "auto",
        edit: "auto",
        images: "auto",
        ready: "auto",
      },
      stageStatus: {},
      stageLogs: failed
        ? { _error: { message: BOOM, attempts: 1, failed_at: new Date().toISOString() } }
        : {},
    })
    .returning({ id: posts.id })
  return row.id
}

/**
 * A snapshot in the shape the engine writes one, verified against the real run
 * in the first suite. `context.input.postId` is the run's input, each step's
 * own entry carries its status, and the top-level `error` is the failure.
 */
function snapshotFor(options: {
  postId?: unknown
  failedStage?: string | null
  status?: string
  error?: unknown
}) {
  const context: Record<string, unknown> = {
    __state: {},
    ...(options.postId === undefined ? {} : { input: { postId: options.postId } }),
    research: { status: "success", output: { stage: "research" } },
  }
  if (options.failedStage) {
    context[options.failedStage] = { status: "failed", error: { name: "Error", message: BOOM } }
  }
  return {
    runId: "",
    status: options.status ?? "failed",
    error: options.error ?? { name: "Error", message: BOOM },
    value: {},
    context,
    serializedStepGraph: [],
    activePaths: [],
    activeStepsPath: {},
    suspendedPaths: {},
    resumeLabels: {},
    waitingPaths: {},
    timestamp: Date.now(),
  }
}

/** Persist a run row directly, for the branches a real failure cannot produce. */
async function persistRun(options: Parameters<typeof snapshotFor>[0] & {
  workflowName?: string
  createdAt?: Date
}): Promise<string> {
  const runId = randomUUID()
  const snapshot = { ...snapshotFor(options), runId }
  const workflows = await storage.getStore("workflows")
  if (!workflows) throw new Error("no workflow storage")
  await workflows.persistWorkflowSnapshot({
    workflowName: options.workflowName ?? pipelineWorkflow.id,
    runId,
    snapshot: snapshot as never,
    createdAt: options.createdAt,
    updatedAt: options.createdAt,
  })
  return runId
}

async function listEntries(cookie: string): Promise<{ entries: Entry[]; count: number }> {
  const response = await GET(apiRequest(URL, { cookie }))
  expect(response.status).toBe(200)
  return (await response.json()) as { entries: Entry[]; count: number }
}

/** Resolves once the failure recorder has stamped `_error`, which lags `run.start()`. */
async function waitForError(postId: string, timeoutMs = 30_000): Promise<void> {
  const deadline = Date.now() + timeoutMs
  for (;;) {
    const [row] = await db.select({ logs: posts.stageLogs }).from(posts).where(eq(posts.id, postId))
    if (row?.logs && "_error" in row.logs) return
    if (Date.now() > deadline) throw new Error(`post ${postId} never recorded _error`)
    await new Promise((resolve) => setTimeout(resolve, 100))
  }
}

/** Only the fixtures this file owns; the shared database holds other failures. */
function forPost(entries: Entry[], postId: string): Entry[] {
  return entries.filter((entry) => entry.post_id === postId)
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

describe("GET /api/queue/dead-letter, a real failed run", () => {
  it("reports the run", async () => {
    const { entries } = await listEntries(user.cookie)
    expect(forPost(entries, realPostId)).toHaveLength(1)
  })

  it("names the step that threw, which Python left empty for a full pipeline", async () => {
    const { entries } = await listEntries(user.cookie)
    expect(forPost(entries, realPostId)[0].stage).toBe("write")
  })

  it("carries the failing stage's error text, Python's str(e)", async () => {
    const { entries } = await listEntries(user.cookie)
    expect(forPost(entries, realPostId)[0].error).toBe(BOOM)
  })

  it("reports how many times the run executed, Python's attempts", async () => {
    const { entries } = await listEntries(user.cookie)
    // `pipelineWorkflow.retryConfig` is `{attempts: 0}`, so the failing step ran once.
    expect(forPost(entries, realPostId)[0].attempts).toBe(1)
  })

  it("reports failed_at as a timestamp close to the run", async () => {
    const { entries } = await listEntries(user.cookie)
    const failedAt = Date.parse(forPost(entries, realPostId)[0].failed_at)
    expect(Number.isNaN(failedAt)).toBe(false)
    expect(Math.abs(Date.now() - failedAt)).toBeLessThan(300_000)
  })

  it("carries exactly the five keys Python's DLQ entry had", async () => {
    const { entries } = await listEntries(user.cookie)
    expect(Object.keys(forPost(entries, realPostId)[0]).sort()).toEqual([
      "attempts",
      "error",
      "failed_at",
      "post_id",
      "stage",
    ])
  })

  it("counts the entries it returned", async () => {
    const { entries, count } = await listEntries(user.cookie)
    expect(count).toBe(entries.length)
  })

  it("reports the failing step and its error", () => {
    expect(
      logged.some((line) => line.includes("Error executing step write") && line.includes(BOOM)),
    ).toBe(true)
  })
})

describe("GET /api/queue/dead-letter, run rows the caller must not see", () => {
  it("rejects a request with no session", async () => {
    const response = await GET(apiRequest(URL))
    expect(response.status).toBe(401)
  })

  it("excludes another user's failed run, which Python showed to everyone", async () => {
    const theirs = await insertPost(otherProfileId)
    await persistRun({ postId: theirs, failedStage: "edit" })

    expect(forPost((await listEntries(user.cookie)).entries, theirs)).toHaveLength(0)
    expect(forPost((await listEntries(other.cookie)).entries, theirs)).toHaveLength(1)
  })

  it("excludes a run whose post has been deleted", async () => {
    const gone = await insertPost(profileId)
    await persistRun({ postId: gone, failedStage: "edit" })
    await db.delete(posts).where(eq(posts.id, gone))

    expect(forPost((await listEntries(user.cookie)).entries, gone)).toHaveLength(0)
  })

  it("excludes a run whose post has no profile, so no owner", async () => {
    const orphan = await insertPost(null)
    await persistRun({ postId: orphan, failedStage: "edit" })

    expect(forPost((await listEntries(user.cookie)).entries, orphan)).toHaveLength(0)
  })

  it("excludes a run whose post no longer carries _error, the retired entry", async () => {
    const acknowledged = await insertPost(profileId, false)
    await persistRun({ postId: acknowledged, failedStage: "write" })

    expect(forPost((await listEntries(user.cookie)).entries, acknowledged)).toHaveLength(0)
  })

  it("excludes a run whose input carries no post id", async () => {
    const before = (await listEntries(user.cookie)).count
    await persistRun({ failedStage: "edit" })
    expect((await listEntries(user.cookie)).count).toBe(before)
  })

  it("survives a run whose post id is not a UUID rather than failing the query", async () => {
    const before = (await listEntries(user.cookie)).count
    await persistRun({ postId: "not-a-uuid", failedStage: "edit" })
    expect((await listEntries(user.cookie)).count).toBe(before)
  })

  it("excludes a failed run of a workflow that is not the pipeline", async () => {
    const post = await insertPost(profileId)
    await persistRun({ postId: post, failedStage: "edit", workflowName: "sitemapCrawl" })

    expect(forPost((await listEntries(user.cookie)).entries, post)).toHaveLength(0)
  })

  it("excludes a pipeline run that did not fail", async () => {
    const post = await insertPost(profileId)
    await persistRun({ postId: post, status: "success", error: null })

    expect(forPost((await listEntries(user.cookie)).entries, post)).toHaveLength(0)
  })
})

describe("GET /api/queue/dead-letter, entry contents", () => {
  it("reports the nested images workflow's id when image generation dies", async () => {
    const post = await insertPost(profileId)
    await persistRun({ postId: post, failedStage: "images" })

    expect(forPost((await listEntries(user.cookie)).entries, post)[0].stage).toBe("images")
  })

  it("reports a null stage when no step recorded a failure", async () => {
    const post = await insertPost(profileId)
    await persistRun({ postId: post, failedStage: null })

    expect(forPost((await listEntries(user.cookie)).entries, post)[0].stage).toBeNull()
  })

  it("reports a thrown non-Error, which the engine passes through as it was", async () => {
    const post = await insertPost(profileId)
    await persistRun({ postId: post, failedStage: "edit", error: "raw string failure" })

    expect(forPost((await listEntries(user.cookie)).entries, post)[0].error).toBe(
      "raw string failure",
    )
  })

  it("orders entries newest first, as LPUSH plus LRANGE did", async () => {
    const older = await insertPost(profileId)
    const newer = await insertPost(profileId)
    await persistRun({ postId: older, failedStage: "edit", createdAt: new Date(Date.now() - 60_000) })
    await persistRun({ postId: newer, failedStage: "edit", createdAt: new Date() })

    const ids = (await listEntries(user.cookie)).entries.map((entry) => entry.post_id)
    expect(ids.indexOf(newer)).toBeLessThan(ids.indexOf(older))
  })
})
