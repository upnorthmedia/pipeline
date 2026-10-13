// @vitest-environment node
/**
 * Ledger item P2.109b: `POST /api/posts/{post_id}/approve`, the route that
 * releases a run parked at a review gate, and the row write that follows it.
 *
 * The release itself is proven end to end in `src/mastra/gate-approval.test.ts`
 * against real gated pipeline runs. What that file cannot show is the half a
 * browser touches: that the approval is scoped to the caller, that a post with
 * nothing waiting is refused rather than silently accepted, and that the row
 * the dashboard reads stops saying `review` when the approval is accepted.
 *
 * So the workflow resume is recorded here rather than executed, for the reason
 * the top of `run-control.test.ts` gives: a real resume runs the five stages
 * after the gate, and those are provider calls. Everything either side of it is
 * real: real Postgres, real BetterAuth sessions, the real ownership join and
 * the real `stage_status` write.
 *
 * Requires `docker compose up -d db redis`.
 */
import { randomUUID } from "node:crypto"

import { eq, like } from "drizzle-orm"
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest"

import { closeDb, getDb, posts, websiteProfiles } from "@/db"
import { STATUS_COMPLETE, STATUS_REVIEW, STATUS_RUNNING } from "@/mastra/state"
import { ABSENT_POST_ID } from "@/test/absent-ids"
import { apiRequest, createTestSession, deleteTestSessions, type TestSession } from "@/test/session"

import { POST as approvePost } from "./[id]/approve/route"

/**
 * The resume, recorded. `answer` is what `approveSuspendedGate` would have
 * returned: a gate when a run was parked, null when nothing was.
 */
const approval = vi.hoisted(() => ({
  answer: null as { runId: string; stage: string; mode: string } | null,
  calls: [] as string[],
}))

vi.mock("@/mastra/approve-gate", () => ({
  approvePipelineGate: async (postId: string) => {
    approval.calls.push(postId)
    return approval.answer
  },
}))

const { releaseStageFromReview } = await import("@/mastra/post-state")

const PREFIX = "posts-approve-test-"
const URL_BASE = "http://test/api/posts"

/** Discard port on loopback: nothing here should ever reach a real site. */
const SITE = "http://127.0.0.1:9/site"

const GATED_AT_RESEARCH = {
  research: STATUS_REVIEW,
  outline: "pending",
  write: "pending",
  edit: "pending",
  images: "pending",
  ready: "pending",
} as const

const db = getDb()

let user: TestSession
let other: TestSession

async function clearFixtures() {
  await db.delete(posts).where(like(posts.slug, `${PREFIX}%`))
  await db.delete(websiteProfiles).where(like(websiteProfiles.userId, `${PREFIX}%`))
}

async function insertPost(
  userId: string,
  values: Partial<typeof posts.$inferInsert> = {},
): Promise<typeof posts.$inferSelect> {
  const [profile] = await db
    .insert(websiteProfiles)
    .values({ userId, name: "Test Blog", websiteUrl: SITE })
    .returning()
  const [row] = await db
    .insert(posts)
    .values({
      slug: `${PREFIX}${randomUUID()}`,
      topic: "A topic",
      profileId: profile.id,
      currentStage: "research",
      stageStatus: GATED_AT_RESEARCH,
      ...values,
    })
    .returning()
  return row
}

async function readPost(id: string) {
  const [row] = await db.select().from(posts).where(eq(posts.id, id)).limit(1)
  return row
}

function approve(id: string, cookie?: string) {
  return approvePost(apiRequest(`${URL_BASE}/${id}/approve`, { cookie, method: "POST" }), {
    params: Promise.resolve({ id }),
  })
}

beforeAll(async () => {
  await clearFixtures()
  user = await createTestSession(`${PREFIX}${randomUUID()}`)
  other = await createTestSession(`${PREFIX}${randomUUID()}`)
}, 60_000)

afterAll(async () => {
  await clearFixtures()
  await deleteTestSessions(PREFIX)
  await closeDb()
})

beforeEach(() => {
  approval.answer = { runId: "run-1", stage: "research", mode: "review" }
  approval.calls = []
})

