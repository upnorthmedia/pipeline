// @vitest-environment node
/**
 * `POST /api/posts/{post_id}/duplicate` and `POST /api/posts/batch`.
 *
 * Both run against the real database and real BetterAuth sessions, so the
 * `website_profiles.user_id` scoping is exercised for real. The batch enqueue
 * is read back off the real Redis Streams bus rather than asserted against a
 * spy, matching `create.test.ts`.
 *
 * Fixture profiles gate `research` at "review" for the same reason they do
 * there: no worker runs in this file, but other test files start workers on the
 * shared Mastra instance, and a run they pick up would otherwise reach a
 * provider. A gated run suspends before it spends anything. Every test that
 * does not assert on the enqueue skips it outright.
 *
 * Requires `docker compose up -d db redis`.
 */
import { RedisStreamsPubSub } from "@mastra/redis-streams"
import { and, eq, like } from "drizzle-orm"
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest"

import { closeDb, getDb, posts, websiteProfiles } from "@/db"
import { ABSENT_POST_ID } from "@/test/absent-ids"
import { apiRequest, createTestSession, deleteTestSessions, type TestSession } from "@/test/session"

import { POST as batchCreate } from "./batch/route"
import { POST as duplicatePost } from "./[id]/duplicate/route"

const start = vi.hoisted(() => ({ mode: "skip" as "real" | "skip" }))

vi.mock("@/mastra/start-pipeline", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/mastra/start-pipeline")>()
  return {
    startPipeline: async (postId: string) => {
      if (start.mode === "skip") return "not-started"
      return actual.startPipeline(postId)
    },
  }
})

const PREFIX = "posts-dupbatch-test-"
const URL_BASE = "http://test/api/posts"
const MISSING_ID = ABSENT_POST_ID

/** Discard port on loopback: nothing here should ever reach a real site. */
const SITE = "http://127.0.0.1:9/site"

/** `stage_settings` that pause a run at its first stage. */
const GATED_STAGE_SETTINGS = {
  research: "review",
  outline: "auto",
  write: "auto",
  edit: "auto",
  images: "auto",
  ready: "auto",
}

type StartEvent = { type: string; data?: { workflowId?: string; prevResult?: { output?: unknown } } }

const db = getDb()
const observer = new RedisStreamsPubSub({ url: process.env.REDIS_URL! })
const started: StartEvent[] = []

let user: TestSession
let other: TestSession

async function clearFixtures() {
  await db.delete(posts).where(like(posts.slug, `${PREFIX}%`))
  await db.delete(websiteProfiles).where(like(websiteProfiles.userId, `${PREFIX}%`))
}

async function insertProfile(
  userId: string,
  values: Partial<typeof websiteProfiles.$inferInsert> = {},
) {
  const [row] = await db
    .insert(websiteProfiles)
    .values({
      userId,
      name: "Test Blog",
      websiteUrl: SITE,
      defaultStageSettings: GATED_STAGE_SETTINGS,
      ...values,
    })
    .returning()
  return row
}

async function insertPost(values: Partial<typeof posts.$inferInsert> & { slug: string }) {
  const [row] = await db
    .insert(posts)
    .values({ topic: "A topic", ...values })
    .returning()
  return row
}

function duplicate(id: string, cookie?: string) {
  return duplicatePost(apiRequest(`${URL_BASE}/${id}/duplicate`, { cookie, method: "POST" }), {
    params: Promise.resolve({ id }),
  })
}

function batch(body: unknown, cookie?: string) {
  return batchCreate(
    apiRequest(`${URL_BASE}/batch`, {
      cookie,
      method: "POST",
      body: typeof body === "string" ? body : JSON.stringify(body),
    }),
  )
}

function item(slug: string, extra: Record<string, unknown> = {}) {
  return { slug: `${PREFIX}${slug}`, topic: `Topic ${slug}`, ...extra }
}

