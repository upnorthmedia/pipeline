// @vitest-environment node
/**
 * Parity for the `outline` step (item 3.2).
 *
 * Same gate as `research`: the fixture's `post_spec` goes into the real
 * Alembic-owned database, the step reads it back through drizzle, and the
 * prompt it hands the agent is compared byte for byte against the fixture's
 * `rendered_prompts[0]`.
 *
 * The difference from `research` is the chain input. `outline`'s prompt embeds
 * the research document, so the post is seeded with the fixture's
 * `state_input.research` in `research_content` and with the `stage_status` the
 * research stage left behind. That is exactly what a resumed run would find in
 * the table, so the seeding is the contract under test rather than a shortcut
 * around it.
 *
 * The provider call is replayed from the fixture; the live Anthropic smoke test
 * and the wire-payload assertions live in `agents/outline.test.ts`.
 *
 * Requires `docker compose up -d db redis`.
 */
import { readFileSync } from "node:fs"
import path from "node:path"
import { fileURLToPath } from "node:url"

import { eq, inArray } from "drizzle-orm"
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest"

import { closeDb, getDb, posts } from "../../db"
import { stageStepOutputSchema } from "./stage-io"
import { outlineStep } from "./outline"

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
  state_input: { research: string; stage_status: Record<string, string> }
  rendered_prompts: string[]
  provider_calls: {
    request: { model: string }
    response: { usage: { input_tokens: number; output_tokens: number } }
  }[]
  stage_output: {
    outline: string
    current_stage: string
    stage_status: Record<string, string>
    _stage_meta: { model: string; tokens_in: number; tokens_out: number }
  }
}

function loadFixture(slug: string): Fixture {
  return JSON.parse(readFileSync(path.join(goldenDir, slug, "outline.json"), "utf8"))
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
const ID_NAMESPACE = "a2"
const fixtureIds = fixtures.map(
  (f) => String(f.post_spec.id).slice(0, -3) + ID_NAMESPACE + String(f.post_spec.id).slice(-1),
)

/** One replayed provider response, shaped like the agent's `generate` result. */
function replayOf(fixture: Fixture) {
  const call = fixture.provider_calls[0]
  return {
    text: fixture.stage_output.outline,
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
  const mastra = {
    getAgent: () => ({
      generate: async (prompt: string) => {
        prompts.push(prompt)
        return reply
      },
    }),
    getLogger: () => undefined,
  }
  return { mastra, prompts }
}

type ExecuteParams = Parameters<typeof outlineStep.execute>[0]

async function runStep(postId: string, reply: Replay) {
  const harness = replayMastra(reply)
  const output = await outlineStep.execute({
    inputData: { postId },
    mastra: harness.mastra,
  } as unknown as ExecuteParams)
  return { ...harness, output: stageStepOutputSchema.parse(output) }
}

async function insertFixturePosts() {
  for (const [index, fixture] of fixtures.entries()) {
    const spec = fixture.post_spec
    await db.insert(posts).values({
      id: fixtureIds[index],
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
      // What the research stage committed before this one starts.
      researchContent: fixture.state_input.research,
      currentStage: "research",
      stageSettings: null,
      stageStatus: fixture.state_input.stage_status,
    })
  }
}

async function cleanup() {
  await db.delete(posts).where(inArray(posts.id, fixtureIds))
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

describe("outline step prompt parity", () => {
  for (const [index, slug] of FIXTURE_SLUGS.entries()) {
    it(`sends the prompt the Python stage sent for ${slug}`, async () => {
      const fixture = fixtures[index]
      vi.setSystemTime(new Date(fixture.captured_at))

      const { prompts } = await runStep(fixtureIds[index], replayOf(fixture))

      expect(prompts).toHaveLength(1)
      expect(prompts[0]).toBe(fixture.rendered_prompts[0])
    })
  }

  it("carries the research document the previous stage committed", async () => {
    const fixture = fixtures[0]
    vi.setSystemTime(new Date(fixture.captured_at))

    const { prompts } = await runStep(fixtureIds[0], replayOf(fixture))

    // A prompt that rendered without the chain input would still be byte-equal
    // to a fixture captured the same way, so the chaining is asserted directly.
    expect(prompts[0]).toContain(fixture.state_input.research)
  })
})

describe("outline step persistence and output", () => {
  it("commits the outline to its column and reports Python's stage meta", async () => {
    const fixture = fixtures[0]
    vi.setSystemTime(new Date(fixture.captured_at))

    const { output } = await runStep(fixtureIds[0], replayOf(fixture))

    expect(output).toMatchObject({
      postId: fixtureIds[0],
      stage: "outline",
      model: fixture.stage_output._stage_meta.model,
      tokensIn: fixture.stage_output._stage_meta.tokens_in,
      tokensOut: fixture.stage_output._stage_meta.tokens_out,
    })

    const [row] = await db.select().from(posts).where(eq(posts.id, fixtureIds[0]))
    expect(row.outlineContent).toBe(fixture.stage_output.outline)
    expect(row.currentStage).toBe(fixture.stage_output.current_stage)
    // Python merges into the map the previous stage left, so `research` survives.
    expect(row.stageStatus).toEqual(fixture.stage_output.stage_status)
    // The stage it chains from is untouched, and the ones after it stay empty.
    expect(row.researchContent).toBe(fixture.state_input.research)
    expect(row.draftContent).toBeNull()
  })

  it("fails loudly on a post that does not exist rather than billing a call", async () => {
    const harness = replayMastra(replayOf(fixtures[0]))
    await expect(
      outlineStep.execute({
        inputData: { postId: "00000000-0000-4000-8000-0000000000ff" },
        mastra: harness.mastra,
      } as unknown as ExecuteParams),
    ).rejects.toThrow("not found")
    expect(harness.prompts).toEqual([])
  })
})