describe("POST /api/posts/{id}/approve", () => {
  it("releases the waiting gate and answers 202 with the stage it released", async () => {
    const post = await insertPost(user.userId)

    const response = await approve(post.id, user.cookie)

    expect(response.status).toBe(202)
    expect(await response.json()).toEqual({
      status: "approved",
      stage: "research",
      mode: "review",
      post_id: post.id,
    })
    expect(approval.calls).toEqual([post.id])
  })

  /**
   * The reason the row is written at all. The worker takes the run off the bus
   * and writes `running` itself, but that is a different process and the
   * dashboard polls in between, so an approval that left the row alone would
   * read to the reviewer as an approval that did nothing.
   */
  it("moves the row off review so the dashboard does not read stale", async () => {
    const post = await insertPost(user.userId)

    await approve(post.id, user.cookie)

    const row = await readPost(post.id)
    expect(row.stageStatus?.research).toBe(STATUS_RUNNING)
    expect(row.currentStage).toBe("research")
    // The other five entries survive the merge.
    expect(row.stageStatus?.outline).toBe("pending")
  })

  it("refuses a post that is not waiting for anything", async () => {
    const post = await insertPost(user.userId, { stageStatus: { research: STATUS_COMPLETE } })
    approval.answer = null

    const response = await approve(post.id, user.cookie)

    expect(response.status).toBe(409)
    expect(await response.json()).toEqual({
      detail: "This post is not waiting for approval.",
    })
  })

  it("does not touch the row when nothing was released", async () => {
    const post = await insertPost(user.userId)
    approval.answer = null

    await approve(post.id, user.cookie)

    expect((await readPost(post.id)).stageStatus?.research).toBe(STATUS_REVIEW)
  })

  it("answers 401 with no session", async () => {
    const post = await insertPost(user.userId)

    expect((await approve(post.id)).status).toBe(401)
    expect(approval.calls).toEqual([])
  })

  /**
   * Ownership is resolved before the resume, so another user's parked run is
   * indistinguishable from a post that does not exist and, more to the point,
   * is never released.
   */
  it("answers 404 for a post owned by another user, without resuming it", async () => {
    const post = await insertPost(other.userId)

    const response = await approve(post.id, user.cookie)

    expect(response.status).toBe(404)
    expect(await response.json()).toEqual({ detail: "Post not found" })
    expect(approval.calls).toEqual([])
  })

  it("answers 404 for a post that does not exist", async () => {
    expect((await approve(ABSENT_POST_ID, user.cookie)).status).toBe(404)
    expect(approval.calls).toEqual([])
  })

  it("answers 422 for a malformed post id", async () => {
    const response = await approve("not-a-uuid", user.cookie)

    expect(response.status).toBe(422)
    expect(approval.calls).toEqual([])
  })
})

/**
 * The conditional write behind the route, tested on its own because its
 * predicate is what stops a slow approval from undoing the worker.
 */
describe("releaseStageFromReview", () => {
  it("moves a stage that is still parked", async () => {
    const post = await insertPost(user.userId)

    expect(await releaseStageFromReview(post.id, "research")).toBe(true)
    expect((await readPost(post.id)).stageStatus?.research).toBe(STATUS_RUNNING)
  })

  /**
   * The race this exists for: the worker picked the resume up first and has
   * already finished the stage. An unconditional write would put a complete
   * stage back to `running` and the progress bar would go backwards.
   */
  it("leaves a stage the worker has already moved alone", async () => {
    const post = await insertPost(user.userId, {
      stageStatus: { ...GATED_AT_RESEARCH, research: STATUS_COMPLETE },
    })

    expect(await releaseStageFromReview(post.id, "research")).toBe(false)
    expect((await readPost(post.id)).stageStatus?.research).toBe(STATUS_COMPLETE)
  })

  it("leaves a post that has no entry for the stage alone", async () => {
    const post = await insertPost(user.userId, { stageStatus: {} })

    expect(await releaseStageFromReview(post.id, "research")).toBe(false)
    expect((await readPost(post.id)).stageStatus).toEqual({})
  })
})
