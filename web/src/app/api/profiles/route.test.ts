// @vitest-environment node
/**
 * The TypeScript replacement for the `TestReadProfile` cases in
 * `api/tests/phase2/test_profile_crud.py`, plus the multi-tenancy and
 * credential-leak cases that suite never had.
 *
 * Rows are inserted with Drizzle rather than through `POST /api/profiles`,
 * which is ledger item 5.2b and does not exist yet. The handlers are called
 * directly with a `Request` against the real database and a real BetterAuth
 * session, so the `user_id` scoping is genuinely exercised.
 */
import { like } from "drizzle-orm"
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest"

import { closeDb, getDb, websiteProfiles } from "@/db"
import { apiRequest, createTestSession, deleteTestSessions, type TestSession } from "@/test/session"

import { GET as getProfile } from "./[id]/route"
import { GET as listProfiles } from "./route"

const PREFIX = "profiles-route-test-"
const URL = "http://test/api/profiles"

const db = getDb()

let user: TestSession
let other: TestSession

async function clearProfiles() {
  await db.delete(websiteProfiles).where(like(websiteProfiles.userId, `${PREFIX}%`))
}

/** A row owned by `userId`, with everything but the two required columns left to the caller. */
async function insertProfile(
  userId: string,
  values: Partial<typeof websiteProfiles.$inferInsert> = {},
): Promise<string> {
  const [row] = await db
    .insert(websiteProfiles)
    .values({
      userId,
      name: "Test Blog",
      websiteUrl: "https://testblog.com",
      ...values,
    })
    .returning({ id: websiteProfiles.id })
  return row.id
}

/** A `GET /api/profiles/{id}` request, wired up the way Next.js calls the handler. */
function getById(id: string, cookie?: string) {
  return getProfile(apiRequest(`${URL}/${id}`, { cookie }), {
    params: Promise.resolve({ id }),
  })
}

beforeAll(async () => {
  await clearProfiles()
  await deleteTestSessions(PREFIX)
  user = await createTestSession(PREFIX)
  other = await createTestSession(PREFIX)
})

afterEach(clearProfiles)

afterAll(async () => {
  await clearProfiles()
  await deleteTestSessions(PREFIX)
  await closeDb()
})