/** Resolves once a `workflow.start` for `pipeline` carrying `postId` arrives. */
async function waitForStart(postId: string, timeoutMs = 15_000): Promise<StartEvent> {
  const deadline = Date.now() + timeoutMs
  for (;;) {
    const match = started.find(
      (event) =>
        event.data?.workflowId === "pipeline" &&
        (event.data?.prevResult?.output as { postId?: string } | undefined)?.postId === postId,
    )
    if (match) return match
    if (Date.now() > deadline) {
      throw new Error(`no workflow.start for ${postId} within ${timeoutMs}ms`)
    }
    await new Promise((resolve) => setTimeout(resolve, 25))
  }
}

async function countFixturePosts(): Promise<number> {
  const rows = await db.select({ id: posts.id }).from(posts).where(like(posts.slug, `${PREFIX}%`))
  return rows.length
}

beforeAll(async () => {
  // No `group`, so this subscription is its own fan-out consumer group and can
  // never take an event away from a worker.
  await observer.subscribe("workflows", (event: unknown) => {
    started.push(event as StartEvent)
  })
  await clearFixtures()
  await deleteTestSessions(PREFIX)
  user = await createTestSession(PREFIX)
  other = await createTestSession(PREFIX)
})

afterEach(async () => {
  start.mode = "skip"
  started.length = 0
  await clearFixtures()
})

afterAll(async () => {
  await clearFixtures()
  await deleteTestSessions(PREFIX)
  await observer.close()
  await closeDb()
})

// --- POST /api/posts/{post_id}/duplicate ------------------------------------

