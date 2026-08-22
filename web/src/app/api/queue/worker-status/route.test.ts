// @vitest-environment node
/**
 * `GET /api/queue/worker-status` (item 5.4c-ii).
 *
 * Runs against the real database, real BetterAuth sessions and the real dev
 * Redis. The two installation-wide numbers (`worker_alive`, `queued_jobs`) are
 * asserted for shape only here: what they mean is settled by
 * `src/mastra/worker-health.test.ts`, which drives a hand-built stream and a
 * real `mastra.startWorkers()` to exact values. Repeating that here would only
 * add a second suite that a worker started by another test file could move
 * underneath.
 *
 * `active_jobs` and `last_completed` are asserted for real, because both are
 * this handler's own work: the first is a query it writes, the second a key it
 * reads.
 *
 * Requires `docker compose up -d db redis`.
 */
import { randomUUID } from "node:crypto"

import { like } from "drizzle-orm"
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest"

import { closeDb, getDb, posts, websiteProfiles } from "@/db"
import { STAGES } from "@/mastra/state"
import {
  WORKER_LAST_COMPLETED_KEY,
  closeHealthRedis,
  getHealthRedis,
  recordRunCompleted,
} from "@/mastra/worker-health"
import { apiRequest, createTestSession, deleteTestSessions, type TestSession } from "@/test/session"

import { GET } from "./route"

const PREFIX = "worker-status-test-"
const URL = "http://test/api/queue/worker-status"

/** Discard port on loopback: nothing here should ever reach a real site. */
const SITE = "http://127.0.0.1:9/site"

type WorkerStatus = {
  worker_alive: boolean
  active_jobs: number
  queued_jobs: number | null
  last_completed: string | null
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

async function createProfile(userId: string): Promise<string> {
  const [profile] = await db
    .insert(websiteProfiles)
    .values({ userId, name: "Test Blog", websiteUrl: SITE })
    .returning()
  return profile.id
}

/** `stage` is passed straight through, so `null` and unknown values are expressible. */
async function insertPost(owner: string | null, stage?: string | null) {
  await db.insert(posts).values({
    slug: `${PREFIX}${randomUUID()}`,
    topic: "A topic",
    profileId: owner,
    ...(stage === undefined ? {} : { currentStage: stage }),
  })
}

function request(cookie?: string) {
  return GET(apiRequest(URL, { cookie }))
}

async function body(cookie: string): Promise<WorkerStatus> {
  const response = await request(cookie)
  expect(response.status).toBe(200)
  return (await response.json()) as WorkerStatus
}

beforeAll(async () => {
  await clearFixtures()
  await deleteTestSessions(PREFIX)
  user = await createTestSession(PREFIX)
  other = await createTestSession(PREFIX)
  profileId = await createProfile(user.userId)
  otherProfileId = await createProfile(other.userId)
})

afterEach(clearPosts)

afterAll(async () => {
  await clearFixtures()
  await deleteTestSessions(PREFIX)
  await closeHealthRedis()
  await closeDb()
})

describe("GET /api/queue/worker-status", () => {
  it("rejects an unauthenticated request", async () => {
    const response = await request()
    expect(response.status).toBe(401)
    expect(await response.json()).toEqual({ detail: "Not authenticated" })
  })

  it("answers the four keys Python answered, and no others", async () => {
    const status = await body(user.cookie)

    expect(Object.keys(status).sort()).toEqual([
      "active_jobs",
      "last_completed",
      "queued_jobs",
      "worker_alive",
    ])
    expect(typeof status.worker_alive).toBe("boolean")
    expect(status.queued_jobs === null || typeof status.queued_jobs === "number").toBe(true)
  })

  it("counts a post on each of the six stages as active", async () => {
    for (const stage of STAGES) await insertPost(profileId, stage)

    expect((await body(user.cookie)).active_jobs).toBe(STAGES.length)
  })

  it("counts no post that is not on a stage", async () => {
    for (const stage of ["pending", "complete", "failed", "paused", "publishing", null]) {
      await insertPost(profileId, stage)
    }

    expect((await body(user.cookie)).active_jobs).toBe(0)
  })

  /**
   * The deviation from Python recorded in the handler: `active_jobs` there had
   * no user predicate, so this expectation would have read 2 for both callers.
   */
  it("counts only the caller's active posts", async () => {
    await insertPost(profileId, "write")
    await insertPost(otherProfileId, "images")

    expect((await body(user.cookie)).active_jobs).toBe(1)
    expect((await body(other.cookie)).active_jobs).toBe(1)
  })

  it("excludes an active post with no profile, which matches no user", async () => {
    await insertPost(profileId, "write")
    await insertPost(null, "write")

    expect((await body(user.cookie)).active_jobs).toBe(1)
  })

  it("reports the timestamp the worker last recorded", async () => {
    const written = await recordRunCompleted()

    expect((await body(user.cookie)).last_completed).toBe(written)
  })

  /**
   * The key is only ever written by a worker finishing a run, so a concurrent
   * run completing inside the few milliseconds between the delete and the
   * request is the one thing that could make this read non-null.
   */
  it("reports null when no run has ever finished", async () => {
    const client = getHealthRedis()
    if (!client.isOpen) await client.connect()
    await client.del(WORKER_LAST_COMPLETED_KEY)

    expect((await body(user.cookie)).last_completed).toBeNull()
  })
})
