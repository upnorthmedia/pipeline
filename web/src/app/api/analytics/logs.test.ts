// @vitest-environment node
/**
 * `GET /api/analytics/logs`.
 *
 * Runs against the real database and real BetterAuth sessions. The whole
 * endpoint is one `jsonb_array_elements` unroll with eight filters, a count and
 * a paginated fetch, so every behaviour worth testing here is Postgres's:
 * the `ILIKE` search, the `= ANY` level list, the *text* comparison of
 * `log_entry->>'ts'` against the two bounds, and the `user_id` scoping. A
 * stubbed database would prove none of it.
 *
 * Requires `docker compose up -d db`.
 */
import { randomUUID } from "node:crypto"

import { like } from "drizzle-orm"
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest"

import { closeDb, getDb, posts, websiteProfiles } from "@/db"
import { apiRequest, createTestSession, deleteTestSessions, type TestSession } from "@/test/session"

import { GET } from "./logs/route"

const PREFIX = "analytics-logs-test-"
const URL_BASE = "http://test/api/analytics/logs"

/** Discard port on loopback, on a path this file owns, so no other suite's cleanup matches. */
const SITE = "http://127.0.0.1:9/analytics-logs"

interface LogItem {
  post_id: string
  slug: string
  topic: string
  timestamp: string
  stage: string | null
  level: string | null
  event: string | null
  message: string | null
  data: Record<string, unknown> | null
}

interface LogsBody {
  items: LogItem[]
  total: number
  page: number
  per_page: number
  pages: number
}

const db = getDb()

let user: TestSession
let other: TestSession
let profileId: string
let secondProfileId: string
let otherProfileId: string

async function clearPosts() {
  await db.delete(posts).where(like(posts.slug, `${PREFIX}%`))
}

async function clearFixtures() {
  await clearPosts()
  await db.delete(websiteProfiles).where(like(websiteProfiles.userId, `${PREFIX}%`))
}

async function createProfile(userId: string, name = "Main Blog"): Promise<string> {
  const [profile] = await db
    .insert(websiteProfiles)
    .values({ userId, name, websiteUrl: SITE })
    .returning()
  return profile.id
}

/** One `execution_logs` entry, in the shape `log_event()` writes. */
function logEntry(overrides: Record<string, unknown> = {}) {
  return {
    ts: "2026-08-20T12:00:00+00:00",
    stage: "write",
    level: "info",
    event: "stage_start",
    message: "Starting write",
    data: { attempt: 1 },
    ...overrides,
  }
}

async function insertPost(
  profile: string | null,
  executionLogs: Record<string, unknown>[],
  topic = "A topic",
): Promise<{ id: string; slug: string }> {
  const slug = `${PREFIX}${randomUUID()}`
  const [row] = await db
    .insert(posts)
    .values({ slug, topic, profileId: profile, executionLogs })
    .returning({ id: posts.id })
  return { id: row.id, slug }
}

function call(query = "", cookie?: string) {
  return GET(apiRequest(`${URL_BASE}${query}`, { cookie }))
}

async function body(query = "", cookie = user.cookie): Promise<LogsBody> {
  const response = await call(query, cookie)
  expect(response.status).toBe(200)
  return (await response.json()) as LogsBody
}

async function detail(query: string): Promise<unknown> {
  const response = await call(query, user.cookie)
  expect(response.status).toBe(422)
  return ((await response.json()) as { detail: unknown }).detail
}

/** `datetime.now(UTC).isoformat()` for an offset from now, the shape `log_event()` stores. */
function tsOffsetDays(days: number): string {
  const iso = new Date(Date.now() - days * 24 * 60 * 60 * 1000).toISOString()
  return `${iso.slice(0, 19)}.${iso.slice(20, 23)}000+00:00`
}

beforeAll(async () => {
  await clearFixtures()
  await deleteTestSessions(PREFIX)
  user = await createTestSession(PREFIX)
  other = await createTestSession(PREFIX)
  profileId = await createProfile(user.userId)
  secondProfileId = await createProfile(user.userId, "Second Blog")
  otherProfileId = await createProfile(other.userId, "Other Blog")
})

afterEach(async () => {
  await clearPosts()
})

afterAll(async () => {
  await clearFixtures()
  await deleteTestSessions(PREFIX)
  await closeDb()
})

