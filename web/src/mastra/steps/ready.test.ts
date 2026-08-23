// @vitest-environment node
/**
 * Parity for the `ready` step (item 3.6).
 *
 * Same gate as the other five stages: the fixture's `post_spec` goes into the
 * real Alembic-owned database, the step reads it back through drizzle, and the
 * prompt it hands the agent is compared byte for byte against a prompt Python
 * rendered. The post is seeded with the `final_md` and the `image_manifest` the
 * previous two stages committed, which is exactly what a resumed run would find
 * in the table.
 *
 * Except that for this stage the golden fixture is not the production oracle.
 * `capture_golden.py` threads one in-memory state dict from stage to stage
 * and never touches Postgres, while `_run_pipeline` reloads the post from the
 * database before every stage. The ready prompt embeds the image manifest as
 * pretty-printed JSON, and a `jsonb` column returns object keys sorted by
 * length then bytes, so the two prompts differ in the manifest's key order for
 * both fixtures. The port reads its state from the table, so its oracle is
 * `data/ready-prompt-parity.json`, rendered by the real Python
 * `_build_ready_prompt` over a state built from a real row
 * (`api/scripts/export_ready_prompt_parity.py`). The fixture still gates the
 * builder itself, fed the in-memory manifest the capture harness fed Python.
 *
 * Two more things need an oracle the golden fixtures cannot give:
 *
 *   1. **The generated-images filter.** Both captures ran against an account
 *      with zero image quota, so every manifest entry in both fixtures has
 *      `generated: false` and the filter's only observable effect there is an
 *      empty list. Item 3.5e's parity corpus was produced by the real Python
 *      images stage and carries twelve generated and four failed entries, so it
 *      stands in as the filter's oracle.
 *   2. **The branches Python reaches by raising.** A manifest whose `images` is
 *      not a list, or whose entries are not mappings, raises out of
 *      `_build_ready_prompt` before any call is billed. Those are asserted
 *      directly rather than being left to invent a behaviour.
 *
 * The provider call is replayed from the fixture; the live Anthropic smoke test
 * and the wire-payload assertions live in `agents/ready.test.ts`.
 *
 * Requires `docker compose up -d db redis`.
 */
import { readFileSync } from "node:fs"
import path from "node:path"
import { fileURLToPath } from "node:url"

import { eq, inArray } from "drizzle-orm"
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest"

import { closeDb, getDb, posts } from "../../db"
import generationCorpus from "../images/data/image-generation-parity.json"
import promptCorpus from "./data/ready-prompt-parity.json"
import { loadPipelineState } from "../post-state"
import { loadRules } from "../prompts"
import { stageStepOutputSchema } from "./stage-io"
import { buildReadyPrompt, generatedImages, readyStep } from "./ready"

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
    final_md: string
    image_manifest: Record<string, unknown>
    stage_status: Record<string, string>
  }
  rendered_prompts: string[]
  provider_calls: {
    request: { model: string }
    response: { usage: { input_tokens: number; output_tokens: number } }
  }[]
  stage_output: {
    ready: string
    current_stage: string
    stage_status: Record<string, string>
    _stage_meta: { model: string; tokens_in: number; tokens_out: number }
  }
}

function loadFixture(slug: string): Fixture {
  return JSON.parse(readFileSync(path.join(goldenDir, slug, "ready.json"), "utf8"))
}

const db = getDb()
const fixtures = FIXTURE_SLUGS.map(loadFixture)
/** See `outline.test.ts`: each parity file namespaces its rows to avoid a PK clash. */
const ID_NAMESPACE = "a6"
const fixtureIds = fixtures.map(
  (f) => String(f.post_spec.id).slice(0, -3) + ID_NAMESPACE + String(f.post_spec.id).slice(-1),
)

