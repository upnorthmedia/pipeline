// @vitest-environment node
/**
 * The TypeScript replacement for `api/tests/phase2/test_profile_crud.py`, plus
 * the multi-tenancy and credential-leak cases that suite never had.
 *
 * The handlers are called directly with a `Request` against the real database
 * and a real BetterAuth session, so the `user_id` scoping is genuinely
 * exercised. Read fixtures are inserted with Drizzle rather than through
 * `POST`, so a create bug cannot hide a read bug.
 */
import { eq, like } from "drizzle-orm"
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest"

import { closeDb, getDb, internalLinks, posts, websiteProfiles } from "@/db"
import { decryptWithKey } from "@/lib/crypto"
import { apiRequest, createTestSession, deleteTestSessions, type TestSession } from "@/test/session"

import { DELETE as deleteProfile, GET as getProfile, PATCH as patchProfile } from "./[id]/route"
import { GET as listProfiles, POST as createProfile } from "./route"

const PREFIX = "profiles-route-test-"
const URL = "http://test/api/profiles"

/** A throwaway Fernet key, so no real `WP_ENCRYPTION_KEY` is needed to run this. */
const TEST_KEY = Buffer.alloc(32, 7).toString("base64url")

const db = getDb()

let user: TestSession
let other: TestSession
let savedEncryptionKey: string | undefined