describe("GET /api/analytics/logs", () => {
  it("rejects an unauthenticated request", async () => {
    const response = await call()
    expect(response.status).toBe(401)
    expect(await response.json()).toEqual({ detail: "Not authenticated" })
  })

  it("answers an empty history with an empty page and no pages", async () => {
    expect(await body()).toEqual({ items: [], total: 0, page: 1, per_page: 50, pages: 0 })
  })

  it("projects the nine fields of one entry, with data as a parsed object", async () => {
    const post = await insertPost(profileId, [logEntry()], "How to bake")
    expect(await body()).toEqual({
      items: [
        {
          post_id: post.id,
          slug: post.slug,
          topic: "How to bake",
          timestamp: "2026-08-20T12:00:00+00:00",
          stage: "write",
          level: "info",
          event: "stage_start",
          message: "Starting write",
          data: { attempt: 1 },
        },
      ],
      total: 1,
      page: 1,
      per_page: 50,
      pages: 1,
    })
  })

  it("reports a missing key as null rather than dropping the entry", async () => {
    await insertPost(profileId, [{ ts: "2026-08-20T12:00:00+00:00" }])
    const { items } = await body()
    expect(items).toEqual([
      expect.objectContaining({
        timestamp: "2026-08-20T12:00:00+00:00",
        stage: null,
        level: null,
        event: null,
        message: null,
        data: null,
      }),
    ])
  })

  it("unrolls every entry of every post into its own row", async () => {
    await insertPost(profileId, [
      logEntry({ ts: "2026-08-20T12:00:00+00:00" }),
      logEntry({ ts: "2026-08-20T12:00:01+00:00" }),
    ])
    await insertPost(profileId, [logEntry({ ts: "2026-08-20T12:00:02+00:00" })])
    const { total, items } = await body()
    expect(total).toBe(3)
    expect(items).toHaveLength(3)
  })

  it("orders entries by timestamp descending", async () => {
    await insertPost(profileId, [
      logEntry({ ts: "2026-08-20T12:00:00+00:00", message: "first" }),
      logEntry({ ts: "2026-08-20T12:00:02+00:00", message: "third" }),
      logEntry({ ts: "2026-08-20T12:00:01+00:00", message: "second" }),
    ])
    const { items } = await body()
    expect(items.map((item) => item.message)).toEqual(["third", "second", "first"])
  })
})

describe("GET /api/analytics/logs scoping", () => {
  it("excludes a post whose execution_logs is the empty array", async () => {
    await insertPost(profileId, [])
    expect(await body()).toEqual({ items: [], total: 0, page: 1, per_page: 50, pages: 0 })
  })

  it("excludes another user's posts", async () => {
    await insertPost(otherProfileId, [logEntry()])
    expect((await body()).total).toBe(0)
    expect((await body("", other.cookie)).total).toBe(1)
  })

  it("excludes a post with no profile, which has no owner to scope by", async () => {
    await insertPost(null, [logEntry()])
    expect((await body()).total).toBe(0)
  })
})

