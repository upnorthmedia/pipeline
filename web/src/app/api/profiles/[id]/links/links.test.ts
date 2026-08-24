// @vitest-environment node
/**
 * The TypeScript replacement for `api/tests/phase2/test_internal_links.py`,
 * plus the multi-tenancy cases that suite never had and the parameter-shape
 * cases probed off the real FastAPI router.
 *
 * The handlers are called directly with a `Request` against the real database
 * and a real BetterAuth session, so the `user_id` scoping is genuinely
 * exercised. Read fixtures are inserted with Drizzle rather than through
 * `POST`, so a create bug cannot hide a read bug.
 */
import { and, eq, like } from "drizzle-orm"
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest"

import { closeDb, getDb, internalLinks, websiteProfiles } from "@/db"
import { ABSENT_LINK_ID, ABSENT_POST_ID, ABSENT_PROFILE_ID } from "@/test/absent-ids"
import { apiRequest, createTestSession, deleteTestSessions, type TestSession } from "@/test/session"

import { DELETE as deleteLink } from "./[link_id]/route"
import { GET as listLinks, POST as createLink } from "./route"

const PREFIX = "links-route-test-"
const BASE = "http://test/api/profiles"
const LINK_HOST = "http://127.0.0.1:9/links-route-test/"

const db = getDb()

let user: TestSession
let other: TestSession
let profileId: string
let otherProfileId: string

/**
 * Fixture links are namespaced under a path segment of their own, because
 * another route-handler suite writes `internal_links` rows against the same
 * loopback host: `posts/update-delete.test.ts` inserts one to prove Alembic
 * 006's `SET NULL`, and a cleanup matching the host alone deletes it out from
 * under that assertion when the two files run at the same time.
 */
async function clearLinks() {
  await db.delete(internalLinks).where(like(internalLinks.url, `${LINK_HOST}%`))
}

async function insertProfile(userId: string): Promise<string> {
  const [row] = await db
    .insert(websiteProfiles)
    .values({ userId, name: "Link Test Blog", websiteUrl: "http://127.0.0.1:9/links-route-test/linktest" })
    .returning({ id: websiteProfiles.id })
  return row.id
}

/** A link row, written straight to the table so no handler is in the way. */
async function insertLink(
  profile: string,
  values: Partial<typeof internalLinks.$inferInsert> = {},
): Promise<string> {
  const [row] = await db
    .insert(internalLinks)
    .values({
      profileId: profile,
      url: "http://127.0.0.1:9/links-route-test/page/",
      source: "sitemap",
      ...values,
    })
    .returning({ id: internalLinks.id })
  return row.id
}

function list(profile: string, query = "", cookie?: string) {
  return listLinks(apiRequest(`${BASE}/${profile}/links${query}`, { cookie }), {
    params: Promise.resolve({ id: profile }),
  })
}

function post(profile: string, body: unknown, cookie?: string) {
  return createLink(
    apiRequest(`${BASE}/${profile}/links`, {
      method: "POST",
      cookie,
      body: typeof body === "string" ? body : JSON.stringify(body),
    }),
    { params: Promise.resolve({ id: profile }) },
  )
}

function del(profile: string, linkId: string, cookie?: string) {
  return deleteLink(apiRequest(`${BASE}/${profile}/links/${linkId}`, { method: "DELETE", cookie }), {
    params: Promise.resolve({ id: profile, link_id: linkId }),
  })
}

async function countLinks(profile: string): Promise<number> {
  const rows = await db.select().from(internalLinks).where(eq(internalLinks.profileId, profile))
  return rows.length
}

beforeAll(async () => {
  await deleteTestSessions(PREFIX)
  await db.delete(websiteProfiles).where(like(websiteProfiles.userId, `${PREFIX}%`))
  user = await createTestSession(PREFIX)
  other = await createTestSession(PREFIX)
  profileId = await insertProfile(user.userId)
  otherProfileId = await insertProfile(other.userId)
})

afterEach(clearLinks)

