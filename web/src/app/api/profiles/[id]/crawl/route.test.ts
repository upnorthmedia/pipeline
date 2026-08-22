// @vitest-environment node
/**
 * `POST /api/profiles/{profile_id}/crawl` and the auto-enqueue that
 * `POST /api/profiles` performs, which are the two callers of ARQ's
 * `enqueue_job("crawl_profile_sitemap", ...)`.
 *
 * The handlers run against the real database with a real BetterAuth session,
 * and the enqueue goes onto the real Redis Streams bus. A second, independent
 * `RedisStreamsPubSub` subscribes to the `workflows` topic and reads the
 * `workflow.start` event back, so "the crawl was enqueued" is asserted from the
 * transport rather than from a spy. No worker is started here, so nothing
 * executes the run: this file is about the handoff, and the crawl itself is
 * covered end to end by `src/mastra/workflows/sitemap-crawl.test.ts`.
 *
 * Requires `docker compose up -d db redis`.
 */
import { RedisStreamsPubSub } from "@mastra/redis-streams"
import { eq, like } from "drizzle-orm"
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest"

import { closeDb, getDb, websiteProfiles } from "@/db"
import { logger } from "@/mastra"
import { apiRequest, createTestSession, deleteTestSessions, type TestSession } from "@/test/session"

import { POST as createProfile } from "../../route"
import { POST as crawlProfile } from "./route"

/**
 * The one branch that cannot be driven from a real boundary: Python's
 * `except Exception as e` around `enqueue_job`. Everything else in this file
 * calls the real implementation; the wrapper only diverts when a test asks it
 * to, so the success path is never mocked.
 */
const fault = vi.hoisted(() => ({ message: null as string | null }))

vi.mock("@/mastra/start-crawl", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/mastra/start-crawl")>()
  return {
    startSitemapCrawl: async (profileId: string) => {
      if (fault.message !== null) throw new Error(fault.message)
      return actual.startSitemapCrawl(profileId)
    },
  }
})

const PREFIX = "profiles-crawl-test-"
const URL = "http://test/api/profiles"

/** Discard port on loopback: a stray crawl of this refuses instantly and reaches nobody. */
const SITE = "http://127.0.0.1:9/site"

type StartEvent = { type: string; data?: { workflowId?: string; prevResult?: { output?: unknown } } }

const db = getDb()
const observer = new RedisStreamsPubSub({ url: process.env.REDIS_URL! })
const started: StartEvent[] = []

let user: TestSession
let other: TestSession

async function clearProfiles() {
  await db.delete(websiteProfiles).where(like(websiteProfiles.userId, `${PREFIX}%`))
}

async function insertProfile(userId: string, values: Partial<typeof websiteProfiles.$inferInsert> = {}) {
  const [row] = await db
    .insert(websiteProfiles)
    .values({ userId, name: "Crawl Me", websiteUrl: SITE, ...values })
    .returning({ id: websiteProfiles.id })
  return row.id
}

function crawl(id: string, cookie?: string) {
  return crawlProfile(apiRequest(`${URL}/${id}/crawl`, { method: "POST", cookie }), {
    params: Promise.resolve({ id }),
  })
}

async function readStatus(id: string) {
  const [row] = await db
    .select({ crawlStatus: websiteProfiles.crawlStatus, updatedAt: websiteProfiles.updatedAt })
    .from(websiteProfiles)
    .where(eq(websiteProfiles.id, id))
    .limit(1)
  return row
}

