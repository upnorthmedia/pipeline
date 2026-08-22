// @vitest-environment node
/**
 * Parity for step 1 of the `images` stage (item 3.5f-i).
 *
 * Same gate as the other stage steps: the fixture's `post_spec` goes into the
 * real Alembic-owned database seeded with everything the four earlier stages
 * committed, the step reads it back through drizzle, and the prompt it hands
 * the agent is compared byte for byte against `rendered_prompts[0]`. The
 * fixture records six prompts; the other five are Gemini's and belong to the
 * fan-out step.
 *
 * The manifest half has a second oracle the other stages do not. Python stores
 * `{**image_spec, generated, index, ...}` per entry, so stripping the
 * bookkeeping keys off `stage_output.image_manifest.images` recovers the exact
 * specs Python parsed out of Claude's answer. That is what `images` is
 * compared against, rather than re-running this port's own parser and
 * asserting it agrees with itself.
 *
 * Requires `docker compose up -d db redis`.
 */
import { readFileSync } from "node:fs"
import path from "node:path"
import { fileURLToPath } from "node:url"

import { inArray } from "drizzle-orm"
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest"

import { closeDb, getDb, posts } from "../../db"
import {
  imageManifestSchema,
  imagesManifestOutputSchema,
  imagesManifestStep,
  pythonTruthy,
  rawSnippet,
} from "./images-manifest"

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
    draft: string
    final_md: string
    stage_status: Record<string, string>
  }
  rendered_prompts: string[]
  provider_calls: {
    request: { model: string }
    response: {
      content: ({ type: string } & Record<string, unknown>)[]
      usage: { input_tokens: number; output_tokens: number }
    }
  }[]
  stage_output: {
    image_manifest: Record<string, unknown> & { images: Record<string, unknown>[] }
    _stage_meta: { model: string; tokens_in: number; tokens_out: number }
  }
}

function loadFixture(slug: string): Fixture {
  return JSON.parse(readFileSync(path.join(goldenDir, slug, "images.json"), "utf8"))
}

/** The manifest text `images_node` saw: Python keeps only the `text` blocks. */
function manifestText(fixture: Fixture): string {
  return (fixture.provider_calls[0].response.content ?? [])
    .filter((block) => block.type === "text")
    .map((block) => String(block.text))
    .join("")
}

/**
 * The keys `_generate_one` adds on top of a manifest entry. Removing them from
 * what Python stored leaves the spec it parsed, which is what this step
 * returns.
 */
const BOOKKEEPING_KEYS = ["generated", "index", "size_bytes", "url", "error"] as const

function specOf(stored: Record<string, unknown>): Record<string, unknown> {
  const spec = { ...stored }
  for (const key of BOOKKEEPING_KEYS) delete spec[key]
  return spec
}

const db = getDb()
const fixtures = FIXTURE_SLUGS.map(loadFixture)
/** Namespaced post ids, so this file's rows cannot collide with another suite's. */
const ID_NAMESPACE = "f1"
const fixtureIds = fixtures.map(
  (f) => String(f.post_spec.id).slice(0, -3) + ID_NAMESPACE + String(f.post_spec.id).slice(-1),
)

function replayOf(fixture: Fixture) {
  const call = fixture.provider_calls[0]
  return {
    text: manifestText(fixture),
    response: { modelId: call.request.model },
    usage: {
      inputTokens: call.response.usage.input_tokens,
      outputTokens: call.response.usage.output_tokens,
    },
  }
}

type Replay = ReturnType<typeof replayOf>
type Warning = { message: string; meta: unknown }

/** Records the prompts the step sends and the warnings it logs. */
function replayMastra(reply: Replay) {
  const prompts: string[] = []
  const warnings: Warning[] = []
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
    getLogger: () => ({
      warn: (message: string, meta: unknown) => warnings.push({ message, meta }),
    }),
  }
  return { mastra, prompts, announced, warnings }
}

type ExecuteParams = Parameters<typeof imagesManifestStep.execute>[0]