afterAll(async () => {
  await clearLinks()
  await db.delete(websiteProfiles).where(like(websiteProfiles.userId, `${PREFIX}%`))
  await deleteTestSessions(PREFIX)
  await closeDb()
})

describe("GET /api/profiles/{profile_id}/links", () => {
  it("401s without a session", async () => {
    const response = await list(profileId)

    expect(response.status).toBe(401)
    expect(await response.json()).toEqual({ detail: "Not authenticated" })
  })

  it("answers a malformed path uuid with FastAPI's 422", async () => {
    const response = await list("not-a-uuid", "", user.cookie)

    expect(response.status).toBe(422)
    expect(await response.json()).toEqual({
      detail: [
        {
          type: "uuid_parsing",
          loc: ["path", "profile_id"],
          msg: "Input should be a valid UUID",
          input: "not-a-uuid",
        },
      ],
    })
  })

  it("404s for a profile that does not exist", async () => {
    const response = await list(ABSENT_PROFILE_ID, "", user.cookie)

    expect(response.status).toBe(404)
    expect(await response.json()).toEqual({ detail: "Profile not found" })
  })

  it("404s for another user's profile rather than listing its links", async () => {
    await insertLink(otherProfileId, { url: "http://127.0.0.1:9/links-route-test/secret/" })

    const response = await list(otherProfileId, "", user.cookie)

    expect(response.status).toBe(404)
    expect(await response.json()).toEqual({ detail: "Profile not found" })
  })

  it("returns the empty page shape for a profile with no links", async () => {
    const response = await list(profileId, "", user.cookie)

    expect(response.status).toBe(200)
    expect(await response.json()).toEqual({
      items: [],
      total: 0,
      page: 1,
      per_page: 50,
      pages: 0,
    })
  })

  it("emits exactly LinkRead's field set, in its order", async () => {
    const id = await insertLink(profileId, {
      url: "http://127.0.0.1:9/links-route-test/blog/test-post/",
      title: "Test Post Title",
      slug: "test-post",
      keywords: ["testing", "automation"],
      createdAt: new Date("2026-01-02T03:04:05.678Z"),
    })

    const body = (await (await list(profileId, "", user.cookie)).json()) as {
      items: Record<string, unknown>[]
    }

    expect(Object.keys(body.items[0])).toEqual([
      "url",
      "title",
      "slug",
      "keywords",
      "id",
      "profile_id",
      "source",
      "post_id",
      "created_at",
    ])
    expect(body.items[0]).toEqual({
      url: "http://127.0.0.1:9/links-route-test/blog/test-post/",
      title: "Test Post Title",
      slug: "test-post",
      keywords: ["testing", "automation"],
      id,
      profile_id: profileId,
      source: "sitemap",
      post_id: null,
      created_at: "2026-01-02T03:04:05.678Z",
    })
  })

  it("orders newest first and counts every match", async () => {
    for (const [i, day] of ["01", "03", "02"].entries()) {
      await insertLink(profileId, {
        url: `http://127.0.0.1:9/links-route-test/page-${i}/`,
        createdAt: new Date(`2026-01-${day}T00:00:00Z`),
      })
    }

    const body = (await (await list(profileId, "", user.cookie)).json()) as {
      items: { url: string }[]
      total: number
    }

    expect(body.total).toBe(3)
    expect(body.items.map((item) => item.url)).toEqual([
      "http://127.0.0.1:9/links-route-test/page-1/",
      "http://127.0.0.1:9/links-route-test/page-2/",
      "http://127.0.0.1:9/links-route-test/page-0/",
    ])
  })

  it("excludes another profile's links from the count and the page", async () => {
    await insertLink(profileId, { url: "http://127.0.0.1:9/links-route-test/mine/" })
    await insertLink(otherProfileId, { url: "http://127.0.0.1:9/links-route-test/theirs/" })

    const body = (await (await list(profileId, "", user.cookie)).json()) as {
      items: { url: string }[]
      total: number
    }

    expect(body.total).toBe(1)
    expect(body.items.map((item) => item.url)).toEqual(["http://127.0.0.1:9/links-route-test/mine/"])
  })

  it("paginates with per_page and page, reporting the page count", async () => {
    for (let i = 0; i < 5; i++) {
      await insertLink(profileId, {
        url: `http://127.0.0.1:9/links-route-test/p-${i}/`,
        createdAt: new Date(`2026-01-0${i + 1}T00:00:00Z`),
      })
    }

    const first = (await (await list(profileId, "?per_page=2&page=1", user.cookie)).json()) as {
      items: { url: string }[]
      total: number
      pages: number
      per_page: number
    }
    expect(first.total).toBe(5)
    expect(first.pages).toBe(3)
    expect(first.per_page).toBe(2)
    expect(first.items.map((item) => item.url)).toEqual([
      "http://127.0.0.1:9/links-route-test/p-4/",
      "http://127.0.0.1:9/links-route-test/p-3/",
    ])

    const third = (await (await list(profileId, "?per_page=2&page=3", user.cookie)).json()) as {
      items: { url: string }[]
      page: number
    }
    expect(third.page).toBe(3)
    expect(third.items.map((item) => item.url)).toEqual(["http://127.0.0.1:9/links-route-test/p-0/"])
  })

  it("searches url and title case-insensitively, the way ilike did", async () => {
    await insertLink(profileId, {
      url: "http://127.0.0.1:9/links-route-test/blog/python-tips/",
      title: "Python Tips",
    })
    await insertLink(profileId, {
      url: "http://127.0.0.1:9/links-route-test/about/",
      title: "Getting Started Guide",
    })
    await insertLink(profileId, { url: "http://127.0.0.1:9/links-route-test/faq/", title: "FAQ" })

    const byUrl = (await (await list(profileId, "?q=python", user.cookie)).json()) as {
      items: { url: string }[]
      total: number
    }
    expect(byUrl.total).toBe(1)
    expect(byUrl.items[0].url).toContain("python")

    const byTitle = (await (await list(profileId, "?q=started", user.cookie)).json()) as {
      total: number
    }
    expect(byTitle.total).toBe(1)

    const noMatch = (await (await list(profileId, "?q=nothing-here", user.cookie)).json()) as {
      total: number
      pages: number
    }
    expect(noMatch).toMatchObject({ total: 0, pages: 0 })
  })

  it("matches a link with a null title on the url alone", async () => {
    await insertLink(profileId, { url: "http://127.0.0.1:9/links-route-test/untitled/", title: null })

    const body = (await (await list(profileId, "?q=untitled", user.cookie)).json()) as {
      total: number
    }

    expect(body.total).toBe(1)
  })

  it("treats an empty ?q= as absent, the way a falsy Python string was", async () => {
    await insertLink(profileId, { url: "http://127.0.0.1:9/links-route-test/kept/" })

    const body = (await (await list(profileId, "?q=", user.cookie)).json()) as { total: number }

    expect(body.total).toBe(1)
  })

  it.each([
    [
      "?page=0",
      {
        type: "greater_than_equal",
        loc: ["query", "page"],
        msg: "Input should be greater than or equal to 1",
        input: "0",
        ctx: { ge: 1 },
      },
    ],
    [
      "?per_page=201",
      {
        type: "less_than_equal",
        loc: ["query", "per_page"],
        msg: "Input should be less than or equal to 200",
        input: "201",
        ctx: { le: 200 },
      },
    ],
    [
      "?page=abc",
      {
        type: "int_parsing",
        loc: ["query", "page"],
        msg: "Input should be a valid integer, unable to parse string as an integer",
        input: "abc",
      },
    ],
    [
      "?per_page=",
      {
        type: "int_parsing",
        loc: ["query", "per_page"],
        msg: "Input should be a valid integer, unable to parse string as an integer",
        input: "",
      },
    ],
  ])("answers %s with FastAPI's Query() 422", async (query, detail) => {
    const response = await list(profileId, query, user.cookie)

    expect(response.status).toBe(422)
    expect(await response.json()).toEqual({ detail: [detail] })
  })

  it("reports the path uuid and both bad query parameters in one 422, path first", async () => {
    const response = await list("bad", "?page=0&per_page=999", user.cookie)

    expect(response.status).toBe(422)
    const body = (await response.json()) as { detail: { type: string; loc: string[] }[] }
    expect(body.detail.map((entry) => [entry.type, entry.loc])).toEqual([
      ["uuid_parsing", ["path", "profile_id"]],
      ["greater_than_equal", ["query", "page"]],
      ["less_than_equal", ["query", "per_page"]],
    ])
  })

  it.each(["?per_page=2.0", "?per_page=+2", "?per_page=%202%20", "?per_page=1_0"])(
    "accepts %s, which pydantic's lax int parse accepts",
    async (query) => {
      const response = await list(profileId, query, user.cookie)

      expect(response.status).toBe(200)
    },
  )

  it("keeps the last value of a repeated ?page=, as Starlette's QueryParams does", async () => {
    await insertLink(profileId, { url: "http://127.0.0.1:9/links-route-test/only/" })

    const body = (await (await list(profileId, "?page=1&page=3", user.cookie)).json()) as {
      page: number
      items: unknown[]
    }

    expect(body.page).toBe(3)
    expect(body.items).toEqual([])
  })
})