describe("POST /api/posts/{post_id}/duplicate", () => {
  it("rejects an unauthenticated request", async () => {
    const response = await duplicate(MISSING_ID)
    expect(response.status).toBe(401)
  })

  it("answers a malformed path uuid with FastAPI's 422", async () => {
    const response = await duplicate("not-a-uuid", user.cookie)
    expect(response.status).toBe(422)
    expect(await response.json()).toEqual({
      detail: [
        {
          type: "uuid_parsing",
          loc: ["path", "post_id"],
          msg: "Input should be a valid UUID",
          input: "not-a-uuid",
        },
      ],
    })
  })

  it("answers a post that does not exist with a 404", async () => {
    const response = await duplicate(MISSING_ID, user.cookie)
    expect(response.status).toBe(404)
    expect(await response.json()).toEqual({ detail: "Post not found" })
  })

  it("answers another user's post with the same 404, writing nothing", async () => {
    const profile = await insertProfile(other.userId)
    const original = await insertPost({ slug: `${PREFIX}theirs`, profileId: profile.id })

    const response = await duplicate(original.id, user.cookie)
    expect(response.status).toBe(404)
    expect(await countFixturePosts()).toBe(1)
  })

  it("answers a post with no profile with a 404, because the join is inner", async () => {
    const orphan = await insertPost({ slug: `${PREFIX}orphan`, profileId: null })

    const response = await duplicate(orphan.id, user.cookie)
    expect(response.status).toBe(404)
    expect(await countFixturePosts()).toBe(1)
  })

  it("copies every configuration field in `config_fields`", async () => {
    const profile = await insertProfile(user.userId)
    const original = await insertPost({
      slug: `${PREFIX}source`,
      profileId: profile.id,
      topic: "How to season a cast iron pan",
      targetAudience: "home cooks",
      niche: "cookware",
      intent: "informational",
      wordCount: 1400,
      tone: "Dry and precise",
      outputFormat: "both",
      websiteUrl: SITE,
      relatedKeywords: ["seasoning", "cast iron"],
      competitorUrls: ["http://127.0.0.1:9/rival"],
      imageStyle: "flat illustration",
      imageBrandColors: ["#112233"],
      imageExclude: ["stock photos"],
      brandVoice: "plain",
      avoid: "hype",
      requiredMentions: "our skillet",
      stageSettings: GATED_STAGE_SETTINGS,
    })

    const response = await duplicate(original.id, user.cookie)
    expect(response.status).toBe(201)
    const copy = await response.json()

    const [originalRead] = await db.select().from(posts).where(eq(posts.id, original.id))
    expect(copy.topic).toBe(originalRead.topic)
    expect(copy.niche).toBe(originalRead.niche)
    expect(copy.target_audience).toBe(originalRead.targetAudience)
    expect(copy.word_count).toBe(originalRead.wordCount)
    expect(copy.tone).toBe(originalRead.tone)
    expect(copy.output_format).toBe(originalRead.outputFormat)
    expect(copy.website_url).toBe(originalRead.websiteUrl)
    expect(copy.related_keywords).toEqual(originalRead.relatedKeywords)
    expect(copy.competitor_urls).toEqual(originalRead.competitorUrls)
    expect(copy.image_style).toBe(originalRead.imageStyle)
    expect(copy.image_brand_colors).toEqual(originalRead.imageBrandColors)
    expect(copy.image_exclude).toEqual(originalRead.imageExclude)
    expect(copy.brand_voice).toBe(originalRead.brandVoice)
    expect(copy.avoid).toBe(originalRead.avoid)
    expect(copy.required_mentions).toBe(originalRead.requiredMentions)
    expect(copy.stage_settings).toEqual(originalRead.stageSettings)
    expect(copy.profile_id).toBe(profile.id)
  })

  it("gives the copy a new id and a `-copy-<6 hex>` slug", async () => {
    const profile = await insertProfile(user.userId)
    const original = await insertPost({ slug: `${PREFIX}source`, profileId: profile.id })

    const copy = await (await duplicate(original.id, user.cookie)).json()

    expect(copy.id).not.toBe(original.id)
    expect(copy.slug).not.toBe(original.slug)
    expect(copy.slug).toMatch(new RegExp(`^${PREFIX}source-copy-[0-9a-f]{6}$`))
  })

  it("mints a different suffix on each call", async () => {
    const profile = await insertProfile(user.userId)
    const original = await insertPost({ slug: `${PREFIX}source`, profileId: profile.id })

    const first = await (await duplicate(original.id, user.cookie)).json()
    const second = await (await duplicate(original.id, user.cookie)).json()

    expect(first.slug).not.toBe(second.slug)
  })

  it("leaves stage content, logs and pipeline state behind", async () => {
    const profile = await insertProfile(user.userId)
    const original = await insertPost({
      slug: `${PREFIX}finished`,
      profileId: profile.id,
      researchContent: "Research data here",
      outlineContent: "## Outline",
      draftContent: "draft",
      finalMdContent: "# Final",
      finalHtmlContent: "<h1>Final</h1>",
      readyContent: "# Ready",
      imageManifest: { images: [{ filename: "hero.webp" }] },
      stageLogs: { research: "done" },
      executionLogs: [{ stage: "research" }],
      currentStage: "ready",
      stageStatus: { research: "complete", ready: "complete" },
      priority: 7,
      wpPostId: 42,
      wpPostUrl: "http://127.0.0.1:9/wp/42",
      wpPublishStatus: "published",
      wpCategoryId: 3,
      wpAuthorId: 4,
      nextjsPublishStatus: "published",
      completedAt: new Date(),
    })

    const copy = await (await duplicate(original.id, user.cookie)).json()

    expect(copy.research_content).toBeNull()
    expect(copy.outline_content).toBeNull()
    expect(copy.draft_content).toBeNull()
    expect(copy.final_md_content).toBeNull()
    expect(copy.final_html_content).toBeNull()
    expect(copy.ready_content).toBeNull()
    expect(copy.image_manifest).toBeNull()
    expect(copy.stage_logs).toEqual({})
    expect(copy.execution_logs).toEqual([])
    expect(copy.current_stage).toBe("pending")
    expect(copy.stage_status).toEqual({})
    expect(copy.priority).toBe(0)
    expect(copy.wp_post_id).toBeNull()
    expect(copy.wp_post_url).toBeNull()
    expect(copy.wp_publish_status).toBeNull()
    expect(copy.wp_category_id).toBeNull()
    expect(copy.wp_author_id).toBeNull()
    expect(copy.nextjs_publish_status).toBeNull()
    expect(copy.completed_at).toBeNull()
  })

  it("does not copy `article_type` or `additional_info`, which `config_fields` predates", async () => {
    const profile = await insertProfile(user.userId)
    const original = await insertPost({
      slug: `${PREFIX}typed`,
      profileId: profile.id,
      articleType: "listicle",
      additionalInfo: "mention the warranty",
    })

    const copy = await (await duplicate(original.id, user.cookie)).json()

    expect(copy.article_type).toBeNull()
    expect(copy.additional_info).toBeNull()
  })

  it("starts no pipeline run, unlike every other create path", async () => {
    start.mode = "real"
    const profile = await insertProfile(user.userId)
    const original = await insertPost({ slug: `${PREFIX}source`, profileId: profile.id })

    const copy = await (await duplicate(original.id, user.cookie)).json()

    await new Promise((resolve) => setTimeout(resolve, 500))
    const forCopy = started.filter(
      (event) =>
        (event.data?.prevResult?.output as { postId?: string } | undefined)?.postId === copy.id,
    )
    expect(forCopy).toEqual([])
  })
})

