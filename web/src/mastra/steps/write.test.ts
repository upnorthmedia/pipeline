// @vitest-environment node
/**
 * Parity for the `write` step (item 3.3).
 *
 * Same gate as `outline`: the fixture's `post_spec` goes into the real
 * Alembic-owned database, the step reads it back through drizzle, and the
 * prompt it hands the agent is compared byte for byte against the fixture's
 * `rendered_prompts[0]`.
 *
 * Two things differ from `outline`'s test. The chain input is the outline, so
 * the post is seeded with both `research_content` and `outline_content` and the
 * `stage_status` the outline stage left behind. And one fixture was captured
 * with a populated internal-link inventory, so this test seeds the profile and
 * the links for real: `build_stage_prompt` offers links to `edit` only, and the
 * captured prompt has no link section despite the links existing, which is a
 * behaviour worth pinning rather than assuming.
 *
 * The provider call is replayed from the fixture; the live Anthropic smoke test
 * and the wire-payload assertions live in `agents/write.test.ts`.
 *
 * Requires `docker compose up -d db redis`.
 */
import { readFileSync } from "node:fs"
import path from "node:path"
import { fileURLToPath } from "node:url"

import { eq, inArray } from "drizzle-orm"
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest"

import { closeDb, getDb, internalLinks, posts, websiteProfiles } from "../../db"
import { stageStepOutputSchema } from "./stage-io"
import { writeStep } from "./write"

const goldenDir = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "../../../../docs/mastra-port/golden",
)

const FIXTURE_SLUGS = [
  "how-to-choose-a-crm-for-a-small-team",
  "best-time-tracking-tools-for-agencies",
] as const

type Fixture = {
  captured_at: string
  post_spec: Record<string, never>
  state_input: {
    research: string
    outline: string
    internal_links: { url: string; title?: string }[]
    stage_status: Record<string, string>
  }
  rendered_prompts: string[]
  provider_calls: {
    request: { model: string }
    response: { usage: { input_tokens: number; output_tokens: number } }
  }[]
  stage_output: {
    draft: string
    current_stage: string
    stage_status: Record<string, string>
    _stage_meta: { model: string; tokens_in: number; tokens_out: number }
  }
}

function loadFixture(slug: string): Fixture {
  return JSON.parse(readFileSync(path.join(goldenDir, slug, "write.json"), "utf8"))
}

const db = getDb()
const fixtures = FIXTURE_SLUGS.map(loadFixture)
/**
 * Every stage's parity test seeds the same golden-fixture posts, so left under
 * the fixture's own id these files collide on the posts primary key whenever
 * vitest runs them in parallel. A post id never reaches a rendered prompt, so
 * each file namespaces its rows by rewriting the fixture id's second-to-last
 * byte, keeping the last one so the two fixtures stay distinct inside the file.
 */
const ID_NAMESPACE = "a3"
const fixtureIds = fixtures.map(
  (f) => String(f.post_spec.id).slice(0, -3) + ID_NAMESPACE + String(f.post_spec.id).slice(-1),
)

/** The profile that owns the seeded internal links. Fixed id so cleanup is exact. */
const PROFILE_ID = "00000000-0000-4000-8000-00000000f003"

/** One replayed provider response, shaped like the agent's `generate` result. */
function replayOf(fixture: Fixture) {
  const call = fixture.provider_calls[0]
  return {
    text: fixture.stage_output.draft,
    response: { modelId: call.request.model },
    usage: {
      inputTokens: call.response.usage.input_tokens,
      outputTokens: call.response.usage.output_tokens,
    },
  }
}

type Replay = ReturnType<typeof replayOf>