describe("POST /api/profiles/{profile_id}/links", () => {
  const payload = {
    url: "http://127.0.0.1:9/links-route-test/blog/test-post/",
    title: "Test Post Title",
    slug: "test-post",
    keywords: ["testing", "automation"],
  }

  it("401s without a session", async () => {
    const response = await post(profileId, payload)

    expect(response.status).toBe(401)
    expect(await countLinks(profileId)).toBe(0)
  })

  it("creates a link with source manual and echoes LinkRead", async () => {
    const response = await post(profileId, payload, user.cookie)

    expect(response.status).toBe(201)
    const body = (await response.json()) as Record<string, unknown>
    expect(body).toMatchObject({
      url: payload.url,
      title: "Test Post Title",
      slug: "test-post",
      keywords: ["testing", "automation"],
      source: "manual",
      profile_id: profileId,
      post_id: null,
    })

    const [row] = await db.select().from(internalLinks).where(eq(internalLinks.id, body.id as string))
    expect(row.source).toBe("manual")
    expect(row.keywords).toEqual(["testing", "automation"])
  })

  it("fills LinkCreate's defaults for a url-only body", async () => {
    const response = await post(profileId, { url: "http://127.0.0.1:9/links-route-test/page/" }, user.cookie)

    expect(response.status).toBe(201)
    expect(await response.json()).toMatchObject({
      title: null,
      slug: null,
      keywords: [],
      source: "manual",
    })
  })

  it("ignores extra keys, so source and post_id cannot be claimed by a client", async () => {
    const response = await post(
      profileId,
      { ...payload, source: "sitemap", post_id: ABSENT_POST_ID, id: "x" },
      user.cookie,
    )

    expect(response.status).toBe(201)
    const body = (await response.json()) as { id: string; source: string; post_id: null }
    expect(body.source).toBe("manual")
    expect(body.post_id).toBeNull()
    expect(body.id).not.toBe("x")
  })

  it("409s on a duplicate url for the same profile", async () => {
    await post(profileId, payload, user.cookie)

    const response = await post(profileId, payload, user.cookie)

    expect(response.status).toBe(409)
    expect(await response.json()).toEqual({
      detail: "Link with this URL already exists for this profile",
    })
    expect(await countLinks(profileId)).toBe(1)
  })

  it("allows the same url under a different profile", async () => {
    await insertLink(otherProfileId, { url: payload.url })

    const response = await post(profileId, payload, user.cookie)

    expect(response.status).toBe(201)
  })

  it("404s for a profile that does not exist", async () => {
    const response = await post(ABSENT_PROFILE_ID, payload, user.cookie)

    expect(response.status).toBe(404)
    expect(await response.json()).toEqual({ detail: "Profile not found" })
  })

  it("404s for another user's profile, writing nothing", async () => {
    const response = await post(otherProfileId, payload, user.cookie)

    expect(response.status).toBe(404)
    expect(await countLinks(otherProfileId)).toBe(0)
  })

  it("answers a missing url with pydantic's missing error", async () => {
    const response = await post(profileId, { title: "t" }, user.cookie)

    expect(response.status).toBe(422)
    expect(await response.json()).toEqual({
      detail: [
        { type: "missing", loc: ["body", "url"], msg: "Field required", input: { title: "t" } },
      ],
    })
  })

  it("reports a bad keyword by its index, as pydantic did", async () => {
    const response = await post(
      profileId,
      { url: "http://127.0.0.1:9/links-route-test/x/", keywords: ["a", 1] },
      user.cookie,
    )

    expect(response.status).toBe(422)
    expect(await response.json()).toEqual({
      detail: [
        {
          type: "string_type",
          loc: ["body", "keywords", 1],
          msg: "Input should be a valid string",
          input: 1,
        },
      ],
    })
  })

  it("reports the path uuid and the body error in one 422, path first", async () => {
    const response = await post("bad", { url: 5 }, user.cookie)

    expect(response.status).toBe(422)
    expect(await response.json()).toEqual({
      detail: [
        {
          type: "uuid_parsing",
          loc: ["path", "profile_id"],
          msg: "Input should be a valid UUID",
          input: "bad",
        },
        {
          type: "string_type",
          loc: ["body", "url"],
          msg: "Input should be a valid string",
          input: 5,
        },
      ],
    })
  })

  it("answers a body it cannot decode with json_invalid alone, even on a bad path", async () => {
    const response = await post("bad", "{nope", user.cookie)

    expect(response.status).toBe(422)
    const body = (await response.json()) as { detail: { type: string }[] }
    expect(body.detail.map((entry) => entry.type)).toEqual(["json_invalid"])
  })
})