describe("GET /api/analytics/logs filters", () => {
  it("filters by a single level", async () => {
    await insertPost(profileId, [
      logEntry({ level: "info", message: "an info" }),
      logEntry({ level: "error", message: "an error" }),
    ])
    const { items, total } = await body("?level=error")
    expect(total).toBe(1)
    expect(items[0].message).toBe("an error")
  })

  it("splits a comma-separated level list and strips whitespace around each", async () => {
    await insertPost(profileId, [
      logEntry({ level: "info" }),
      logEntry({ level: "warning" }),
      logEntry({ level: "error" }),
    ])
    const levels = await body("?level=" + encodeURIComponent(" info , error "))
    expect(levels.total).toBe(2)
    expect(levels.items.map((item) => item.level).sort()).toEqual(["error", "info"])
  })

  it("treats an empty level as no filter at all", async () => {
    await insertPost(profileId, [logEntry({ level: "info" })])
    expect((await body("?level=")).total).toBe(1)
  })

  it("filters by an exact stage, not a prefix", async () => {
    await insertPost(profileId, [logEntry({ stage: "write" }), logEntry({ stage: "writeup" })])
    const { items, total } = await body("?stage=write")
    expect(total).toBe(1)
    expect(items[0].stage).toBe("write")
  })

  it("filters by profile_id", async () => {
    await insertPost(profileId, [logEntry({ message: "main" })])
    await insertPost(secondProfileId, [logEntry({ message: "second" })])
    const { items, total } = await body(`?profile_id=${secondProfileId}`)
    expect(total).toBe(1)
    expect(items[0].message).toBe("second")
  })

  it("treats an empty profile_id as no filter at all", async () => {
    await insertPost(profileId, [logEntry()])
    expect((await body("?profile_id=")).total).toBe(1)
  })

  it("searches the message case-insensitively as a substring", async () => {
    await insertPost(profileId, [
      logEntry({ message: "Retrying the WRITE stage" }),
      logEntry({ message: "Nothing to see" }),
    ])
    const { items, total } = await body("?q=write")
    expect(total).toBe(1)
    expect(items[0].message).toBe("Retrying the WRITE stage")
  })

  it("passes a wildcard in q through to ILIKE unescaped, as Python does", async () => {
    await insertPost(profileId, [
      logEntry({ message: "a-b" }),
      logEntry({ message: "axxb" }),
      logEntry({ message: "zzz" }),
    ])
    expect((await body("?q=" + encodeURIComponent("a%b"))).total).toBe(2)
  })

  it("combines every filter with AND", async () => {
    await insertPost(profileId, [
      logEntry({ level: "error", stage: "write", message: "boom" }),
      logEntry({ level: "error", stage: "edit", message: "boom" }),
      logEntry({ level: "info", stage: "write", message: "boom" }),
      logEntry({ level: "error", stage: "write", message: "fine" }),
    ])
    const { total } = await body(`?level=error&stage=write&q=boom&profile_id=${profileId}`)
    expect(total).toBe(1)
  })
})

describe("GET /api/analytics/logs time bounds", () => {
  it("includes an entry exactly on the since bound", async () => {
    await insertPost(profileId, [logEntry({ ts: "2026-08-20T12:00:00+00:00" })])
    expect((await body("?since=2026-08-20T12:00:00%2B00:00")).total).toBe(1)
  })

  it("excludes an entry one second before the since bound", async () => {
    await insertPost(profileId, [logEntry({ ts: "2026-08-20T11:59:59+00:00" })])
    expect((await body("?since=2026-08-20T12:00:00%2B00:00")).total).toBe(0)
  })

  it("includes an entry exactly on the until bound", async () => {
    await insertPost(profileId, [logEntry({ ts: "2026-08-20T12:00:00+00:00" })])
    expect((await body("?since=2026-01-01&until=2026-08-20T12:00:00%2B00:00")).total).toBe(1)
  })

  it("excludes an entry one second after the until bound", async () => {
    await insertPost(profileId, [logEntry({ ts: "2026-08-20T12:00:01+00:00" })])
    expect((await body("?since=2026-01-01&until=2026-08-20T12:00:00%2B00:00")).total).toBe(0)
  })

  it("normalises a Z-suffixed bound to +00:00 so the boundary second still matches", async () => {
    // `Z` (0x5A) sorts above `+` (0x2B), so a bound that kept its `Z` would
    // drop every entry inside the boundary second on the `until` side and
    // admit them on the `since` side. This is what `fromIsoFormat` is for.
    await insertPost(profileId, [logEntry({ ts: "2026-08-20T12:00:00.500000+00:00" })])
    expect((await body("?since=2026-01-01&until=2026-08-20T12:00:01Z")).total).toBe(1)
    expect((await body("?since=2026-08-20T12:00:00Z")).total).toBe(1)
  })

  it("defaults to a ninety-day window when since is absent", async () => {
    await insertPost(profileId, [
      logEntry({ ts: tsOffsetDays(89), message: "inside" }),
      logEntry({ ts: tsOffsetDays(91), message: "outside" }),
    ])
    const { items, total } = await body()
    expect(total).toBe(1)
    expect(items[0].message).toBe("inside")
  })

  it("treats an empty since as absent and falls back to the default window", async () => {
    await insertPost(profileId, [logEntry({ ts: tsOffsetDays(91) })])
    expect((await body("?since=")).total).toBe(0)
  })

  it("applies no upper bound when until is absent", async () => {
    await insertPost(profileId, [logEntry({ ts: tsOffsetDays(-1) })])
    expect((await body()).total).toBe(1)
  })

  it("treats an empty until as no upper bound", async () => {
    await insertPost(profileId, [logEntry({ ts: tsOffsetDays(-1) })])
    expect((await body("?until=")).total).toBe(1)
  })
})