async function runStep(postId: string, reply: Replay) {
  const harness = replayMastra(reply)
  const output = await imagesManifestStep.execute({
    inputData: { postId },
    mastra: harness.mastra,
  } as unknown as ExecuteParams)
  return { ...harness, output: imagesManifestOutputSchema.parse(output) }
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
      // Everything the four earlier stages committed before this one starts.
      researchContent: fixture.state_input.research,
      outlineContent: fixture.state_input.outline,
      draftContent: fixture.state_input.draft,
      finalMdContent: fixture.state_input.final_md,
      currentStage: "edit",
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
  return () => vi.useRealTimers()
})

afterAll(async () => {
  await cleanup()
  await closeDb()
})

describe("images manifest step prompt parity", () => {
  for (const [index, slug] of FIXTURE_SLUGS.entries()) {
    it(`sends the prompt the Python stage sent for ${slug}`, async () => {
      const fixture = fixtures[index]
      vi.setSystemTime(new Date(fixture.captured_at))

      const { prompts } = await runStep(fixtureIds[index], replayOf(fixture))

      expect(prompts).toHaveLength(1)
      expect(prompts[0]).toBe(fixture.rendered_prompts[0])
    })
  }

  it("makes exactly one provider call and carries the edited article into it", async () => {
    const fixture = fixtures[0]
    vi.setSystemTime(new Date(fixture.captured_at))

    const { prompts } = await runStep(fixtureIds[0], replayOf(fixture))

    // The five Gemini prompts the fixture also recorded belong to the fan-out
    // step, so this step must not have rendered any of them.
    expect(fixture.rendered_prompts).toHaveLength(6)
    expect(prompts).toHaveLength(1)
    // A prompt rendered without the chain input would still match a fixture
    // captured the same way, so the chaining is asserted directly.
    expect(prompts[0]).toContain(fixture.state_input.final_md)
  })
})

describe("images manifest step output", () => {
  for (const [index, slug] of FIXTURE_SLUGS.entries()) {
    it(`recovers the specs Python parsed for ${slug}`, async () => {
      const fixture = fixtures[index]
      vi.setSystemTime(new Date(fixture.captured_at))

      const { output } = await runStep(fixtureIds[index], replayOf(fixture))

      const stored = fixture.stage_output.image_manifest.images
      expect(output.images).toHaveLength(stored.length)
      expect(output.images).toEqual(stored.map(specOf))
      expect(output.parseFailed).toBe(false)
    })

    it(`keeps the manifest's other top-level keys for ${slug}`, async () => {
      const fixture = fixtures[index]
      vi.setSystemTime(new Date(fixture.captured_at))

      const { output } = await runStep(fixtureIds[index], replayOf(fixture))

      // `total_generated` / `total_failed` are written by the assembling step,
      // and `images` is replaced there, so everything else must already match.
      const stored = fixture.stage_output.image_manifest
      for (const [key, value] of Object.entries(stored)) {
        if (key === "images" || key === "total_generated" || key === "total_failed") continue
        expect(output.manifest[key]).toEqual(value)
      }
      expect(Object.keys(output.manifest)).toEqual(
        Object.keys(stored).filter((k) => k !== "total_generated" && k !== "total_failed"),
      )
    })
  }

  it("reports Python's stage meta and the stage start rather than a duration", async () => {
    const fixture = fixtures[0]
    vi.setSystemTime(new Date(fixture.captured_at))

    const { output } = await runStep(fixtureIds[0], replayOf(fixture))

    expect(output).toMatchObject({
      postId: fixtureIds[0],
      model: fixture.stage_output._stage_meta.model,
      tokensIn: fixture.stage_output._stage_meta.tokens_in,
      tokensOut: fixture.stage_output._stage_meta.tokens_out,
    })
    // `StageTimer` wraps the manifest call and every image, so this step can
    // only report where the stage began.
    expect(output.stageStartedAtMs).toBe(new Date(fixture.captured_at).getTime())
    expect(output).not.toHaveProperty("durationS")
  })

  it("writes only the running marker, leaving every content column to the assembling step", async () => {
    const fixture = fixtures[0]
    vi.setSystemTime(new Date(fixture.captured_at))
    const [before] = await db.select().from(posts).where(inArray(posts.id, [fixtureIds[0]]))

    await runStep(fixtureIds[0], replayOf(fixture))

    const [after] = await db.select().from(posts).where(inArray(posts.id, [fixtureIds[0]]))
    // This step used to write nothing at all. Item 5.5a gave it Python's
    // "persist running before the SSE" write, which is the one thing about the
    // row a stage settles on the way in; the manifest itself is still written
    // by `images-assemble` and by nothing else.
    expect(after).toEqual({
      ...before,
      currentStage: "images",
      stageStatus: { ...(before.stageStatus as Record<string, string>), images: "running" },
      updatedAt: new Date(fixture.captured_at),
      // Item 5.5c-i added the row's own record of the same announcement, which
      // Python wrote in the same block as the `"running"` value above. The
      // timestamp is the frozen clock's, in the offset form Python's
      // `isoformat()` produced.
      executionLogs: [
        ...(before.executionLogs ?? []),
        {
          ts: new Date(fixture.captured_at).toISOString().replace("Z", "+00:00"),
          stage: "images",
          level: "info",
          event: "stage_start",
          message: "Starting images...",
        },
      ],
    })
  })

  it("fails loudly on a post that does not exist rather than billing a call", async () => {
    const harness = replayMastra(replayOf(fixtures[0]))
    await expect(
      imagesManifestStep.execute({
        inputData: { postId: "00000000-0000-4000-8000-0000000000ff" },
        mastra: harness.mastra,
      } as unknown as ExecuteParams),
    ).rejects.toThrow("not found")
    expect(harness.prompts).toEqual([])
  })
})