describe("GET /api/profiles", () => {
  it("401s without a session", async () => {
    const response = await listProfiles(apiRequest(URL))

    expect(response.status).toBe(401)
    expect(await response.json()).toEqual({ detail: "Not authenticated" })
  })

  it("lists nothing for a user with no profiles", async () => {
    const response = await listProfiles(apiRequest(URL, { cookie: user.cookie }))

    expect(response.status).toBe(200)
    expect(await response.json()).toEqual([])
  })

  it("orders newest first, matching created_at desc", async () => {
    await insertProfile(user.userId, {
      name: "Older",
      createdAt: new Date("2024-01-01T00:00:00Z"),
    })
    await insertProfile(user.userId, {
      name: "Newer",
      createdAt: new Date("2025-01-01T00:00:00Z"),
    })

    const body = await (await listProfiles(apiRequest(URL, { cookie: user.cookie }))).json()

    expect(body.map((row: { name: string }) => row.name)).toEqual(["Newer", "Older"])
  })

  it("never returns another user's profile", async () => {
    await insertProfile(other.userId, { name: "Not yours" })

    const body = await (await listProfiles(apiRequest(URL, { cookie: user.cookie }))).json()

    expect(body).toEqual([])
  })

  it("returns exactly the ProfileRead fields, without the two ciphertext columns", async () => {
    await insertProfile(user.userId, {
      niche: "technology",
      targetAudience: "developers",
      tone: "Professional",
      wordCount: 2500,
      outputFormat: "markdown",
      wpAppPassword: "ciphertext-should-never-be-returned",
      nextjsWebhookSecret: "ciphertext-should-never-be-returned",
    })

    const [profile] = await (
      await listProfiles(apiRequest(URL, { cookie: user.cookie }))
    ).json()

    expect(Object.keys(profile).sort()).toEqual([
      "avoid",
      "brand_voice",
      "crawl_status",
      "created_at",
      "default_stage_settings",
      "id",
      "image_brand_colors",
      "image_exclude",
      "image_style",
      "last_crawled_at",
      "name",
      "nextjs_frontmatter_map",
      "nextjs_webhook_url",
      "niche",
      "output_format",
      "recrawl_interval",
      "related_keywords",
      "required_mentions",
      "sitemap_urls",
      "target_audience",
      "tone",
      "updated_at",
      "website_url",
      "word_count",
      "wp_default_author_id",
      "wp_default_category_id",
      "wp_default_status",
      "wp_url",
      "wp_username",
    ])
    expect(JSON.stringify(profile)).not.toContain("ciphertext-should-never-be-returned")
    expect(profile.niche).toBe("technology")
    expect(profile.word_count).toBe(2500)
    expect(profile.crawl_status).toBe("pending")
    expect(profile.wp_default_status).toBe("publish")
  })

  it("substitutes the ProfileRead defaults for null columns", async () => {
    await insertProfile(user.userId, {
      tone: null,
      wordCount: null,
      outputFormat: null,
      imageBrandColors: null,
      imageExclude: null,
      relatedKeywords: null,
      sitemapUrls: null,
      defaultStageSettings: null,
      crawlStatus: null,
      // Optional in ProfileRead, so the null is carried through instead.
      wpDefaultStatus: null,
    })

    const [profile] = await (
      await listProfiles(apiRequest(URL, { cookie: user.cookie }))
    ).json()

    expect(profile.tone).toBe("Conversational and friendly")
    expect(profile.word_count).toBe(2000)
    expect(profile.output_format).toBe("markdown")
    expect(profile.image_brand_colors).toEqual([])
    expect(profile.image_exclude).toEqual([])
    expect(profile.related_keywords).toEqual([])
    expect(profile.sitemap_urls).toEqual([])
    expect(profile.default_stage_settings).toEqual({
      research: "auto",
      outline: "auto",
      write: "auto",
      edit: "auto",
      images: "auto",
      ready: "auto",
    })
    expect(profile.crawl_status).toBe("pending")
    expect(profile.wp_default_status).toBeNull()
  })
})

describe("GET /api/profiles/[id]", () => {
  it("401s without a session", async () => {
    const id = await insertProfile(user.userId)

    const response = await getById(id)

    expect(response.status).toBe(401)
    expect(await response.json()).toEqual({ detail: "Not authenticated" })
  })

  it("returns the profile by id", async () => {
    const id = await insertProfile(user.userId, { niche: "technology" })

    const response = await getById(id, user.cookie)

    expect(response.status).toBe(200)
    const body = await response.json()
    expect(body.id).toBe(id)
    expect(body.name).toBe("Test Blog")
    expect(body.niche).toBe("technology")
  })

  it("404s for an id that does not exist", async () => {
    const response = await getById("00000000-0000-0000-0000-000000000000", user.cookie)

    expect(response.status).toBe(404)
    expect(await response.json()).toEqual({ detail: "Profile not found" })
  })

  it("404s for another user's profile rather than revealing it exists", async () => {
    const id = await insertProfile(other.userId, { name: "Not yours" })

    const response = await getById(id, user.cookie)

    expect(response.status).toBe(404)
    expect(await response.json()).toEqual({ detail: "Profile not found" })
  })

  it("422s on a malformed uuid instead of letting Postgres raise", async () => {
    const response = await getById("not-a-uuid", user.cookie)

    expect(response.status).toBe(422)
    const body = await response.json()
    expect(body.detail[0]).toMatchObject({
      type: "uuid_parsing",
      loc: ["path", "profile_id"],
      input: "not-a-uuid",
    })
  })
})
