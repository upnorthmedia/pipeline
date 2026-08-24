// @vitest-environment node
/**
 * `GET /api/queue`.
 *
 * Runs against the real database and real BetterAuth sessions, so the
 * `website_profiles.user_id` scoping and the inner join are exercised for
 * real rather than asserted against a stub.
 *
 * The counts are one bucket per `RunStateKind`, so every case here is also a
 * statement about what the posts list calls the same row: both read
 * `deriveRunState()`. The pairs that used to disagree (a post sitting on a
 * stage it has not started, a post whose stage failed without the run being
 * marked failed) are the first two cases below.
 *
 * Requires `docker compose up -d db`.
 */
import { randomUUID } from "node:crypto"

import { like } from "drizzle-orm"
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest"

import { closeDb, getDb, posts, websiteProfiles } from "@/db"
import type { StageStatusMap } from "@/lib/api"
import { apiRequest, createTestSession, deleteTestSessions, type TestSession } from "@/test/session"

import { GET } from "./route"

const PREFIX = "queue-status-test-"
const URL = "http://test/api/queue"

/** Discard port on loopback: nothing here should ever reach a real site. */
const SITE = "http://127.0.0.1:9/site"

/** Every bucket empty, so a case can name only the ones it cares about. */
const ZERO = {
  not_started: 0,
  running: 0,
  in_progress: 0,
  review: 0,
  paused: 0,
  failed: 0,
  finished_with_errors: 0,
  complete: 0,
  total: 0,
}

const db = getDb()

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
async function insertPost(owner: string | null, stage?: string | null, status?: StageStatusMap) {
  await db.insert(posts).values({
    slug: `${PREFIX}${randomUUID()}`,
    topic: "A topic",
    profileId: owner,
    ...(stage === undefined ? {} : { currentStage: stage }),
    ...(status === undefined ? {} : { stageStatus: status }),
  })
}

function status(cookie?: string) {
  return GET(apiRequest(URL, { cookie }))
}

async function body(cookie: string) {
  const response = await status(cookie)
  expect(response.status).toBe(200)
  return (await response.json()) as Record<string, number>
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
  await closeDb()
})

describe("GET /api/queue", () => {
  it("rejects an unauthenticated request", async () => {
    const response = await status()
    expect(response.status).toBe(401)
    expect(await response.json()).toEqual({ detail: "Not authenticated" })
  })

  it("answers every bucket at zero when the caller has no posts", async () => {
    expect(await body(user.cookie)).toEqual(ZERO)
  })

  it("does not call a post running because its row names a stage it has not started", async () => {
    await insertPost(profileId, "research", {})
    await insertPost(profileId, "images", {})

    expect(await body(user.cookie)).toEqual({ ...ZERO, not_started: 2, total: 2 })
  })

  it("calls a post whose stage failed failed, the way the posts list names it", async () => {
    await insertPost(profileId, "research", { research: "failed" })

    expect(await body(user.cookie)).toEqual({ ...ZERO, failed: 1, total: 1 })
  })

  it("counts a post with a stage in flight as running", async () => {
    await insertPost(profileId, "write", {
      research: "complete",
      outline: "complete",
      write: "running",
    })

    expect(await body(user.cookie)).toEqual({ ...ZERO, running: 1, total: 1 })
  })

  it("counts a post parked at a review gate as review, not as running", async () => {
    await insertPost(profileId, "write", { research: "complete", outline: "review" })

    expect(await body(user.cookie)).toEqual({ ...ZERO, review: 1, total: 1 })
  })

  it("counts a run stamped complete with a failed stage as finished with errors", async () => {
    await insertPost(profileId, "complete", { images: "failed", ready: "complete" })

    expect(await body(user.cookie)).toEqual({ ...ZERO, finished_with_errors: 1, total: 1 })
  })

  it("counts a post between two stages as in progress", async () => {
    await insertPost(profileId, "outline", { research: "complete" })

    expect(await body(user.cookie)).toEqual({ ...ZERO, in_progress: 1, total: 1 })
  })

  it("counts the three row states written over a run into their own buckets", async () => {
    await insertPost(profileId, "complete", { ready: "complete" })
    await insertPost(profileId, "failed", { research: "running" })
    await insertPost(profileId, "paused", { research: "running" })

    expect(await body(user.cookie)).toEqual({
      ...ZERO,
      complete: 1,
      failed: 1,
      paused: 1,
      total: 3,
    })
  })

  it("uses the column default when no stage is given, so a fresh post has not started", async () => {
    await insertPost(profileId)

    expect(await body(user.cookie)).toEqual({ ...ZERO, not_started: 1, total: 1 })
  })

  it("counts only the caller's posts", async () => {
    await insertPost(profileId, "pending")
    await insertPost(otherProfileId, "complete", { ready: "complete" })
    await insertPost(otherProfileId, "write", { write: "running" })

    expect(await body(user.cookie)).toEqual({ ...ZERO, not_started: 1, total: 1 })
    expect(await body(other.cookie)).toEqual({ ...ZERO, complete: 1, running: 1, total: 2 })
  })

  it("excludes a post with no profile, which matches no user", async () => {
    await insertPost(profileId, "pending")
    await insertPost(null, "pending")

    expect(await body(user.cookie)).toEqual({ ...ZERO, not_started: 1, total: 1 })
  })

  it("counts a null stage as not started rather than into no bucket at all", async () => {
    await insertPost(profileId, "pending")
    await insertPost(profileId, null)

    expect(await body(user.cookie)).toEqual({ ...ZERO, not_started: 2, total: 2 })
  })

  it("counts an unrecognised stage by what its stage map says the run did", async () => {
    await insertPost(profileId, "publishing", {})
    await insertPost(profileId, "publishing", { research: "failed" })

    expect(await body(user.cookie)).toEqual({ ...ZERO, not_started: 1, failed: 1, total: 2 })
  })

  it("reports a total that is the sum of the buckets", async () => {
    await insertPost(profileId, "pending")
    await insertPost(profileId, null)
    await insertPost(profileId, "publishing", {})
    await insertPost(profileId, "write", { write: "running" })
    await insertPost(profileId, "complete", { images: "failed" })

    const counts = await body(user.cookie)
    const { total, ...buckets } = counts
    expect(Object.values(buckets).reduce((sum, value) => sum + value, 0)).toBe(total)
    expect(total).toBe(5)
  })

  it("returns numbers, not the bigint strings the driver reports counts as", async () => {
    await insertPost(profileId, "pending")

    const counts = await body(user.cookie)
    for (const [key, value] of Object.entries(counts)) {
      expect(typeof value, key).toBe("number")
    }
  })
})
