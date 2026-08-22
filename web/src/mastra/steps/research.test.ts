// @vitest-environment node
/**
 * Parity for the `research` step (item 3.1c-ii).
 *
 * The gate the objective sets is the rendered prompt: the step must send the
 * provider exactly what the Python stage sent, from a post row rather than from
 * a hand-built state object. So the fixture's `post_spec` is inserted into the
 * real Alembic-owned database, the step reads it back through drizzle, and the
 * prompt it hands the agent is compared byte for byte against the fixture's
 * `rendered_prompts[0]`.
 *
 * The provider call itself is replayed from the fixture's recorded response
 * rather than made live: the live Perplexity smoke test lives in
 * `agents/research.test.ts`, and re-billing a 6k-token research call on every
 * `pnpm test` would buy nothing this replay does not already prove. Everything
 * else in the step runs for real, including both database round trips.
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
import {
  MAX_RESEARCH_ATTEMPTS,
  isValidResearch,
  reinforcedPrompt,
  researchStep,
} from "./research"

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
  rendered_prompts: string[]
  provider_calls: {
    request: { model: string }
    response: {
      body: {
        choices: { message: { content: string } }[]
        usage: { prompt_tokens: number; completion_tokens: number }
      }
    }
  }[]
  stage_output: {
    research: string
    current_stage: string
    stage_status: Record<string, string>
    _stage_meta: { model: string; tokens_in: number; tokens_out: number }
  }
}

function loadFixture(slug: string): Fixture {
  return JSON.parse(readFileSync(path.join(goldenDir, slug, "research.json"), "utf8"))
}

const db = getDb()
const fixtures = FIXTURE_SLUGS.map(loadFixture)
const fixtureIds = fixtures.map((f) => String(f.post_spec.id))

/** One replayed provider response, shaped like the agent's `generate` result. */
function replayOf(fixture: Fixture) {
  const call = fixture.provider_calls[0]
  return {
    text: call.response.body.choices[0].message.content,
    response: { modelId: call.request.model },
    usage: {
      inputTokens: call.response.body.usage.prompt_tokens,
      outputTokens: call.response.body.usage.completion_tokens,
    },
  }
}

type Replay = ReturnType<typeof replayOf>

/**
 * A stand-in for the Mastra instance that records the prompts the step sends
 * and replies with the queued responses, the last one repeating.
 *
 * The logger is captured rather than passed through so the degraded-research
 * path can be asserted on instead of printing a warning into the test output.
 */
function replayMastra(replies: Replay[]) {
  const prompts: string[] = []
  const warnings: string[] = []
  const errors: string[] = []
  const mastra = {
    getAgent: () => ({
      generate: async (prompt: string) => {
        prompts.push(prompt)
        return replies[Math.min(prompts.length - 1, replies.length - 1)]
      },
    }),
    getLogger: () => ({
      warn: (message: string) => warnings.push(message),
      error: (message: string) => errors.push(message),
    }),
  }
  return { mastra, prompts, warnings, errors }
}

type ExecuteParams = Parameters<typeof researchStep.execute>[0]

async function runStep(postId: string, replies: Replay[]) {
  const harness = replayMastra(replies)
  const output = await researchStep.execute({
    inputData: { postId },
    mastra: harness.mastra,
  } as unknown as ExecuteParams)
  return { ...harness, output: stageStepOutputSchema.parse(output) }
}