/** Resolves once a `workflow.start` for `sitemap-crawl` carrying `profileId` arrives. */
async function waitForStart(profileId: string, timeoutMs = 15_000): Promise<StartEvent> {
  const deadline = Date.now() + timeoutMs
  for (;;) {
    const match = started.find(
      (event) =>
        event.data?.workflowId === "sitemap-crawl" &&
        (event.data?.prevResult?.output as { profileId?: string } | undefined)?.profileId ===
          profileId,
    )
    if (match) return match
    if (Date.now() > deadline) {
      throw new Error(`no workflow.start for ${profileId} within ${timeoutMs}ms`)
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
  await clearProfiles()
  await deleteTestSessions(PREFIX)
  user = await createTestSession(PREFIX)
  other = await createTestSession(PREFIX)
})

afterEach(async () => {
  fault.message = null
  started.length = 0
  await clearProfiles()
})

afterAll(async () => {
  await clearProfiles()
  await deleteTestSessions(PREFIX)
  await observer.close()
  await closeDb()
})

describe("POST /api/profiles/{id}/crawl", () => {
  it("401s without a session", async () => {
    const id = await insertProfile(user.userId)

    const response = await crawl(id)

    expect(response.status).toBe(401)
    expect(await response.json()).toEqual({ detail: "Not authenticated" })
    expect((await readStatus(id)).crawlStatus).toBe("pending")
  })

  it("422s on a malformed profile id, the way the uuid path parameter did", async () => {
    const response = await crawl("not-a-uuid", user.cookie)

    expect(response.status).toBe(422)
    expect((await response.json()).detail[0]).toMatchObject({
      type: "uuid_parsing",
      loc: ["path", "profile_id"],
      input: "not-a-uuid",
    })
  })

  it("404s for a profile that does not exist", async () => {
    const response = await crawl("00000000-0000-4000-8000-000000000000", user.cookie)

    expect(response.status).toBe(404)
    expect(await response.json()).toEqual({ detail: "Profile not found" })
  })

  it("404s for another user's profile and leaves its status alone", async () => {
    const id = await insertProfile(other.userId, { crawlStatus: "complete" })

    const response = await crawl(id, user.cookie)

    expect(response.status).toBe(404)
    expect((await readStatus(id)).crawlStatus).toBe("complete")
  })

  it("answers 202 with the Python body and flips the row to crawling", async () => {
    const id = await insertProfile(user.userId)

    const response = await crawl(id, user.cookie)

    expect(response.status).toBe(202)
    expect(await response.json()).toEqual({ status: "crawling", profile_id: id })
    expect((await readStatus(id)).crawlStatus).toBe("crawling")
  })

  it("publishes a sitemap-crawl workflow.start carrying the profile id", async () => {
    const id = await insertProfile(user.userId)

    expect((await crawl(id, user.cookie)).status).toBe(202)

    const event = await waitForStart(id)
    expect(event.type).toBe("workflow.start")
  })

  it("re-crawls a profile that already completed", async () => {
    const id = await insertProfile(user.userId, {
      crawlStatus: "complete",
      lastCrawledAt: new Date("2025-01-01T00:00:00Z"),
    })

    expect((await crawl(id, user.cookie)).status).toBe(202)

    expect((await readStatus(id)).crawlStatus).toBe("crawling")
    await waitForStart(id)
  })

  it("rolls the status to failed and 500s when the enqueue raises", async () => {
    const id = await insertProfile(user.userId)
    fault.message = "redis is unreachable"

    const response = await crawl(id, user.cookie)

    expect(response.status).toBe(500)
    expect(await response.json()).toEqual({
      detail: "Failed to enqueue crawl: redis is unreachable",
    })
    expect((await readStatus(id)).crawlStatus).toBe("failed")
  })

  it("bumps updated_at, as the ORM commit did", async () => {
    const past = new Date("2020-01-01T00:00:00Z")
    const id = await insertProfile(user.userId, { updatedAt: past })

    await crawl(id, user.cookie)

    expect((await readStatus(id)).updatedAt!.getTime()).toBeGreaterThan(past.getTime())
  })
})

describe("POST /api/profiles auto-enqueue", () => {
  it("starts a crawl for the profile it just created", async () => {
    const response = await createProfile(
      apiRequest(URL, {
        method: "POST",
        cookie: user.cookie,
        body: JSON.stringify({ name: "Fresh", website_url: SITE }),
      }),
    )

    expect(response.status).toBe(201)
    const body = await response.json()
    await waitForStart(body.id)
  })

  it("still returns the 201 when the enqueue raises, and logs why", async () => {
    fault.message = "redis is unreachable"
    // Captured rather than allowed to print: the warning is the assertion, and
    // an unhandled one would be new noise in the suite's output.
    const warn = vi.spyOn(logger, "warn").mockImplementation(() => {})

    const response = await createProfile(
      apiRequest(URL, {
        method: "POST",
        cookie: user.cookie,
        body: JSON.stringify({ name: "Queueless", website_url: SITE }),
      }),
    )

    expect(response.status).toBe(201)
    const body = await response.json()
    expect(body.name).toBe("Queueless")
    // The row is written even though nothing will crawl it, which is what
    // Python's bare `except: pass` guaranteed.
    expect((await readStatus(body.id)).crawlStatus).toBe("pending")
    expect(warn).toHaveBeenCalledWith(
      "Profile created but the sitemap crawl could not be started",
      expect.objectContaining({ profileId: body.id, error: "redis is unreachable" }),
    )
    warn.mockRestore()
  })
})