describe("DELETE /api/profiles/{profile_id}/links/{link_id}", () => {
  it("401s without a session, leaving the row", async () => {
    const id = await insertLink(profileId)

    const response = await del(profileId, id)

    expect(response.status).toBe(401)
    expect(await countLinks(profileId)).toBe(1)
  })

  it("deletes the link and answers 204 with no body", async () => {
    const id = await insertLink(profileId)

    const response = await del(profileId, id, user.cookie)

    expect(response.status).toBe(204)
    expect(await response.text()).toBe("")
    expect(await countLinks(profileId)).toBe(0)
  })

  it("404s for a link that does not exist", async () => {
    const response = await del(profileId, ABSENT_LINK_ID, user.cookie)

    expect(response.status).toBe(404)
    expect(await response.json()).toEqual({ detail: "Link not found" })
  })

  it("404s when the link belongs to another profile of the same user", async () => {
    const second = await insertProfile(user.userId)
    const id = await insertLink(second)

    const response = await del(profileId, id, user.cookie)

    expect(response.status).toBe(404)
    expect(await countLinks(second)).toBe(1)

    await db.delete(internalLinks).where(eq(internalLinks.profileId, second))
    await db.delete(websiteProfiles).where(eq(websiteProfiles.id, second))
  })

  it("404s for another user's link and leaves it in place", async () => {
    const id = await insertLink(otherProfileId, { url: "http://127.0.0.1:9/links-route-test/theirs/" })

    const response = await del(otherProfileId, id, user.cookie)

    expect(response.status).toBe(404)
    expect(await response.json()).toEqual({ detail: "Link not found" })
    const rows = await db
      .select()
      .from(internalLinks)
      .where(and(eq(internalLinks.id, id), eq(internalLinks.profileId, otherProfileId)))
    expect(rows).toHaveLength(1)
  })

  it("reports both malformed path uuids in one 422", async () => {
    const response = await del("bad", "nope", user.cookie)

    expect(response.status).toBe(422)
    expect(await response.json()).toEqual({
      detail: [
        {
          type: "uuid_parsing",
          loc: ["path", "profile_id"],
          msg: "Input should be a valid UUID",
          input: "bad",
        },
        {
          type: "uuid_parsing",
          loc: ["path", "link_id"],
          msg: "Input should be a valid UUID",
          input: "nope",
        },
      ],
    })
  })
})
