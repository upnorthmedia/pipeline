// @vitest-environment node
/**
 * `GET /api/posts/{post_id}/export/markdown` and `/export/html`, plus the
 * `stripLeadingH1` port they share with `/export/all`.
 *
 * The transformation half replays `data/strip-leading-h1-parity.json`, which
 * `api/scripts/export_strip_leading_h1_parity.py` produced by running the real
 * Python helper. The endpoint half runs against the real database and real
 * BetterAuth sessions, so the `website_profiles.user_id` scoping is exercised
 * for real. Neither endpoint enqueues anything, so no bus subscription is
 * needed here.
 *
 * Requires `docker compose up -d db`.
 */
import { randomUUID } from "node:crypto"

import { like } from "drizzle-orm"
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest"

import { closeDb, getDb, posts, websiteProfiles } from "@/db"
import { apiRequest, createTestSession, deleteTestSessions, type TestSession } from "@/test/session"

import { GET as exportHtml } from "./[id]/export/html/route"
import { GET as exportMarkdown } from "./[id]/export/markdown/route"
import parity from "./data/strip-leading-h1-parity.json"
import { rewriteMediaUrls, stripLeadingH1 } from "./export-content"

const PREFIX = "posts-export-test-"
const URL_BASE = "http://test/api/posts"
const MISSING_ID = "00000000-0000-4000-8000-000000000000"

/** Discard port on loopback: nothing here should ever reach a real site. */
const SITE = "http://127.0.0.1:9/site"

const db = getDb()

let user: TestSession
let other: TestSession

async function clearFixtures() {
  await db.delete(posts).where(like(posts.slug, `${PREFIX}%`))
  await db.delete(websiteProfiles).where(like(websiteProfiles.userId, `${PREFIX}%`))
}

async function insertProfile(userId: string) {
  const [row] = await db
    .insert(websiteProfiles)
    .values({ userId, name: "Test Blog", websiteUrl: SITE })
    .returning()
  return row
}

async function insertPost(
  userId: string | null,
  values: Partial<typeof posts.$inferInsert> = {},
): Promise<typeof posts.$inferSelect> {
  const profileId = userId === null ? null : (await insertProfile(userId)).id
  const [row] = await db
    .insert(posts)
    .values({
      slug: `${PREFIX}${randomUUID()}`,
      topic: "A topic",
      profileId,
      ...values,
    })
    .returning()
  return row
}

function markdown(id: string, cookie?: string) {
  return exportMarkdown(apiRequest(`${URL_BASE}/${id}/export/markdown`, { cookie }), {
    params: Promise.resolve({ id }),
  })
}

function html(id: string, cookie?: string) {
  return exportHtml(apiRequest(`${URL_BASE}/${id}/export/html`, { cookie }), {
    params: Promise.resolve({ id }),
  })
}

beforeAll(async () => {
  await clearFixtures()
  await deleteTestSessions(PREFIX)
  user = await createTestSession(PREFIX)
  other = await createTestSession(PREFIX)
})

afterEach(clearFixtures)

afterAll(async () => {
  await clearFixtures()
  await deleteTestSessions(PREFIX)
  await closeDb()
})

describe("stripLeadingH1 against the Python oracle", () => {
  it("covers both outcomes, so a no-op implementation cannot pass", () => {
    const changed = parity.filter((row) => row.input !== row.output)
    expect(changed.length).toBeGreaterThan(0)
    expect(parity.length - changed.length).toBeGreaterThan(0)
  })

  for (const row of parity) {
    it(`matches Python: ${row.name}`, () => {
      expect(stripLeadingH1(row.input)).toBe(row.output)
    })
  }
})

describe("rewriteMediaUrls", () => {
  const id = "AAAAAAAA-1111-4111-8111-AAAAAAAAAAAA"

  it("rewrites every occurrence, not just the first", () => {
    const body = `![a](/media/${id.toLowerCase()}/a.webp) ![b](/media/${id.toLowerCase()}/b.webp)`
    expect(rewriteMediaUrls(body, id.toLowerCase())).toBe("![a](/a.webp) ![b](/b.webp)")
  })

  it("lowercases the id, because FastAPI handed the handler a parsed UUID", () => {
    const body = `![a](/media/${id.toLowerCase()}/a.webp)`
    expect(rewriteMediaUrls(body, id)).toBe("![a](/a.webp)")
  })

  it("leaves another post's media directory alone", () => {
    const body = `![a](/media/${MISSING_ID}/a.webp)`
    expect(rewriteMediaUrls(body, id)).toBe(body)
  })
})