describe("images manifest step parse-failure branch", () => {
  const unparseable = "Here is the manifest you asked for, but I have written it as prose."

  it("stores the synthesised manifest and short-circuits before Gemini", async () => {
    const fixture = fixtures[0]
    vi.setSystemTime(new Date(fixture.captured_at))

    const { output } = await runStep(fixtureIds[0], { ...replayOf(fixture), text: unparseable })

    expect(output.parseFailed).toBe(true)
    // `_parse_manifest`'s own fallback document, carried through untouched.
    expect(output.manifest).toEqual({
      images: [],
      style_brief: {},
      error: "Failed to parse manifest",
    })
    expect(output.images).toEqual([])
    // The Claude call still happened and is still billed.
    expect(output.tokensOut).toBe(fixture.stage_output._stage_meta.tokens_out)
  })

  it("logs the error with Python's 500-character raw snippet", async () => {
    const fixture = fixtures[0]
    vi.setSystemTime(new Date(fixture.captured_at))
    const long = `${"x".repeat(600)} not json`

    const { warnings } = await runStep(fixtureIds[0], { ...replayOf(fixture), text: long })

    expect(warnings).toHaveLength(1)
    expect(warnings[0].message).toBe("Manifest parse failed: Failed to parse manifest")
    expect(warnings[0].meta).toMatchObject({ rawSnippet: "x".repeat(500) })
  })

  it("short-circuits on an error key the model itself wrote", async () => {
    const fixture = fixtures[0]
    vi.setSystemTime(new Date(fixture.captured_at))
    const authored = JSON.stringify({ error: "I cannot make images", images: [{ prompt: "a" }] })

    const { output } = await runStep(fixtureIds[0], { ...replayOf(fixture), text: authored })

    // Python tests the value, not the key, so this is the same branch.
    expect(output.parseFailed).toBe(true)
    expect(output.images).toEqual([])
  })

  it("does not short-circuit on a falsy error value", async () => {
    const fixture = fixtures[0]
    vi.setSystemTime(new Date(fixture.captured_at))
    const falsy = JSON.stringify({ error: "", images: [{ prompt: "a" }] })

    const { output } = await runStep(fixtureIds[0], { ...replayOf(fixture), text: falsy })

    expect(output.parseFailed).toBe(false)
    expect(output.images).toEqual([{ prompt: "a" }])
  })

  it("throws on a manifest that is not a mapping, the way `.get` would", async () => {
    const fixture = fixtures[0]
    vi.setSystemTime(new Date(fixture.captured_at))

    await expect(runStep(fixtureIds[0], { ...replayOf(fixture), text: "[1, 2]" })).rejects.toThrow(
      "not an object",
    )
  })

  it("treats an absent images key as empty and a null one as an error", async () => {
    const fixture = fixtures[0]
    vi.setSystemTime(new Date(fixture.captured_at))

    const absent = await runStep(fixtureIds[0], {
      ...replayOf(fixture),
      text: JSON.stringify({ style_brief: {} }),
    })
    expect(absent.output.images).toEqual([])

    // `dict.get("images", [])` returns `None` for an explicit null and Python
    // then raises out of `len(None)`; this raises out of the output schema.
    await expect(
      runStep(fixtureIds[0], { ...replayOf(fixture), text: JSON.stringify({ images: null }) }),
    ).rejects.toThrow()
  })
})