// --- POST /api/posts/batch --------------------------------------------------

describe("POST /api/posts/batch", () => {
  it("rejects an unauthenticated request", async () => {
    const response = await batch([item("a")])
    expect(response.status).toBe(401)
    expect(await countFixturePosts()).toBe(0)
  })

  it("answers an empty list with a 201 and an empty list", async () => {
    const response = await batch([], user.cookie)
    expect(response.status).toBe(201)
    expect(await response.json()).toEqual([])
  })

  it("answers a body that is not a list with pydantic's `list_type`", async () => {
    const response = await batch({ slug: "x", topic: "y" }, user.cookie)
    expect(response.status).toBe(422)
    const body = await response.json()
    expect(body.detail).toHaveLength(1)
    expect(body.detail[0]).toMatchObject({
      type: "list_type",
      loc: ["body"],
      msg: "Input should be a valid list",
    })
  })

  it("answers invalid JSON with FastAPI's `json_invalid`", async () => {
    const response = await batch("{not json", user.cookie)
    expect(response.status).toBe(422)
    expect(await response.json()).toEqual({
      detail: [{ type: "json_invalid", loc: ["body", 0], msg: "JSON decode error", input: {} }],
    })
  })

  it("reports the failing item's index in `loc`", async () => {
    const response = await batch([item("a"), { topic: "no slug" }], user.cookie)
    expect(response.status).toBe(422)
    expect(await response.json()).toEqual({
      detail: [
        {
          type: "missing",
          loc: ["body", 1, "slug"],
          msg: "Field required",
          input: { topic: "no slug" },
        },
      ],
    })
    expect(await countFixturePosts()).toBe(0)
  })

  it("reports every failing item in one response", async () => {
    const response = await batch(
      [{ topic: "no slug" }, item("b", { word_count: "abc" })],
      user.cookie,
    )
    expect(response.status).toBe(422)
    const body = await response.json()
    expect(body.detail.map((entry: { loc: unknown[] }) => entry.loc)).toEqual([
      ["body", 0, "slug"],
      ["body", 1, "word_count"],
    ])
  })

  it("creates every post, in the submitted order", async () => {
    const items = [0, 1, 2, 3, 4].map((i) => item(`n${i}`, { niche: "technology" }))

    const response = await batch(items, user.cookie)
    expect(response.status).toBe(201)
    const created = await response.json()

    expect(created).toHaveLength(5)
    created.forEach((post: Record<string, unknown>, i: number) => {
      expect(post.topic).toBe(`Topic n${i}`)
      expect(post.slug).toBe(`${PREFIX}n${i}`)
      expect(post.niche).toBe("technology")
      expect(typeof post.id).toBe("string")
    })
  })

  it("leaves `current_stage` and `stage_status` at their column defaults", async () => {
    const created = await (await batch([item("a")], user.cookie)).json()

    // `create_post` stamps "research"/{research: "running"} here; `batch` does not.
    expect(created[0].current_stage).toBe("pending")
    expect(created[0].stage_status).toEqual({})
  })

  it("prefills each item from its profile", async () => {
    const profile = await insertProfile(user.userId, {
      niche: "firearms",
      wordCount: 3000,
      tone: "Blunt",
      wpDefaultCategoryId: 9,
    })
    const items = [0, 1, 2].map((i) => item(`p${i}`, { profile_id: profile.id }))

    const created = await (await batch(items, user.cookie)).json()

    expect(created).toHaveLength(3)
    for (const post of created) {
      expect(post.profile_id).toBe(profile.id)
      expect(post.niche).toBe("firearms")
      expect(post.word_count).toBe(3000)
      expect(post.tone).toBe("Blunt")
      expect(post.wp_category_id).toBe(9)
      expect(post.stage_settings).toEqual(GATED_STAGE_SETTINGS)
    }
  })

  it("prefills each item from its own profile when a batch names two", async () => {
    const first = await insertProfile(user.userId, { niche: "firearms" })
    const second = await insertProfile(user.userId, { niche: "cookware" })

    const created = await (
      await batch(
        [item("a", { profile_id: first.id }), item("b", { profile_id: second.id })],
        user.cookie,
      )
    ).json()

    expect(created.map((post: { niche: string }) => post.niche)).toEqual(["firearms", "cookware"])
  })

  it("answers another user's profile with a 404 and writes nothing", async () => {
    const theirs = await insertProfile(other.userId, { niche: "firearms" })

    const response = await batch([item("a"), item("b", { profile_id: theirs.id })], user.cookie)

    expect(response.status).toBe(404)
    expect(await response.json()).toEqual({ detail: "Profile not found" })
    expect(await countFixturePosts()).toBe(0)
  })

  it("answers a profile that does not exist with a 404", async () => {
    const response = await batch([item("a", { profile_id: MISSING_ID })], user.cookie)

    expect(response.status).toBe(404)
    expect(await countFixturePosts()).toBe(0)
  })

  it("rolls the whole batch back when one item violates the slug constraint", async () => {
    const profile = await insertProfile(user.userId)
    const items = [
      item("dup", { profile_id: profile.id }),
      item("other", { profile_id: profile.id }),
      item("dup", { profile_id: profile.id }),
    ]

    // Drizzle wraps the driver error, so the constraint name is on `cause`.
    const rejection = await batch(items, user.cookie).catch((error: unknown) => error)
    expect((rejection as { cause?: { constraint?: string } }).cause?.constraint).toBe(
      "uq_posts_profile_slug",
    )
    expect(await countFixturePosts()).toBe(0)
  })

  it("starts a pipeline run for every created post", async () => {
    start.mode = "real"
    const profile = await insertProfile(user.userId)
    const items = [0, 1].map((i) => item(`e${i}`, { profile_id: profile.id }))

    const created = await (await batch(items, user.cookie)).json()

    for (const post of created) {
      const event = await waitForStart(post.id)
      expect(event.data?.workflowId).toBe("pipeline")
    }
  })

  it("scopes the created posts to the caller", async () => {
    const profile = await insertProfile(user.userId)
    await batch([item("a", { profile_id: profile.id })], user.cookie)

    const mine = await db
      .select({ id: posts.id })
      .from(posts)
      .innerJoin(websiteProfiles, eq(posts.profileId, websiteProfiles.id))
      .where(and(like(posts.slug, `${PREFIX}%`), eq(websiteProfiles.userId, user.userId)))

    expect(mine).toHaveLength(1)
  })
})
