// @vitest-environment node
/**
 * `GET /api/queue`.
 *
 * Runs against the real database and real BetterAuth sessions, so the
 * `website_profiles.user_id` scoping and the inner join are exercised for
 * real rather than asserted against a stub.
 *
 * Requires `docker compose up -d db`.
 */
import { randomUUID } from "node:crypto"

import { like } from "drizzle-orm"
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest"

import { closeDb, getDb, posts, websiteProfiles } from "@/db"
import { STAGES } from "@/mastra/state"
import { apiRequest, createTestSession, deleteTestSessions, type TestSession } from "@/test/session"

import { GET } from "./route"

const PREFIX = "queue-status-test-"
const URL = "http://test/api/queue"

/** Discard port on loopback: nothing here should ever reach a real site. */
const SITE = "http://127.0.0.1:9/site"

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
async function insertPost(owner: string | null, stage?: string | null) {
  await db.insert(posts).values({
    slug: `${PREFIX}${randomUUID()}`,
    topic: "A topic",
    profileId: owner,
    ...(stage === undefined ? {} : { currentStage: stage }),
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
    expect(await body(user.cookie)).toEqual({
      running: 0,
      pending: 0,
      complete: 0,
      failed: 0,
      paused: 0,
      total: 0,
    })
  })

  it("counts pending, complete, failed and paused into their own buckets", async () => {
    await insertPost(profileId, "pending")
    await insertPost(profileId, "pending")
    await insertPost(profileId, "complete")
    await insertPost(profileId, "failed")
    await insertPost(profileId, "paused")

    expect(await body(user.cookie)).toEqual({
      running: 0,
      pending: 2,
      complete: 1,
      failed: 1,
      paused: 1,
      total: 5,
    })
  })

  it("sums all six pipeline stages into running", async () => {
    for (const stage of STAGES) await insertPost(profileId, stage)

    const counts = await body(user.cookie)
    expect(counts.running).toBe(STAGES.length)
    expect(counts.total).toBe(STAGES.length)
    expect(counts.pending).toBe(0)
  })

  it("counts a post left on its stage at a review gate as running", async () => {
    await insertPost(profileId, "write")

    expect(await body(user.cookie)).toMatchObject({ running: 1, pending: 0, total: 1 })
  })

  it("uses the column default when no stage is given, so a fresh post is pending", async () => {
    await insertPost(profileId)

    expect(await body(user.cookie)).toMatchObject({ pending: 1, total: 1 })
  })

  it("counts only the caller's posts", async () => {
    await insertPost(profileId, "pending")
    await insertPost(otherProfileId, "complete")
    await insertPost(otherProfileId, "write")

    expect(await body(user.cookie)).toEqual({
      running: 0,
      pending: 1,
      complete: 0,
      failed: 0,
      paused: 0,
      total: 1,
    })
    expect(await body(other.cookie)).toEqual({
      running: 1,
      pending: 0,
      complete: 1,
      failed: 0,
      paused: 0,
      total: 1 + 1,
    })
  })

  it("excludes a post with no profile, which matches no user", async () => {
    await insertPost(profileId, "pending")
    await insertPost(null, "pending")

    expect(await body(user.cookie)).toMatchObject({ pending: 1, total: 1 })
  })

  it("counts a null stage in total and in no bucket", async () => {
    await insertPost(profileId, "pending")
    await insertPost(profileId, null)

    expect(await body(user.cookie)).toEqual({
      running: 0,
      pending: 1,
      complete: 0,
      failed: 0,
      paused: 0,
      total: 2,
    })
  })

  it("counts an unrecognised stage in total and in no bucket", async () => {
    await insertPost(profileId, "publishing")

    expect(await body(user.cookie)).toEqual({
      running: 0,
      pending: 0,
      complete: 0,
      failed: 0,
      paused: 0,
      total: 1,
    })
  })

  it("returns numbers, not the bigint strings the driver reports counts as", async () => {
    await insertPost(profileId, "pending")

    const counts = await body(user.cookie)
    for (const [key, value] of Object.entries(counts)) {
      expect(typeof value, key).toBe("number")
    }
  })
})