describe("GET /api/posts/{post_id}/export/markdown", () => {
  it("401s without a session", async () => {
    const post = await insertPost(user.userId, { readyContent: "x" })
    expect((await markdown(post.id)).status).toBe(401)
  })

  it("422s on a malformed uuid", async () => {
    const response = await markdown("not-a-uuid", user.cookie)
    expect(response.status).toBe(422)
    expect((await response.json()).detail[0]).toMatchObject({
      type: "uuid_parsing",
      loc: ["path", "post_id"],
    })
  })

  it("404s on a post that does not exist", async () => {
    const response = await markdown(MISSING_ID, user.cookie)
    expect(response.status).toBe(404)
    expect(await response.json()).toEqual({ detail: "Post not found" })
  })

  it("404s on another user's post, with the same body as a missing one", async () => {
    const post = await insertPost(other.userId, { readyContent: "secret" })
    const response = await markdown(post.id, user.cookie)
    expect(response.status).toBe(404)
    expect(await response.json()).toEqual({ detail: "Post not found" })
  })

  it("404s on a post with no profile, because the ownership join is inner", async () => {
    const post = await insertPost(null, { readyContent: "orphan" })
    expect((await markdown(post.id, user.cookie)).status).toBe(404)
  })

  it("404s with its own detail when neither content column holds anything", async () => {
    const post = await insertPost(user.userId)
    const response = await markdown(post.id, user.cookie)
    expect(response.status).toBe(404)
    expect(await response.json()).toEqual({ detail: "No markdown content available" })
  })

  it("prefers ready_content over final_md_content", async () => {
    const post = await insertPost(user.userId, {
      readyContent: "ready body",
      finalMdContent: "edited body",
    })
    expect(await (await markdown(post.id, user.cookie)).text()).toBe("ready body")
  })

  it("falls through to final_md_content when ready_content is empty, matching `or`", async () => {
    const post = await insertPost(user.userId, { readyContent: "", finalMdContent: "edited body" })
    expect(await (await markdown(post.id, user.cookie)).text()).toBe("edited body")
  })

  it("serves the body as a .mdx attachment named after the slug", async () => {
    const post = await insertPost(user.userId, { readyContent: "body" })
    const response = await markdown(post.id, user.cookie)
    expect(response.status).toBe(200)
    expect(response.headers.get("content-type")).toBe("text/markdown; charset=utf-8")
    expect(response.headers.get("content-disposition")).toBe(
      `attachment; filename="${post.slug}.mdx"`,
    )
  })

  it("strips the duplicated H1 and rewrites every media URL", async () => {
    const post = await insertPost(user.userId)
    const content = [
      "---",
      "title: Hello",
      "---",
      "# Hello",
      "",
      `![a](/media/${post.id}/a.webp)`,
      `![b](/media/${post.id}/b.webp)`,
      "",
    ].join("\n")
    await db.update(posts).set({ readyContent: content }).where(like(posts.slug, post.slug))

    expect(await (await markdown(post.id, user.cookie)).text()).toBe(
      ["---", "title: Hello", "---", "", "![a](/a.webp)", "![b](/b.webp)", ""].join("\n"),
    )
  })

  it("rewrites media URLs for an uppercase id in the path", async () => {
    const post = await insertPost(user.userId, {})
    await db
      .update(posts)
      .set({ readyContent: `![a](/media/${post.id}/a.webp)` })
      .where(like(posts.slug, post.slug))

    const response = await markdown(post.id.toUpperCase(), user.cookie)
    expect(await response.text()).toBe("![a](/a.webp)")
  })
})

describe("GET /api/posts/{post_id}/export/html", () => {
  it("401s without a session", async () => {
    const post = await insertPost(user.userId, { finalHtmlContent: "<p>x</p>" })
    expect((await html(post.id)).status).toBe(401)
  })

  it("422s on a malformed uuid", async () => {
    expect((await html("not-a-uuid", user.cookie)).status).toBe(422)
  })

  it("404s on another user's post, with the same body as a missing one", async () => {
    const post = await insertPost(other.userId, { finalHtmlContent: "<p>secret</p>" })
    const response = await html(post.id, user.cookie)
    expect(response.status).toBe(404)
    expect(await response.json()).toEqual({ detail: "Post not found" })
  })

  it("404s with its own detail when final_html_content is empty", async () => {
    const post = await insertPost(user.userId, { finalHtmlContent: "" })
    const response = await html(post.id, user.cookie)
    expect(response.status).toBe(404)
    expect(await response.json()).toEqual({ detail: "No HTML content available" })
  })

  it("ignores ready_content: the HTML export reads one column only", async () => {
    const post = await insertPost(user.userId, { readyContent: "# markdown" })
    expect((await html(post.id, user.cookie)).status).toBe(404)
  })

  it("serves the body as an .html attachment named after the slug", async () => {
    const post = await insertPost(user.userId, { finalHtmlContent: "<p>body</p>" })
    const response = await html(post.id, user.cookie)
    expect(response.status).toBe(200)
    expect(response.headers.get("content-type")).toBe("text/html; charset=utf-8")
    expect(response.headers.get("content-disposition")).toBe(
      `attachment; filename="${post.slug}.html"`,
    )
    expect(await response.text()).toBe("<p>body</p>")
  })

  it("applies no H1 strip and no media rewrite, unlike the markdown export", async () => {
    const post = await insertPost(user.userId)
    const content = `---\ntitle: Hello\n---\n# Hello\n\n<img src="/media/${post.id}/a.webp">\n`
    await db.update(posts).set({ finalHtmlContent: content }).where(like(posts.slug, post.slug))

    expect(await (await html(post.id, user.cookie)).text()).toBe(content)
  })
})