describe("GET /api/analytics/logs pagination", () => {
  async function insertEntries(count: number) {
    const entries = Array.from({ length: count }, (_, index) =>
      logEntry({
        ts: `2026-08-20T12:00:${String(index).padStart(2, "0")}+00:00`,
        message: `entry ${index}`,
      }),
    )
    await insertPost(profileId, entries)
  }

  it("rolls the page count up and reports the requested page", async () => {
    await insertEntries(5)
    const page = await body("?per_page=2&page=2")
    expect(page.total).toBe(5)
    expect(page.page).toBe(2)
    expect(page.per_page).toBe(2)
    expect(page.pages).toBe(3)
    expect(page.items.map((item) => item.message)).toEqual(["entry 2", "entry 1"])
  })

  it("reports zero pages rather than one when nothing matches", async () => {
    expect((await body("?per_page=2")).pages).toBe(0)
  })

  it("answers an empty page past the end", async () => {
    await insertEntries(3)
    const page = await body("?per_page=2&page=9")
    expect(page.items).toEqual([])
    expect(page.total).toBe(3)
    expect(page.pages).toBe(2)
  })
})

describe("GET /api/analytics/logs validation", () => {
  it("rejects page below its minimum", async () => {
    expect(await detail("?page=0")).toEqual([
      {
        type: "greater_than_equal",
        loc: ["query", "page"],
        msg: "Input should be greater than or equal to 1",
        input: "0",
        ctx: { ge: 1 },
      },
    ])
  })

  it("rejects per_page above its maximum", async () => {
    expect(await detail("?per_page=201")).toEqual([
      {
        type: "less_than_equal",
        loc: ["query", "per_page"],
        msg: "Input should be less than or equal to 200",
        input: "201",
        ctx: { le: 200 },
      },
    ])
  })

  it("reports page and per_page in declaration order in one response", async () => {
    expect(await detail("?page=abc&per_page=999")).toEqual([
      {
        type: "int_parsing",
        loc: ["query", "page"],
        msg: "Input should be a valid integer, unable to parse string as an integer",
        input: "abc",
      },
      {
        type: "less_than_equal",
        loc: ["query", "per_page"],
        msg: "Input should be less than or equal to 200",
        input: "999",
        ctx: { le: 200 },
      },
    ])
  })

  it("accepts pydantic's lax integer forms", async () => {
    expect((await body("?page=2.0")).page).toBe(2)
  })

  it("takes the last value of a repeated parameter, as Starlette does", async () => {
    expect((await body("?page=1&page=3")).page).toBe(3)
    await insertPost(profileId, [logEntry({ level: "error" })])
    expect((await body("?level=info&level=error")).total).toBe(1)
  })

  it("rejects a since it cannot parse instead of raising", async () => {
    expect(await detail("?since=nonsense")).toEqual([
      {
        type: "datetime_from_date_parsing",
        loc: ["query", "since"],
        msg: "Input should be a valid datetime or date",
        input: "nonsense",
      },
    ])
  })

  it("rejects an until it cannot parse instead of raising", async () => {
    expect(await detail("?since=2026-01-01&until=13:00")).toEqual([
      {
        type: "datetime_from_date_parsing",
        loc: ["query", "until"],
        msg: "Input should be a valid datetime or date",
        input: "13:00",
      },
    ])
  })

  it("reports a bad page before a bad since, because FastAPI validated first", async () => {
    expect(await detail("?page=abc&since=nonsense")).toEqual([
      {
        type: "int_parsing",
        loc: ["query", "page"],
        msg: "Input should be a valid integer, unable to parse string as an integer",
        input: "abc",
      },
    ])
  })

  it("rejects a profile_id that is not a uuid instead of reaching the column", async () => {
    expect(await detail("?profile_id=nope")).toEqual([
      {
        type: "uuid_parsing",
        loc: ["query", "profile_id"],
        msg: "Input should be a valid UUID",
        input: "nope",
      },
    ])
  })
})
