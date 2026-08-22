// @vitest-environment node
/**
 * Parity for the posts-table bridge: `stateFromPost` must produce exactly the
 * state Python's `state_from_post()` produced, and `saveStageOutput` must leave
 * the row in exactly the shape Python's `save_stage_output()` left it in.
 *
 * The oracle for the read half is the golden fixtures' `state_input` block,
 * which is a verbatim dump of the state the Python pipeline actually ran on.
 * Rows are inserted into the real Alembic-owned dev database, so the assertions
 * cover the drizzle column mappings and the database's own defaults, not a
 * hand-built object.
 *
 * Requires `docker compose up -d db redis` plus `alembic upgrade head`.
 */
import { readFileSync } from "node:fs"
import path from "node:path"
import { fileURLToPath } from "node:url"

import { eq, inArray } from "drizzle-orm"
import { afterAll, beforeAll, describe, expect, it } from "vitest"

import { closeDb, getDb, posts } from "../db"
import { saveStageOutput, stateFromPost } from "./post-state"

const goldenDir = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "../../../docs/mastra-port/golden",
)

const FIXTURE_SLUGS = [
  "how-to-choose-a-crm-for-a-small-team",
  "best-time-tracking-tools-for-agencies",
] as const

type Fixture = {
  post_spec: Record<string, unknown>
  state_input: Record<string, unknown>
}

function loadFixture(slug: string): Fixture {
  return JSON.parse(readFileSync(path.join(goldenDir, slug, "research.json"), "utf8"))
}

/**
 * The fixtures are Python-side dumps, so their keys are snake_case. Converting
 * generically rather than listing the pairs keeps the assertion exhaustive: a
 * field this port forgot to map shows up as a missing key rather than being
 * quietly excluded from the comparison.
 */
function camelizeKeys(value: Record<string, unknown>): Record<string, unknown> {
  return Object.fromEntries(
    Object.entries(value).map(([key, v]) => [
      key.replace(/_([a-z])/g, (_, c: string) => c.toUpperCase()),
      v,
    ]),
  )
}

/** The state Python ran on, minus the credential bag this port keeps out of state. */
function expectedState(fixture: Fixture): Record<string, unknown> {
  const rest = { ...fixture.state_input }
  delete rest.api_keys
  return camelizeKeys(rest)
}

const db = getDb()
const fixtures = FIXTURE_SLUGS.map(loadFixture)
const fixtureIds = fixtures.map((f) => String(f.post_spec.id))

async function cleanup() {
  await db.delete(posts).where(inArray(posts.id, fixtureIds))
}

beforeAll(async () => {
  await cleanup()
  for (const fixture of fixtures) {
    const spec = fixture.post_spec as Record<string, never>
    await db.insert(posts).values({
      id: spec.id,
      slug: spec.slug,
      topic: spec.topic,
      targetAudience: spec.target_audience,
      niche: spec.niche,
      intent: spec.intent,
      articleType: spec.article_type,
      outputFormat: spec.output_format,
      wordCount: spec.word_count,
      tone: spec.tone,
      websiteUrl: spec.website_url,
      relatedKeywords: spec.related_keywords,
      competitorUrls: spec.competitor_urls,
      imageStyle: spec.image_style,
      imageBrandColors: spec.image_brand_colors,
      imageExclude: spec.image_exclude,
      brandVoice: spec.brand_voice,
      avoid: spec.avoid,
      requiredMentions: spec.required_mentions,
      additionalInfo: spec.additional_info,
      // Left NULL on purpose so the read exercises the coalescing branches.
      // The fixture's values for these came from the SQLAlchemy model defaults,
      // which are the same values `stateFromPost` falls back to.
      currentStage: null,
      stageSettings: null,
      stageStatus: null,
    })
  }
})

afterAll(async () => {
  await cleanup()
  await closeDb()
})

describe("stateFromPost", () => {
  for (const [index, slug] of FIXTURE_SLUGS.entries()) {
    it(`rebuilds the state Python ran on for ${slug}`, async () => {
      const fixture = fixtures[index]
      const [row] = await db.select().from(posts).where(eq(posts.id, fixtureIds[index]))

      // The row really did come back with the nullable columns null, so the
      // fallbacks below are exercised rather than shadowed by a stored value.
      expect(row.stageSettings).toBeNull()
      expect(row.researchContent).toBeNull()

      const links = (fixture.post_spec.internal_links ?? []) as { url: string }[]
      expect(stateFromPost(row, links)).toEqual(expectedState(fixture))
    })
  }

  it("coalesces a zero word count to Python's 2000, not to zero", async () => {
    const [row] = await db.select().from(posts).where(eq(posts.id, fixtureIds[0]))
    expect(stateFromPost({ ...row, wordCount: 0 }).wordCount).toBe(2000)
  })
})

describe("saveStageOutput", () => {
  it("commits text output to the stage's column and advances current_stage", async () => {
    const id = fixtureIds[0]
    const [before] = await db.select().from(posts).where(eq(posts.id, id))

    await saveStageOutput(id, "research", "# Research\n\nkeyword findings", {
      research: "complete",
    })

    const [after] = await db.select().from(posts).where(eq(posts.id, id))
    expect(after.researchContent).toBe("# Research\n\nkeyword findings")
    expect(after.currentStage).toBe("research")
    expect(after.stageStatus).toEqual({ research: "complete" })
    // SQLAlchemy's onupdate stamped this on every Python write.
    expect(after.updatedAt!.getTime()).toBeGreaterThan(before.updatedAt!.getTime())
    // Other stages' columns are untouched, which is what makes a resume safe.
    expect(after.outlineContent).toBeNull()
  })

  it("commits the image manifest object to the JSONB column", async () => {
    const id = fixtureIds[1]
    const manifest = { images: [{ filename: "hero.png", alt: "Hero" }] }

    await saveStageOutput(id, "images", manifest)

    const [after] = await db.select().from(posts).where(eq(posts.id, id))
    expect(after.imageManifest).toEqual(manifest)
    expect(after.currentStage).toBe("images")
    // stage_status was not passed, so the stored value is left alone.
    expect(after.stageStatus).toBeNull()
  })

  it("round-trips through stateFromPost so a resumed run sees the saved stage", async () => {
    const id = fixtureIds[0]
    await saveStageOutput(id, "outline", "## Outline", { research: "complete", outline: "complete" })

    const [row] = await db.select().from(posts).where(eq(posts.id, id))
    const state = stateFromPost(row)
    expect(state.outline).toBe("## Outline")
    expect(state.currentStage).toBe("outline")
    expect(state.stageStatus).toEqual({ research: "complete", outline: "complete" })
  })
})