async function clearProfiles() {
  // posts_profile_id_fkey has no ON DELETE action, so the posts a test attached
  // to a profile have to go first.
  await db.delete(posts).where(like(posts.slug, `${PREFIX}%`))
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

/** `POST /api/profiles`. `body` is sent raw so a malformed one can be tested. */
function post(body: unknown, cookie?: string) {
  return createProfile(
    apiRequest(URL, {
      method: "POST",
      cookie,
      body: typeof body === "string" ? body : JSON.stringify(body),
    }),
  )
}

/** `PATCH /api/profiles/{id}`. */
function patch(id: string, body: unknown, cookie?: string) {
  return patchProfile(
    apiRequest(`${URL}/${id}`, {
      method: "PATCH",
      cookie,
      body: typeof body === "string" ? body : JSON.stringify(body),
    }),
    { params: Promise.resolve({ id }) },
  )
}

/** `DELETE /api/profiles/{id}`. */
function del(id: string, cookie?: string) {
  return deleteProfile(apiRequest(`${URL}/${id}`, { method: "DELETE", cookie }), {
    params: Promise.resolve({ id }),
  })
}

/** The stored row, straight from the database rather than through a handler. */
async function readRow(id: string) {
  const [row] = await db.select().from(websiteProfiles).where(eq(websiteProfiles.id, id)).limit(1)
  return row
}

beforeAll(async () => {
  savedEncryptionKey = process.env.WP_ENCRYPTION_KEY
  process.env.WP_ENCRYPTION_KEY = TEST_KEY
  await clearProfiles()
  await deleteTestSessions(PREFIX)
  user = await createTestSession(PREFIX)
  other = await createTestSession(PREFIX)
})

afterEach(clearProfiles)

afterAll(async () => {
  await clearProfiles()
  await deleteTestSessions(PREFIX)
  if (savedEncryptionKey === undefined) delete process.env.WP_ENCRYPTION_KEY
  else process.env.WP_ENCRYPTION_KEY = savedEncryptionKey
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

describe("POST /api/profiles", () => {
  it("401s without a session", async () => {
    const response = await post({ name: "Test Blog", website_url: "https://testblog.com" })

    expect(response.status).toBe(401)
    expect(await response.json()).toEqual({ detail: "Not authenticated" })
  })

  it("creates the profile and returns it with a 201", async () => {
    const response = await post(
      {
        name: "Test Blog",
        website_url: "https://testblog.com",
        niche: "technology",
        target_audience: "developers",
        tone: "Professional",
        word_count: 2500,
        output_format: "markdown",
      },
      user.cookie,
    )

    expect(response.status).toBe(201)
    const body = await response.json()
    expect(body.name).toBe("Test Blog")
    expect(body.website_url).toBe("https://testblog.com")
    expect(body.niche).toBe("technology")
    expect(body.word_count).toBe(2500)
    expect(body.crawl_status).toBe("pending")
    expect(body.id).toEqual(expect.any(String))
  })

  it("fills in the ProfileCreate defaults for a minimal body", async () => {
    const response = await post(
      { name: "Minimal", website_url: "https://minimal.com" },
      user.cookie,
    )

    expect(response.status).toBe(201)
    const body = await response.json()
    expect(body.tone).toBe("Conversational and friendly")
    expect(body.word_count).toBe(2000)
    // pydantic's default, not the column's, which is "both".
    expect(body.output_format).toBe("markdown")
    expect(body.wp_default_status).toBe("publish")
    expect(body.default_stage_settings).toEqual({
      research: "auto",
      outline: "auto",
      write: "auto",
      edit: "auto",
      images: "auto",
      ready: "auto",
    })
    expect(body.image_brand_colors).toEqual([])
    expect(body.related_keywords).toEqual([])
    expect(body.niche).toBeNull()
  })

  it("owns the row by the session user, not by anything in the body", async () => {
    const body = await (
      await post(
        { name: "Mine", website_url: "https://mine.com", user_id: other.userId },
        user.cookie,
      )
    ).json()

    expect((await readRow(body.id)).userId).toBe(user.userId)
    expect(await (await getById(body.id, other.cookie)).status).toBe(404)
  })

  it("422s when name is missing", async () => {
    const response = await post({ website_url: "https://example.com" }, user.cookie)

    expect(response.status).toBe(422)
    expect((await response.json()).detail).toContainEqual({
      type: "missing",
      loc: ["body", "name"],
      msg: "Field required",
      // pydantic reported the containing object as the input of a missing key.
      input: { website_url: "https://example.com" },
    })
  })

  it("422s when website_url is missing", async () => {
    const response = await post({ name: "No URL" }, user.cookie)

    expect(response.status).toBe(422)
    expect((await response.json()).detail).toContainEqual({
      type: "missing",
      loc: ["body", "website_url"],
      msg: "Field required",
      input: { name: "No URL" },
    })
  })

  it("422s with pydantic's own error type and message on a bad integer", async () => {
    const response = await post(
      { name: "Bad", website_url: "https://bad.com", word_count: "lots" },
      user.cookie,
    )

    expect(response.status).toBe(422)
    expect((await response.json()).detail).toContainEqual({
      type: "int_parsing",
      loc: ["body", "word_count"],
      msg: "Input should be a valid integer, unable to parse string as an integer",
      input: "lots",
    })
  })

  it("422s with int_type, not int_parsing, when the integer is the wrong type", async () => {
    const response = await post(
      { name: "Bad", website_url: "https://bad.com", word_count: null },
      user.cookie,
    )

    expect(response.status).toBe(422)
    expect((await response.json()).detail).toContainEqual({
      type: "int_type",
      loc: ["body", "word_count"],
      msg: "Input should be a valid integer",
      input: null,
    })
  })

  it("422s with list_type and dict_type for the collection fields", async () => {
    const response = await post(
      {
        name: "Bad",
        website_url: "https://bad.com",
        related_keywords: "no",
        nextjs_frontmatter_map: "{}",
      },
      user.cookie,
    )

    expect(response.status).toBe(422)
    const detail = (await response.json()).detail
    expect(detail).toContainEqual({
      type: "list_type",
      loc: ["body", "related_keywords"],
      msg: "Input should be a valid list",
      input: "no",
    })
    expect(detail).toContainEqual({
      type: "dict_type",
      loc: ["body", "nextjs_frontmatter_map"],
      msg: "Input should be a valid dictionary",
      input: "{}",
    })
  })

  it("coerces an integral string the way pydantic's lax mode did", async () => {
    const response = await post(
      { name: "Coerced", website_url: "https://coerced.com", word_count: " 2500 " },
      user.cookie,
    )

    expect(response.status).toBe(201)
    expect((await response.json()).word_count).toBe(2500)
  })

  it("422s on a body that is not JSON", async () => {
    const response = await post("{not json", user.cookie)

    expect(response.status).toBe(422)
    expect((await response.json()).detail[0]).toMatchObject({
      type: "json_invalid",
      msg: "JSON decode error",
    })
  })

  it("drops unknown fields instead of rejecting them", async () => {
    const response = await post(
      { name: "Extra", website_url: "https://extra.com", not_a_column: "ignored" },
      user.cookie,
    )

    expect(response.status).toBe(201)
    expect(JSON.stringify(await response.json())).not.toContain("ignored")
  })

  it("stores the two credential fields encrypted and never echoes them", async () => {
    const response = await post(
      {
        name: "Secrets",
        website_url: "https://secrets.com",
        wp_app_password: "wp-plaintext-secret",
        nextjs_webhook_secret: "nextjs-plaintext-secret",
      },
      user.cookie,
    )

    expect(response.status).toBe(201)
    const body = await response.json()
    expect(JSON.stringify(body)).not.toContain("plaintext-secret")

    const row = await readRow(body.id)
    expect(row.wpAppPassword).not.toBe("wp-plaintext-secret")
    expect(decryptWithKey(row.wpAppPassword!, TEST_KEY)).toBe("wp-plaintext-secret")
    expect(decryptWithKey(row.nextjsWebhookSecret!, TEST_KEY)).toBe("nextjs-plaintext-secret")
  })

  it("writes an empty credential through rather than encrypting nothing", async () => {
    const body = await (
      await post(
        { name: "Empty", website_url: "https://empty.com", wp_app_password: "" },
        user.cookie,
      )
    ).json()

    expect((await readRow(body.id)).wpAppPassword).toBe("")
  })
})

describe("PATCH /api/profiles/[id]", () => {
  it("401s without a session", async () => {
    const id = await insertProfile(user.userId)

    const response = await patch(id, { name: "Updated" })

    expect(response.status).toBe(401)
    expect(await response.json()).toEqual({ detail: "Not authenticated" })
  })

  it("updates the submitted fields and preserves the rest", async () => {
    const id = await insertProfile(user.userId, { niche: "technology", wordCount: 2500 })

    const response = await patch(id, { name: "Updated Blog", word_count: 3000 }, user.cookie)

    expect(response.status).toBe(200)
    const body = await response.json()
    expect(body.name).toBe("Updated Blog")
    expect(body.word_count).toBe(3000)
    expect(body.niche).toBe("technology")
  })

  it("clears a column when the key is sent as null", async () => {
    const id = await insertProfile(user.userId, { niche: "technology" })

    const body = await (await patch(id, { niche: null }, user.cookie)).json()

    expect(body.niche).toBeNull()
  })

  it("leaves a column alone when its key is absent, matching exclude_unset", async () => {
    const id = await insertProfile(user.userId, { niche: "technology" })

    const body = await (await patch(id, { name: "Renamed" }, user.cookie)).json()

    expect(body.niche).toBe("technology")
  })

  it("returns the row untouched for an empty body", async () => {
    const id = await insertProfile(user.userId, { niche: "technology" })
    const before = await readRow(id)

    const response = await patch(id, {}, user.cookie)

    expect(response.status).toBe(200)
    expect((await response.json()).niche).toBe("technology")
    expect((await readRow(id)).updatedAt).toEqual(before.updatedAt)
  })

  it("re-encrypts a credential on update", async () => {
    const id = await insertProfile(user.userId)

    const response = await patch(id, { wp_app_password: "rotated-secret" }, user.cookie)

    expect(response.status).toBe(200)
    expect(JSON.stringify(await response.json())).not.toContain("rotated-secret")
    expect(decryptWithKey((await readRow(id)).wpAppPassword!, TEST_KEY)).toBe("rotated-secret")
  })

  it("clears a credential sent as null without encrypting it", async () => {
    const id = await insertProfile(user.userId, { wpAppPassword: "existing-ciphertext" })

    await patch(id, { wp_app_password: null }, user.cookie)

    expect((await readRow(id)).wpAppPassword).toBeNull()
  })

  it("accepts the save payload the profile detail page sends", async () => {
    const id = await insertProfile(user.userId)

    // Copied from the `data` object in web/src/app/profiles/[id]/page.tsx, which
    // sends explicit nulls for every cleared field including the two nullable
    // integers, and omits the credentials unless the user typed one.
    const response = await patch(
      id,
      {
        name: "Saved",
        website_url: "https://saved.com",
        niche: null,
        target_audience: null,
        tone: "Professional",
        brand_voice: null,
        word_count: 1800,
        output_format: "markdown",
        image_style: null,
        image_brand_colors: [],
        image_exclude: [],
        avoid: null,
        required_mentions: null,
        related_keywords: ["a", "b"],
        default_stage_settings: { research: "auto", write: "review" },
        recrawl_interval: null,
        wp_url: null,
        wp_username: null,
        wp_default_status: "publish",
        wp_default_category_id: null,
        wp_default_author_id: null,
        nextjs_webhook_url: null,
        nextjs_frontmatter_map: null,
      },
      user.cookie,
    )

    expect(response.status).toBe(200)
    const body = await response.json()
    expect(body.name).toBe("Saved")
    expect(body.word_count).toBe(1800)
    expect(body.related_keywords).toEqual(["a", "b"])
    expect(body.default_stage_settings).toEqual({ research: "auto", write: "review" })
    expect(body.wp_default_author_id).toBeNull()
    expect(body.wp_default_category_id).toBeNull()
  })

  it("404s for an id that does not exist", async () => {
    const response = await patch(
      "00000000-0000-0000-0000-000000000000",
      { name: "Ghost" },
      user.cookie,
    )

    expect(response.status).toBe(404)
    expect(await response.json()).toEqual({ detail: "Profile not found" })
  })

  it("404s for another user's profile and leaves it unchanged", async () => {
    const id = await insertProfile(other.userId, { name: "Not yours" })

    const response = await patch(id, { name: "Hijacked" }, user.cookie)

    expect(response.status).toBe(404)
    expect((await readRow(id)).name).toBe("Not yours")
  })

  it("422s on a malformed uuid", async () => {
    const response = await patch("not-a-uuid", { name: "Ghost" }, user.cookie)

    expect(response.status).toBe(422)
    expect((await response.json()).detail[0]).toMatchObject({ type: "uuid_parsing" })
  })
})

describe("DELETE /api/profiles/[id]", () => {
  it("401s without a session", async () => {
    const id = await insertProfile(user.userId)

    const response = await del(id)

    expect(response.status).toBe(401)
    expect(await response.json()).toEqual({ detail: "Not authenticated" })
  })

  it("deletes the profile and returns 204 with no body", async () => {
    const id = await insertProfile(user.userId)

    const response = await del(id, user.cookie)

    expect(response.status).toBe(204)
    expect(await response.text()).toBe("")
    expect(await (await getById(id, user.cookie)).status).toBe(404)
  })

  it("orphans the profile's posts and deletes its internal links", async () => {
    const id = await insertProfile(user.userId)
    const [post] = await db
      .insert(posts)
      .values({ profileId: id, slug: `${PREFIX}orphan`, topic: "Kept" })
      .returning({ id: posts.id })
    await db.insert(internalLinks).values({ profileId: id, url: "https://testblog.com/a" })

    expect((await del(id, user.cookie)).status).toBe(204)

    const [kept] = await db.select().from(posts).where(eq(posts.id, post.id))
    expect(kept.profileId).toBeNull()
    expect(await db.select().from(internalLinks).where(eq(internalLinks.profileId, id))).toEqual([])
  })

  it("404s for an id that does not exist", async () => {
    const response = await del("00000000-0000-0000-0000-000000000000", user.cookie)

    expect(response.status).toBe(404)
    expect(await response.json()).toEqual({ detail: "Profile not found" })
  })

  it("404s for another user's profile and leaves their posts attached", async () => {
    const id = await insertProfile(other.userId, { name: "Not yours" })
    const [post] = await db
      .insert(posts)
      .values({ profileId: id, slug: `${PREFIX}theirs`, topic: "Theirs" })
      .returning({ id: posts.id })

    const response = await del(id, user.cookie)

    expect(response.status).toBe(404)
    expect(await readRow(id)).toBeDefined()
    const [untouched] = await db.select().from(posts).where(eq(posts.id, post.id))
    expect(untouched.profileId).toBe(id)
  })

  it("422s on a malformed uuid", async () => {
    const response = await del("not-a-uuid", user.cookie)

    expect(response.status).toBe(422)
    expect((await response.json()).detail[0]).toMatchObject({ type: "uuid_parsing" })
  })
})