/** One replayed provider response, shaped like the agent's `generate` result. */
function replayOf(fixture: Fixture) {
  const call = fixture.provider_calls[0]
  return {
    text: fixture.stage_output.ready,
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

type ExecuteParams = Parameters<typeof readyStep.execute>[0]

async function runStep(postId: string, reply: Replay) {
  const harness = replayMastra(reply)
  const output = await readyStep.execute({
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
      // What `edit` and `images` committed before this stage starts.
      finalMdContent: fixture.state_input.final_md,
      imageManifest: fixture.state_input.image_manifest,
      currentStage: "images",
      stageSettings: null,
      stageStatus: fixture.state_input.stage_status,
    })
  }
}

async function cleanup() {
  await db.delete(posts).where(inArray(posts.id, fixtureIds))
}

/** The date the fixture stamped into TODAY_DATE, as the prompt renders it. */
function capturedDate(fixture: Fixture): string {
  return fixture.captured_at.slice(0, 10)
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

/** The prompt the real Python `_build_ready_prompt` rendered off a real row. */
function pythonPrompt(slug: string): string {
  const entry = (promptCorpus.posts as Record<string, { prompt: string }>)[slug]
  if (!entry) throw new Error(`no python prompt corpus entry for ${slug}`)
  return entry.prompt
}

/** The manifest section's JSON body, parsed. */
function manifestJson(prompt: string): Record<string, unknown> {
  const section = prompt.split("\n\n---\n\n").find((s) => s.startsWith("## Image Manifest"))
  if (!section) throw new Error("prompt has no image manifest section")
  const body = section.slice(section.indexOf("```json\n") + "```json\n".length, -"\n```".length)
  return JSON.parse(body)
}

describe("ready step prompt parity", () => {
  for (const [index, slug] of FIXTURE_SLUGS.entries()) {
    it(`sends the prompt the Python worker sends for ${slug}`, async () => {
      // `promptCorpus.today` is the date the export script ran, which is what
      // its `datetime.now(UTC)` stamped into TODAY_DATE.
      vi.setSystemTime(new Date(`${promptCorpus.today}T12:00:00.000Z`))

      const { prompts } = await runStep(fixtureIds[index], replayOf(fixtures[index]))

      expect(prompts).toHaveLength(1)
      expect(prompts[0]).toBe(pythonPrompt(slug))
    })
  }

  for (const [index, slug] of FIXTURE_SLUGS.entries()) {
    it(`renders the golden fixture's prompt byte for byte for ${slug}`, async () => {
      // The builder gate. Fed the manifest in the order `capture_golden.py` fed
      // Python (its own in-memory dict, never through a jsonb column), the
      // builder has to reproduce the captured prompt exactly.
      const fixture = fixtures[index]
      const state = await loadPipelineState(fixtureIds[index])

      const prompt = buildReadyPrompt(
        loadRules("ready"),
        { ...state, imageManifest: fixture.state_input.image_manifest },
        capturedDate(fixture),
      )

      expect(prompt).toBe(fixture.rendered_prompts[0])
    })
  }

  for (const [index, slug] of FIXTURE_SLUGS.entries()) {
    it(`differs from the fixture only in the manifest's key order for ${slug}`, async () => {
      const fixture = fixtures[index]
      const production = pythonPrompt(slug)

      // Both halves of the claim: the bytes really do differ, and the documents
      // really are the same. Without the first assertion this test would still
      // pass if jsonb ever stopped normalising and the divergence vanished, and
      // the comment above `buildReadyPrompt` would quietly become wrong.
      expect(production).not.toBe(fixture.rendered_prompts[0])
      expect(manifestJson(production)).toEqual(manifestJson(fixture.rendered_prompts[0]))
      expect(Object.keys(manifestJson(production))).not.toEqual(
        Object.keys(manifestJson(fixture.rendered_prompts[0])),
      )
      // Postgres sorts jsonb object keys by length, then bytewise.
      const keys = Object.keys(manifestJson(production))
      expect(keys).toEqual([...keys].sort((a, b) => a.length - b.length || (a < b ? -1 : 1)))

      // Everything outside the manifest section is untouched.
      const withoutManifest = (prompt: string) =>
        prompt.split("\n\n---\n\n").filter((s) => !s.startsWith("## Image Manifest"))
      expect(withoutManifest(production)).toEqual(withoutManifest(fixture.rendered_prompts[0]))
    })
  }

  it("carries the edited markdown and the manifest the previous stages committed", async () => {
    const fixture = fixtures[0]
    vi.setSystemTime(new Date(`${promptCorpus.today}T12:00:00.000Z`))

    const { prompts } = await runStep(fixtureIds[0], replayOf(fixture))

    // A prompt that rendered without the chain inputs would still be byte-equal
    // to a corpus entry rendered the same way, so the chaining is asserted
    // directly.
    expect(prompts[0]).toContain(fixture.state_input.final_md)
    expect(prompts[0]).toContain(String(fixture.state_input.image_manifest.post_slug))
  })

  it("renders four sections, and not the thirteen-field shared config block", async () => {
    // `ready_node` is the only stage that does not call `build_stage_prompt`.
    // Its config block is three lines, and there is no `## Previous Stage
    // Output` section: the manifest gets its own heading instead.
    vi.setSystemTime(new Date(`${promptCorpus.today}T12:00:00.000Z`))

    const { prompts } = await runStep(fixtureIds[0], replayOf(fixtures[0]))
    const sections = prompts[0].split("\n\n---\n\n")

    expect(sections).toHaveLength(4)
    expect(sections[1]).toBe(
      "## Post Configuration\n\n- **SLUG**: how-to-choose-a-crm-for-a-small-team\n" +
        "- **OUTPUT_FORMAT**: markdown\n" +
        `- **TODAY_DATE**: ${promptCorpus.today}`,
    )
    expect(sections[2].startsWith("## Final Markdown Content (from edit stage)\n\n")).toBe(true)
    expect(sections[3].startsWith("## Image Manifest (generated images only)\n\n```json\n")).toBe(
      true,
    )
    expect(prompts[0]).not.toContain("## Previous Stage Output")
    expect(prompts[0]).not.toContain("- **BLOG_POST_TOPIC**")
  })

  it("stamps TODAY_DATE from the clock rather than from a fixture", async () => {
    vi.setSystemTime(new Date("2031-04-05T09:00:00.000Z"))

    const { prompts } = await runStep(fixtureIds[0], replayOf(fixtures[0]))

    expect(prompts[0]).toContain("- **TODAY_DATE**: 2031-04-05")
    expect(prompts[0]).not.toBe(pythonPrompt(FIXTURE_SLUGS[0]))
  })
})

describe("ready prompt image manifest filtering", () => {
  /** A state carrying just the fields `_build_ready_prompt` reads. */
  async function stateWithManifest(manifest: Record<string, unknown>) {
    const state = await loadPipelineState(fixtureIds[0])
    return { ...state, imageManifest: manifest }
  }

  function manifestSectionOf(prompt: string): string {
    const sections = prompt.split("\n\n---\n\n")
    const section = sections.find((s) => s.startsWith("## Image Manifest"))
    return section ?? ""
  }

  function manifestJsonOf(prompt: string): Record<string, unknown> {
    const section = manifestSectionOf(prompt)
    const body = section.slice(section.indexOf("```json\n") + "```json\n".length, -"\n```".length)
    return JSON.parse(body)
  }

  it("keeps only the generated entries, per item 3.5e's parity corpus", async () => {
    // Both golden fixtures were captured against an account with zero image
    // quota, so neither exercises a kept entry. This corpus came out of the real
    // Python images stage and has both kinds.
    const corpusImages = generationCorpus.images as Record<string, unknown>[]
    expect(corpusImages.filter((image) => image.generated === true)).toHaveLength(
      generationCorpus.total_generated,
    )
    expect(corpusImages.filter((image) => image.generated === false)).toHaveLength(
      generationCorpus.total_failed,
    )

    const state = await stateWithManifest({ version: "1.0", images: corpusImages, total_failed: 4 })
    const prompt = buildReadyPrompt("", state, "2026-08-22")
    const rendered = manifestJsonOf(prompt)

    expect(rendered.images).toEqual(corpusImages.filter((image) => image.generated === true))
    expect(rendered.images).toHaveLength(generationCorpus.total_generated)
    // Everything but `images` survives untouched, including the failure totals.
    expect(rendered.version).toBe("1.0")
    expect(rendered.total_failed).toBe(4)
  })

  it("leaves `images` where it was in the document rather than moving it to the end", async () => {
    const state = await stateWithManifest({ version: "1.0", images: [], total_generated: 0 })
    const prompt = buildReadyPrompt("", state, "2026-08-22")

    // `{**manifest, "images": ...}` replaces in place, and the prompt is
    // compared byte for byte, so key order is part of the contract.
    expect(Object.keys(manifestJsonOf(prompt))).toEqual(["version", "images", "total_generated"])
  })

  it("omits the whole section for an empty manifest, because `{}` is falsy in Python", async () => {
    const state = await stateWithManifest({})
    const prompt = buildReadyPrompt("", state, "2026-08-22")

    expect(manifestSectionOf(prompt)).toBe("")
    expect(prompt.split("\n\n---\n\n")).toHaveLength(2)
  })

  it("renders an empty list when the manifest has no `images` key at all", async () => {
    const state = await stateWithManifest({ version: "1.0" })
    const prompt = buildReadyPrompt("", state, "2026-08-22")

    expect(manifestJsonOf(prompt)).toEqual({ version: "1.0", images: [] })
  })

  it("keeps a truthy non-boolean `generated`, because Python tests truthiness", async () => {
    const state = await stateWithManifest({
      images: [{ id: "a", generated: "yes" }, { id: "b", generated: 0 }, { id: "c" }],
    })
    const prompt = buildReadyPrompt("", state, "2026-08-22")

    expect(manifestJsonOf(prompt).images).toEqual([{ id: "a", generated: "yes" }])
  })

  it("escapes non-ASCII the way `json.dumps` does, so the two stacks' bytes match", async () => {
    const state = await stateWithManifest({ style_brief: { mood: "café — warm" } })
    const prompt = buildReadyPrompt("", state, "2026-08-22")

    expect(manifestSectionOf(prompt)).toContain('"mood": "caf\\u00e9 \\u2014 warm"')
    expect(manifestSectionOf(prompt)).not.toContain("café")
    // Still valid JSON: the escapes decode back to the original text.
    expect(manifestJsonOf(prompt)).toEqual({
      style_brief: { mood: "café — warm" },
      images: [],
    })
  })

  it("raises rather than guessing when `images` is not a list", async () => {
    const state = await stateWithManifest({ images: null })

    expect(() => buildReadyPrompt("", state, "2026-08-22")).toThrow(/not an array/)
  })

  it("raises rather than guessing when an entry is not a mapping", async () => {
    const state = await stateWithManifest({ images: [{ generated: true }, "featured.png"] })

    expect(() => buildReadyPrompt("", state, "2026-08-22")).toThrow(/entry 1 is not an object/)
  })

  it("filters a bare list the same way, independent of the surrounding document", () => {
    expect(generatedImages([])).toEqual([])
    expect(generatedImages([{ generated: true }, { generated: false }, {}])).toEqual([
      { generated: true },
    ])
  })
})

describe("ready step optional sections", () => {
  it("omits the markdown section for a post the edit stage never wrote", async () => {
    await db
      .update(posts)
      .set({ finalMdContent: "" })
      .where(eq(posts.id, fixtureIds[0]))
    const state = await loadPipelineState(fixtureIds[0])

    const prompt = buildReadyPrompt(loadRules("ready"), state, "2026-08-22")

    expect(prompt).not.toContain("## Final Markdown Content (from edit stage)")
    // Rules, config and manifest survive; only the empty section is dropped.
    expect(prompt.split("\n\n---\n\n")).toHaveLength(3)
  })

  it("renders without the rules file rather than failing the run", async () => {
    const state = await loadPipelineState(fixtureIds[0])

    const prompt = buildReadyPrompt("", state, "2026-08-22")

    expect(prompt.startsWith("## Post Configuration\n\n")).toBe(true)
    expect(prompt.split("\n\n---\n\n")).toHaveLength(3)
  })
})

describe("ready step persistence and output", () => {
  it("commits the article to its column and reports Python's stage meta", async () => {
    const fixture = fixtures[0]
    vi.setSystemTime(new Date(fixture.captured_at))

    const { output } = await runStep(fixtureIds[0], replayOf(fixture))

    expect(output).toMatchObject({
      postId: fixtureIds[0],
      stage: "ready",
      model: fixture.stage_output._stage_meta.model,
      tokensIn: fixture.stage_output._stage_meta.tokens_in,
      tokensOut: fixture.stage_output._stage_meta.tokens_out,
    })

    const [row] = await db.select().from(posts).where(eq(posts.id, fixtureIds[0]))
    expect(row.readyContent).toBe(fixture.stage_output.ready)
    expect(row.currentStage).toBe(fixture.stage_output.current_stage)
    // Python merges into the map the previous stages left, so all five survive.
    expect(row.stageStatus).toEqual(fixture.stage_output.stage_status)
    // The stages it chains from are untouched.
    expect(row.finalMdContent).toBe(fixture.state_input.final_md)
    expect(row.imageManifest).toEqual(fixture.state_input.image_manifest)
  })

  it("reports the model the provider named, not the one the agent requested", async () => {
    // Both fixtures recorded the same id the agent asks for, so fixture equality
    // alone cannot tell a passthrough from a hardcoded constant. A server-side
    // alias can.
    const aliased = { ...replayOf(fixtures[0]), response: { modelId: "claude-opus-4-6-alias" } }

    const { output } = await runStep(fixtureIds[0], aliased)

    expect(output.model).toBe("claude-opus-4-6-alias")
  })

  it("fails loudly on a post that does not exist rather than billing a call", async () => {
    const harness = replayMastra(replayOf(fixtures[0]))
    await expect(
      readyStep.execute({
        inputData: { postId: "00000000-0000-4000-8000-0000000000ff" },
        mastra: harness.mastra,
      } as unknown as ExecuteParams),
    ).rejects.toThrow("not found")
    expect(harness.prompts).toEqual([])
  })
})

describe("ready step announcement", () => {
  it("announces the stage on the event bus, in Python's payload shape", async () => {
    const { announced } = await runStep(fixtureIds[0], replayOf(fixtures[0]))

    expect(announced).toEqual([
      {
        event: "stage_start",
        post_id: fixtureIds[0],
        stage: "ready",
        message: "Starting ready...",
      },
      // Python's three `publish_stage_log()` calls from inside the stage
      // node, in the order they were written and between the two
      // announcements the runner made around it.
      {
        event: "log",
        post_id: fixtureIds[0],
        stage: "ready",
        level: "info",
        message: "Rules loaded, building prompt...",
        timestamp: expect.any(String),
      },
      {
        event: "log",
        post_id: fixtureIds[0],
        stage: "ready",
        level: "info",
        message: "Calling Claude for final assembly...",
        timestamp: expect.any(String),
      },
      {
        event: "log",
        post_id: fixtureIds[0],
        stage: "ready",
        level: "info",
        message: expect.stringMatching(
          new RegExp(
            `^Assembly done \\(${replayOf(fixtures[0]).usage.outputTokens} tokens, \\d+\\.\\ds\\)$`,
          ),
        ),
        timestamp: expect.any(String),
      },
      {
        event: "stage_complete",
        post_id: fixtureIds[0],
        stage: "ready",
        model: replayOf(fixtures[0]).response.modelId,
        // Real elapsed time around a stubbed provider call; the rounding it
        // goes through is pinned in `pipeline-events.test.ts`.
        duration_s: expect.any(Number),
      },
    ])
  })
})