describe("python primitives", () => {
  it("slices the raw snippet by code point, not UTF-16 unit", () => {
    // Six hundred astral characters: Python's `[:500]` keeps 500 of them.
    const astral = "\u{1F600}".repeat(600)
    expect([...rawSnippet(astral)]).toHaveLength(500)
    expect(rawSnippet("abc")).toBe("abc")
  })

  it("treats empty containers as falsy the way Python does", () => {
    expect(pythonTruthy([])).toBe(false)
    expect(pythonTruthy({})).toBe(false)
    expect(pythonTruthy([0])).toBe(true)
    expect(pythonTruthy({ a: null })).toBe(true)
    expect(pythonTruthy("")).toBe(false)
    expect(pythonTruthy(0)).toBe(false)
    expect(pythonTruthy(false)).toBe(false)
    expect(pythonTruthy(null)).toBe(false)
    expect(pythonTruthy(undefined)).toBe(false)
    expect(pythonTruthy("no")).toBe(true)
  })
})

/**
 * The manifest schema has to survive being serialised, because Mastra publishes
 * a nested workflow's step graph, schemas included, onto the pub/sub topic as
 * JSON when the workflow starts. The recursive `z.lazy` spelling this schema
 * used to have only closed its reference cycle on first use, so the failure
 * appeared on the *second* `images` run in a process and not the first.
 */
describe("the JSON manifest schema", () => {
  it("stays JSON-serialisable after it has been used to parse", () => {
    expect(() => JSON.stringify(imageManifestSchema)).not.toThrow()
    imageManifestSchema.parse({ images: [{ id: "hero", n: 1, ok: true, x: null }] })
    expect(() => JSON.stringify(imageManifestSchema)).not.toThrow()
  })

  it("still admits any document JSON.parse can produce", () => {
    const document = { a: "s", b: 1, c: true, d: null, e: [1, [2, { f: {} }]], g: {} }
    expect(imageManifestSchema.parse(document)).toEqual(document)
  })

  it("still rejects what would corrupt the column", () => {
    expect(imageManifestSchema.safeParse({ a: undefined }).success).toBe(false)
    expect(imageManifestSchema.safeParse({ a: () => 1 }).success).toBe(false)
    expect(imageManifestSchema.safeParse({ a: NaN }).success).toBe(false)
    expect(imageManifestSchema.safeParse({ a: Symbol("s") }).success).toBe(false)

    const cyclic: Record<string, unknown> = {}
    cyclic.self = cyclic
    expect(imageManifestSchema.safeParse(cyclic).success).toBe(false)
    // A value repeated without a cycle is not a cycle.
    const shared = { k: 1 }
    expect(imageManifestSchema.safeParse({ a: shared, b: shared }).success).toBe(true)
  })
})

describe("images step announcement", () => {
  it("announces the stage on the event bus, in Python's payload shape", async () => {
    const { announced } = await runStep(fixtureIds[0], replayOf(fixtures[0]))

    expect(announced).toEqual([
      {
        event: "stage_start",
        post_id: fixtureIds[0],
        stage: "images",
        message: "Starting images...",
      },
    ])
  })
})
