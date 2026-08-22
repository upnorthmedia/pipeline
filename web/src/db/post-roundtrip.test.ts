// @vitest-environment node
/**
 * Phase 1 exit criterion: TypeScript reads and writes a Post against the real,
 * Alembic-owned dev database.
 *
 * The point is not that drizzle can run SQL, it is that the column mappings in
 * `schema.ts` survive a write/read cycle: JSONB arrays come back as arrays and
 * not strings, `timestamptz` comes back as a `Date`, and the defaults the
 * database applies (which Python relies on) land on rows TypeScript inserts.
 *
 * Requires `docker compose up -d db redis` plus `alembic upgrade head`. The
 * connection string comes from the repo-root `.env`, loaded by `vitest.config.ts`.
 */
import { eq, sql } from "drizzle-orm"
import { Pool } from "pg"
import { afterAll, beforeAll, describe, expect, it } from "vitest"

import { closeDb, getDb, toNodePostgresUrl } from "./index"
import { posts, websiteProfiles, type NewPost } from "./schema"

/** Everything this test writes carries the prefix so cleanup can never miss a row. */
const SLUG_PREFIX = "ts-roundtrip-"
const slug = `${SLUG_PREFIX}${process.pid}-${Date.now()}`

const db = getDb()

/**
 * A second, independent connection. Reading the row back through it proves the
 * insert committed rather than merely living in drizzle's session, and lets the
 * assertions look at the raw Postgres representation.
 */
const rawPool = new Pool({
  connectionString: toNodePostgresUrl(process.env.DATABASE_URL_SYNC!),
})

let profileId: string

async function cleanup() {
  await db.delete(posts).where(sql`${posts.slug} like ${`${SLUG_PREFIX}%`}`)
  await db.delete(websiteProfiles).where(sql`${websiteProfiles.name} like ${`${SLUG_PREFIX}%`}`)
}

beforeAll(async () => {
  await cleanup()
  const [profile] = await db
    .insert(websiteProfiles)
    .values({
      name: `${SLUG_PREFIX}profile`,
      websiteUrl: "https://example.com",
      sitemapUrls: ["https://example.com/sitemap.xml"],
    })
    .returning()
  profileId = profile.id
})

afterAll(async () => {
  await cleanup()
  await rawPool.end()
  await closeDb()
})

/** Mirrors the shape the Python `posts` router writes on post creation. */
const newPost: NewPost = {
  slug,
  topic: "Round-tripping a Post from TypeScript",
  targetAudience: "Agency owners",
  niche: "Productivity software",
  intent: "informational",
  wordCount: 1800,
  tone: "Conversational and friendly",
  websiteUrl: "https://example.com",
  relatedKeywords: ["time tracking", "agency tools"],
  competitorUrls: ["https://competitor.example/post"],
  imageBrandColors: ["#0f172a", "#38bdf8"],
  imageExclude: ["stock photo people"],
  articleType: "listicle",
  priority: 3,
}

describe("Post round-trip against the dev database", () => {
  it("writes a post and reads back every column family it set", async () => {
    const [inserted] = await db
      .insert(posts)
      .values({ ...newPost, profileId })
      .returning()

    const [read] = await db.select().from(posts).where(eq(posts.id, inserted.id))

    expect(read.slug).toBe(slug)
    expect(read.profileId).toBe(profileId)
    expect(read.topic).toBe(newPost.topic)
    expect(read.wordCount).toBe(1800)
    expect(read.priority).toBe(3)
    // JSONB columns must survive as arrays, not as JSON strings.
    expect(read.relatedKeywords).toEqual(["time tracking", "agency tools"])
    expect(read.competitorUrls).toEqual(["https://competitor.example/post"])
    expect(read.imageBrandColors).toEqual(["#0f172a", "#38bdf8"])
    expect(read.imageExclude).toEqual(["stock photo people"])
    // `mode: "date"` on the timestamptz columns, per iteration 9's schema notes.
    expect(read.createdAt).toBeInstanceOf(Date)
    expect(read.updatedAt).toBeInstanceOf(Date)
    expect(read.completedAt).toBeNull()
  })

  it("picks up the database-side defaults Python relies on", async () => {
    const [read] = await db.select().from(posts).where(eq(posts.slug, slug))

    expect(read.currentStage).toBe("pending")
    expect(read.outputFormat).toBe("both")
    expect(read.stageStatus).toEqual({})
    expect(read.stageLogs).toEqual({})
    expect(read.executionLogs).toEqual([])
    expect(read.stageSettings).toEqual({
      research: "review",
      outline: "review",
      write: "review",
      edit: "review",
      images: "review",
    })
    expect(read.researchContent).toBeNull()
  })

  it("updates a stage content column and its status, the Phase 3 persistence contract", async () => {
    const completedAt = new Date("2026-08-21T12:00:00.000Z")
    await db
      .update(posts)
      .set({
        researchContent: "## Research\n\nFindings.",
        currentStage: "outline",
        stageStatus: { research: "complete", outline: "running" },
        imageManifest: { images: [{ filename: "hero.webp", alt: "Hero" }] },
        completedAt,
      })
      .where(eq(posts.slug, slug))

    const [read] = await db.select().from(posts).where(eq(posts.slug, slug))
    expect(read.researchContent).toBe("## Research\n\nFindings.")
    expect(read.currentStage).toBe("outline")
    expect(read.stageStatus).toEqual({ research: "complete", outline: "running" })
    expect(read.imageManifest).toEqual({ images: [{ filename: "hero.webp", alt: "Hero" }] })
    expect(read.completedAt?.toISOString()).toBe(completedAt.toISOString())
  })

  it("committed the row: a separate connection sees the native Postgres types", async () => {
    const { rows } = await rawPool.query(
      `select jsonb_typeof(related_keywords) as keywords_type,
              jsonb_typeof(stage_status)     as stage_status_type,
              related_keywords ->> 0         as first_keyword,
              pg_typeof(created_at)::text    as created_at_type,
              current_stage
         from posts where slug = $1`,
      [slug],
    )

    expect(rows).toHaveLength(1)
    expect(rows[0].keywords_type).toBe("array")
    expect(rows[0].stage_status_type).toBe("object")
    expect(rows[0].first_keyword).toBe("time tracking")
    expect(rows[0].created_at_type).toBe("timestamp with time zone")
    expect(rows[0].current_stage).toBe("outline")
  })

  it("deletes the post and leaves nothing behind", async () => {
    const deleted = await db.delete(posts).where(eq(posts.slug, slug)).returning({ id: posts.id })
    expect(deleted).toHaveLength(1)

    const remaining = await db.select().from(posts).where(eq(posts.slug, slug))
    expect(remaining).toEqual([])
  })
})