/** Records the prompts the step sends and replies with the queued response. */
function replayMastra(reply: Replay) {
  const prompts: string[] = []
  const announced: unknown[] = []
  const mastra = {
    /**
     * The step announces itself on the event bus before it calls its provider
     * (item 5.5a). Stubbed here because this file is about prompt parity;
     * `pipeline-events.test.ts` makes the same call against a real Redis
     * Streams topic and asserts the payload it carries.
     */
    pubsub: {
      publish: async (_topic: string, event: { data: unknown }) => {
        announced.push(event.data)
      },
    },
    getAgent: () => ({
      generate: async (prompt: string) => {
        prompts.push(prompt)
        return reply
      },
    }),
    getLogger: () => undefined,
  }
  return { mastra, prompts, announced }
}

type ExecuteParams = Parameters<typeof writeStep.execute>[0]

async function runStep(postId: string, reply: Replay) {
  const harness = replayMastra(reply)
  const output = await writeStep.execute({
    inputData: { postId },
    mastra: harness.mastra,
  } as unknown as ExecuteParams)
  return { ...harness, output: stageStepOutputSchema.parse(output) }
}

async function insertFixturePosts() {
  await db.insert(websiteProfiles).values({
    id: PROFILE_ID,
    name: "write parity fixture",
    websiteUrl: "https://example.com",
  })

  for (const [index, fixture] of fixtures.entries()) {
    const spec = fixture.post_spec
    const links = fixture.state_input.internal_links
    await db.insert(posts).values({
      id: fixtureIds[index],
      slug: spec.slug,
      // Only the fixture that recorded links is attached to the profile, so the
      // other one still covers the no-links path through `stateFromPost`.
      profileId: links.length > 0 ? PROFILE_ID : null,
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
      // What the two stages before this one committed.
      researchContent: fixture.state_input.research,
      outlineContent: fixture.state_input.outline,
      currentStage: "outline",
      stageSettings: null,
      stageStatus: fixture.state_input.stage_status,
    })

    if (links.length > 0) {
      await db.insert(internalLinks).values(
        links.map((link) => ({
          profileId: PROFILE_ID,
          url: link.url,
          title: link.title ?? null,
        })),
      )
    }
  }
}

async function cleanup() {
  await db.delete(posts).where(inArray(posts.id, fixtureIds))
  // Cascades to `internal_links`.
  await db.delete(websiteProfiles).where(eq(websiteProfiles.id, PROFILE_ID))
}

beforeAll(cleanup)

beforeEach(async () => {
  await cleanup()
  await insertFixturePosts()
  // Only `Date` is faked: the prompt stamps TODAY_DATE from the clock and the
  // fixtures were captured on a fixed day. Timers stay real so the postgres
  // driver's own timeouts still fire.
  vi.useFakeTimers({ toFake: ["Date"], shouldAdvanceTime: true })
})

afterEach(() => {
  vi.useRealTimers()
})

afterAll(async () => {
  await cleanup()
  await closeDb()
})

describe("write step prompt parity", () => {
  for (const [index, slug] of FIXTURE_SLUGS.entries()) {
    it(`sends the prompt the Python stage sent for ${slug}`, async () => {
      const fixture = fixtures[index]
      vi.setSystemTime(new Date(fixture.captured_at))

      const { prompts } = await runStep(fixtureIds[index], replayOf(fixture))

      expect(prompts).toHaveLength(1)
      expect(prompts[0]).toBe(fixture.rendered_prompts[0])
    })
  }

  it("carries the outline the previous stage committed, not the research", async () => {
    const fixture = fixtures[0]
    vi.setSystemTime(new Date(fixture.captured_at))

    const { prompts } = await runStep(fixtureIds[0], replayOf(fixture))

    // `write` chains from `outline`, so the research document is in the table
    // and deliberately absent from the prompt. Asserting both directions is
    // what distinguishes correct chaining from a prompt that happens to match.
    expect(prompts[0]).toContain(fixture.state_input.outline)
    expect(prompts[0]).not.toContain(fixture.state_input.research)
  })

  it("withholds the internal-link inventory even when the post has links", async () => {
    const fixture = fixtures[0]
    vi.setSystemTime(new Date(fixture.captured_at))

    const seeded = await db
      .select({ url: internalLinks.url })
      .from(internalLinks)
      .where(eq(internalLinks.profileId, PROFILE_ID))
    expect(seeded).toHaveLength(fixture.state_input.internal_links.length)
    expect(seeded.length).toBeGreaterThan(0)

    const { prompts } = await runStep(fixtureIds[0], replayOf(fixture))

    // `build_stage_prompt` offers links to `edit` only, and Python captured this
    // fixture with the same three links in state.
    expect(prompts[0]).not.toContain("Available Internal Links")
    for (const link of fixture.state_input.internal_links) {
      expect(prompts[0]).not.toContain(link.url)
    }
  })
})