async function insertFixturePosts() {
  for (const fixture of fixtures) {
    const spec = fixture.post_spec
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
      currentStage: null,
      stageSettings: null,
      stageStatus: null,
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
  // Only `Date` is faked: the prompt stamps TODAY_DATE from the clock, and the
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

describe("research step prompt parity", () => {
  for (const [index, slug] of FIXTURE_SLUGS.entries()) {
    it(`sends the prompt the Python stage sent for ${slug}`, async () => {
      const fixture = fixtures[index]
      vi.setSystemTime(new Date(fixture.captured_at))

      const { prompts } = await runStep(fixtureIds[index], [replayOf(fixture)])

      expect(prompts).toHaveLength(1)
      expect(prompts[0]).toBe(fixture.rendered_prompts[0])
    })
  }
})

describe("research step persistence and output", () => {
  it("commits the research to its column and reports Python's stage meta", async () => {
    const fixture = fixtures[0]
    vi.setSystemTime(new Date(fixture.captured_at))

    const { output } = await runStep(fixtureIds[0], [replayOf(fixture)])

    expect(output).toMatchObject({
      postId: fixtureIds[0],
      stage: "research",
      model: fixture.stage_output._stage_meta.model,
      tokensIn: fixture.stage_output._stage_meta.tokens_in,
      tokensOut: fixture.stage_output._stage_meta.tokens_out,
    })

    const [row] = await db.select().from(posts).where(eq(posts.id, fixtureIds[0]))
    expect(row.researchContent).toBe(fixture.stage_output.research)
    expect(row.currentStage).toBe(fixture.stage_output.current_stage)
    expect(row.stageStatus).toEqual(fixture.stage_output.stage_status)
    // Later stages' columns stay untouched, which is what makes a resume safe.
    expect(row.outlineContent).toBeNull()
  })

  it("fails loudly on a post that does not exist rather than billing a call", async () => {
    const harness = replayMastra([replayOf(fixtures[0])])
    await expect(
      researchStep.execute({
        inputData: { postId: "00000000-0000-4000-8000-0000000000ff" },
        mastra: harness.mastra,
      } as unknown as ExecuteParams),
    ).rejects.toThrow("not found")
    expect(harness.prompts).toEqual([])
  })
})

/** Verbatim from `_reinforced_prompt` in `api/src/pipeline/stages/research.py`. */
const PYTHON_RETRY_PREAMBLE =
  "IMPORTANT: You must respond with ONLY the research document content. " +
  "Do NOT describe yourself, your limitations, or ask questions. " +
  "Do NOT say you are Perplexity or a search assistant. " +
  "Simply produce the research document as specified.\n\n"

const REFUSAL: Replay = {
  text: "I'm Perplexity, a search assistant. I need to clarify my role.",
  response: { modelId: "sonar-pro" },
  usage: { inputTokens: 100, outputTokens: 20 },
}

describe("research step meta-response retry loop", () => {
  it("retries a meta-response with the reinforced prompt and sums both calls' tokens", async () => {
    const fixture = fixtures[0]
    vi.setSystemTime(new Date(fixture.captured_at))
    const good = replayOf(fixture)

    const { prompts, output, warnings } = await runStep(fixtureIds[0], [REFUSAL, good])

    expect(prompts).toHaveLength(2)
    // Pinned against the literal from `_reinforced_prompt`, not against
    // `reinforcedPrompt()`, so editing the preamble fails here instead of
    // moving both sides of the comparison together.
    expect(prompts[1]).toBe(PYTHON_RETRY_PREAMBLE + fixture.rendered_prompts[0])
    expect(reinforcedPrompt("x")).toBe(`${PYTHON_RETRY_PREAMBLE}x`)
    expect(output.tokensIn).toBe(REFUSAL.usage.inputTokens + good.usage.inputTokens)
    expect(output.tokensOut).toBe(REFUSAL.usage.outputTokens + good.usage.outputTokens)
    expect(warnings).toHaveLength(1)

    const [row] = await db.select().from(posts).where(eq(posts.id, fixtureIds[0]))
    expect(row.researchContent).toBe(good.text)
  })

  it("stops after the attempt cap and keeps the last response, as Python does", async () => {
    vi.setSystemTime(new Date(fixtures[0].captured_at))

    const { prompts, errors } = await runStep(fixtureIds[0], [REFUSAL])

    expect(prompts).toHaveLength(MAX_RESEARCH_ATTEMPTS)
    expect(errors).toHaveLength(1)

    const [row] = await db.select().from(posts).where(eq(posts.id, fixtureIds[0]))
    expect(row.researchContent).toBe(REFUSAL.text)
    expect(row.currentStage).toBe("research")
  })
})

describe("isValidResearch", () => {
  it("accepts the golden fixtures' research documents", () => {
    for (const fixture of fixtures) {
      expect(isValidResearch(fixture.stage_output.research)).toBe(true)
    }
  })

  it("rejects every refusal phrasing Python listed", () => {
    const refusals = [
      "I'm **Perplexity**, here to help",
      "I am a search assistant, not a writer",
      "I need to clarify my role here",
      "I'm not a blog research agent",
      "I cannot generate that document",
      "What I *can* do instead is search",
      "To move forward, tell me more",
      "Please provide either a topic or a URL",
      "Which would be most helpful?",
    ]
    for (const refusal of refusals) {
      // Each carries enough expected sections to pass the section check, so the
      // rejection can only be coming from the refusal pattern.
      const padded = `${refusal}\n\nkeyword, pain point, competitor, search intent`
      expect(isValidResearch(padded)).toBe(false)
    }
  })

  it("rejects a clean response that covers fewer than two expected sections", () => {
    expect(isValidResearch("# Notes\n\nSome keyword ideas.")).toBe(false)
    expect(isValidResearch("# Notes\n\nkeyword ideas and pain point analysis.")).toBe(true)
  })
})