describe("write step persistence and output", () => {
  it("commits the draft to its column and reports Python's stage meta", async () => {
    const fixture = fixtures[0]
    vi.setSystemTime(new Date(fixture.captured_at))

    const { output } = await runStep(fixtureIds[0], replayOf(fixture))

    expect(output).toMatchObject({
      postId: fixtureIds[0],
      stage: "write",
      model: fixture.stage_output._stage_meta.model,
      tokensIn: fixture.stage_output._stage_meta.tokens_in,
      tokensOut: fixture.stage_output._stage_meta.tokens_out,
    })

    const [row] = await db.select().from(posts).where(eq(posts.id, fixtureIds[0]))
    expect(row.draftContent).toBe(fixture.stage_output.draft)
    expect(row.currentStage).toBe(fixture.stage_output.current_stage)
    // Python merges into the map the previous stages left, so both survive.
    expect(row.stageStatus).toEqual(fixture.stage_output.stage_status)
    // The stages it chains from are untouched, and the ones after it stay empty.
    expect(row.researchContent).toBe(fixture.state_input.research)
    expect(row.outlineContent).toBe(fixture.state_input.outline)
    expect(row.finalMdContent).toBeNull()
  })

  it("fails loudly on a post that does not exist rather than billing a call", async () => {
    const harness = replayMastra(replayOf(fixtures[0]))
    await expect(
      writeStep.execute({
        inputData: { postId: "00000000-0000-4000-8000-0000000000ff" },
        mastra: harness.mastra,
      } as unknown as ExecuteParams),
    ).rejects.toThrow("not found")
    expect(harness.prompts).toEqual([])
  })
})

describe("write step announcement", () => {
  it("announces the stage on the event bus, in Python's payload shape", async () => {
    const { announced } = await runStep(fixtureIds[0], replayOf(fixtures[0]))

    expect(announced).toEqual([
      {
        event: "stage_start",
        post_id: fixtureIds[0],
        stage: "write",
        message: "Starting write...",
      },
      // Python's three `publish_stage_log()` calls from inside the stage
      // node, in the order they were written and between the two
      // announcements the runner made around it.
      {
        event: "log",
        post_id: fixtureIds[0],
        stage: "write",
        level: "info",
        message: "Rules loaded, building prompt...",
        timestamp: expect.any(String),
      },
      {
        event: "log",
        post_id: fixtureIds[0],
        stage: "write",
        level: "info",
        message: "Calling Claude for draft (up to 16k tokens)...",
        timestamp: expect.any(String),
      },
      {
        event: "log",
        post_id: fixtureIds[0],
        stage: "write",
        level: "info",
        message: expect.stringMatching(
          new RegExp(`^Received ${replayOf(fixtures[0]).usage.outputTokens} tokens in \\d+\\.\\ds$`),
        ),
        timestamp: expect.any(String),
      },
      {
        event: "stage_complete",
        post_id: fixtureIds[0],
        stage: "write",
        model: replayOf(fixtures[0]).response.modelId,
        // Real elapsed time around a stubbed provider call; the rounding it
        // goes through is pinned in `pipeline-events.test.ts`.
        duration_s: expect.any(Number),
      },
    ])
  })
})
