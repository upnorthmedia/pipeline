// @vitest-environment node
/**
 * Parity for the `edit` step (item 3.4e).
 *
 * The prompt gate is the same as the three stages before it: the fixture's
 * `post_spec` goes into the real Alembic-owned database, the step reads it back
 * through drizzle, and the prompt it hands the agent is compared byte for byte
 * against the fixture's `rendered_prompts[0]`. What is new is that roughly a
 * kilobyte of that prompt is *computed* rather than copied out of a column: the
 * analytics section is `compute_analytics` over the committed draft, so this is
 * the first stage where a prompt match also proves the analytics port.
 *
 * Both fixtures are load-bearing here and in different ways. One has three
 * internal links (which `edit`, uniquely, is offered) and a keyword density of
 * exactly zero, which is the `str(float)` case JavaScript renders differently.
 * The other has a Flesch score under 55, which is the only fixture that reaches
 * the SIMPLIFY branch of the ACTION REQUIRED block.
 *
 * The provider call is replayed from the fixture; the live Anthropic smoke test
 * and the wire-payload assertions live in `agents/edit.test.ts`. Link
 * validation is a network call, so the prompt tests stub it and one separate
 * test drives the real implementation over real sockets against a local server.
 *
 * Requires `docker compose up -d db redis`.
 */
import { createServer, type Server } from "node:http"
import type { AddressInfo } from "node:net"
import { readFileSync } from "node:fs"
import path from "node:path"
import { fileURLToPath } from "node:url"

import { eq, inArray } from "drizzle-orm"
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest"

import { closeDb, getDb, internalLinks, posts, websiteProfiles } from "../../db"
import type { ValidationResult } from "../links"
import { loadPipelineState } from "../post-state"
import { buildStagePrompt, loadRules } from "../prompts"
import { buildAnalyticsSection, editOutputWarnings, editStep } from "./edit"
import { stageStepOutputSchema } from "./stage-io"

/**
 * `validateLinks` reaches the public internet, and both fixtures' outputs cite
 * real domains. The module is wrapped rather than replaced: `stub.impl` is null
 * for the one test that wants the real thing over a local socket, and set to a
 * recorder for every test that only cares about the prompt.
 */
const stub: { impl: ((content: string) => Promise<ValidationResult>) | null } = { impl: null }
vi.mock("../links", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../links")>()
  return {
    ...actual,
    validateLinks: (content: string) => (stub.impl ?? actual.validateLinks)(content),
  }
})

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
    internal_links: { url: string; title?: string }[]
    stage_status: Record<string, string>
  }
  rendered_prompts: string[]
  provider_calls: {
    request: { model: string }
    response: { usage: { input_tokens: number; output_tokens: number } }
  }[]
  stage_output: {
    final_md: string
    current_stage: string
    stage_status: Record<string, string>
    _stage_meta: { model: string; tokens_in: number; tokens_out: number }
  }
}

function loadFixture(slug: string): Fixture {
  return JSON.parse(readFileSync(path.join(goldenDir, slug, "edit.json"), "utf8"))
}

const db = getDb()
const fixtures = FIXTURE_SLUGS.map(loadFixture)
/** See `write.test.ts`: each stage's parity file namespaces the shared fixture ids. */
const ID_NAMESPACE = "a4"
const fixtureIds = fixtures.map(
  (f) => String(f.post_spec.id).slice(0, -3) + ID_NAMESPACE + String(f.post_spec.id).slice(-1),
)

/** The profile that owns the seeded internal links. Fixed id so cleanup is exact. */
const PROFILE_ID = "00000000-0000-4000-8000-00000000f004"

/** One replayed provider response, shaped like the agent's `generate` result. */
function replayOf(fixture: Fixture) {
  const call = fixture.provider_calls[0]
  return {
    text: fixture.stage_output.final_md,
    response: { modelId: call.request.model },
    usage: {
      inputTokens: call.response.usage.input_tokens,
      outputTokens: call.response.usage.output_tokens,
    },
  }
}

type Replay = ReturnType<typeof replayOf>

type LogLine = { level: string; message: string }

/** Records the prompts the step sends and the warnings it logs. */
function replayMastra(reply: Replay) {
  const prompts: string[] = []
  const logs: LogLine[] = []
  const record = (level: string) => (message: string) => logs.push({ level, message })
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
    getLogger: () => ({ warn: record("warn"), error: record("error") }),
  }
  return { mastra, prompts, announced, logs }
}

type ExecuteParams = Parameters<typeof editStep.execute>[0]

async function runStep(postId: string, reply: Replay) {
  const harness = replayMastra(reply)
  const output = await editStep.execute({
    inputData: { postId },
    mastra: harness.mastra,
  } as unknown as ExecuteParams)
  return { ...harness, output: stageStepOutputSchema.parse(output) }
}

async function insertFixturePosts() {
  await db.insert(websiteProfiles).values({
    id: PROFILE_ID,
    name: "edit parity fixture",
    websiteUrl: "https://example.com",
  })

  for (const [index, fixture] of fixtures.entries()) {
    const spec = fixture.post_spec
    const links = fixture.state_input.internal_links
    await db.insert(posts).values({
      id: fixtureIds[index],
      slug: spec.slug,
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
      // What the three stages before this one committed.
      researchContent: fixture.state_input.research,
      outlineContent: fixture.state_input.outline,
      draftContent: fixture.state_input.draft,
      currentStage: "write",
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
  // Nothing reaches the network unless a test asks for it.
  stub.impl = async (content: string) => ({ content, removed: [] })
  // Only `Date` is faked: the prompt stamps TODAY_DATE from the clock and the
  // fixtures were captured on a fixed day. Timers stay real so the postgres
  // driver's own timeouts still fire.
  vi.useFakeTimers({ toFake: ["Date"], shouldAdvanceTime: true })
})

afterEach(() => {
  vi.useRealTimers()
  stub.impl = null
})

afterAll(async () => {
  await cleanup()
  await closeDb()
})

describe("edit step prompt parity", () => {
  for (const [index, slug] of FIXTURE_SLUGS.entries()) {
    it(`sends the prompt the Python stage sent for ${slug}`, async () => {
      const fixture = fixtures[index]
      vi.setSystemTime(new Date(fixture.captured_at))

      const { prompts } = await runStep(fixtureIds[index], replayOf(fixture))

      expect(prompts).toHaveLength(1)
      expect(prompts[0]).toBe(fixture.rendered_prompts[0])
    })
  }

  it("offers the internal-link inventory that the earlier stages were denied", async () => {
    const fixture = fixtures[0]
    vi.setSystemTime(new Date(fixture.captured_at))

    const { prompts } = await runStep(fixtureIds[0], replayOf(fixture))

    // `build_stage_prompt` offers links to `edit` only; `write.test.ts` asserts
    // the same three links are withheld from the stage before this one.
    expect(prompts[0]).toContain("Available Internal Links")
    for (const link of fixture.state_input.internal_links) {
      expect(prompts[0]).toContain(link.url)
    }
  })

  it("renders a keyword density of exactly zero the way Python's str(float) does", () => {
    // The CRM fixture's second keyword never appears in the draft. Python prints
    // `0.0%`; `String(0)` would print `0%` and silently change the prompt.
    expect(fixtures[0].rendered_prompts[0]).toContain("**crm comparison:** 0.0% (target: 1-2%)")
  })

  it("reaches the SIMPLIFY branch only on the fixture whose Flesch score is under 55", () => {
    expect(fixtures[1].rendered_prompts[0]).toContain("- SIMPLIFY: Current Flesch score is 47.8.")
    expect(fixtures[0].rendered_prompts[0]).not.toContain("- SIMPLIFY:")
  })

  it("appends nothing at all when the draft column is empty", async () => {
    const fixture = fixtures[0]
    vi.setSystemTime(new Date(fixture.captured_at))
    await db.update(posts).set({ draftContent: "" }).where(eq(posts.id, fixtureIds[0]))

    const { prompts } = await runStep(fixtureIds[0], replayOf(fixture))

    // Python suppresses the separator along with the section, so the prompt is
    // exactly the rules-driven half with nothing appended and no dangling `---`.
    const state = await loadPipelineState(fixtureIds[0])
    expect(prompts[0]).toBe(buildStagePrompt("edit", loadRules("edit"), state))
    expect(prompts[0]).not.toContain("## Current Content Analytics")
    expect(prompts[0].endsWith("---\n\n")).toBe(false)
  })
})

describe("edit step analytics section", () => {
  it("matches the section Python appended, character for character", async () => {
    const fixture = fixtures[1]
    vi.setSystemTime(new Date(fixture.captured_at))
    const { prompts } = await runStep(fixtureIds[1], replayOf(fixture))

    const marker = "\n\n---\n\n## Current Content Analytics"
    const at = fixture.rendered_prompts[0].indexOf(marker)
    expect(at).toBeGreaterThan(0)
    // Asserted separately from the whole-prompt comparison so a mismatch points
    // at the computed kilobyte rather than at 34 KB of rules and columns.
    expect(prompts[0].slice(at)).toBe(fixture.rendered_prompts[0].slice(at))
  })
})

describe("edit step output validation", () => {
  it("warns about em-dashes, readability and the SEO checks the edit left failing", async () => {
    const fixture = fixtures[1]
    vi.setSystemTime(new Date(fixture.captured_at))

    const { logs } = await runStep(fixtureIds[1], replayOf(fixture))

    const warnings = logs.filter((line) => line.level === "warn").map((line) => line.message)
    // The edit output this fixture recorded still fails several checks, which is
    // exactly the case Python logs rather than blocks on.
    expect(warnings).toContainEqual(
      expect.stringMatching(/^SEO checks still failing after edit: /),
    )
    // A quality problem is a warning, never an error: the run continues.
    expect(logs.filter((line) => line.level === "error")).toEqual([])
  })

  it("counts em-dashes in the output the way Python's str.count does", async () => {
    const fixture = fixtures[0]
    const state = { relatedKeywords: [], topic: "", websiteUrl: "" }
    const warnings = editOutputWarnings(
      state as unknown as Parameters<typeof editOutputWarnings>[0],
      "a — b — c",
    )
    expect(warnings[0].message).toBe("Edit output contains 2 em-dash(es) — should be zero")
    expect(fixture.stage_output.final_md).not.toContain("—")
  })
})

describe("edit step link validation", () => {
  let server: Server
  let base: string

  beforeAll(async () => {
    server = createServer((req, res) => {
      res.statusCode = req.url === "/gone" ? 404 : 200
      res.end("ok")
    })
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve))
    base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`
  })

  afterAll(async () => {
    await new Promise<void>((resolve, reject) =>
      server.close((error) => (error ? reject(error) : resolve())),
    )
  })

  it("strips a dead link over real sockets and keeps the live one", async () => {
    const fixture = fixtures[0]
    vi.setSystemTime(new Date(fixture.captured_at))
    // The real implementation, against a real server, so this is the whole path
    // from the model's answer to the committed column.
    stub.impl = null
    const edited = `See [live](${base}/ok) and [dead](${base}/gone).`

    const { logs } = await runStep(fixtureIds[0], { ...replayOf(fixture), text: edited })

    const [row] = await db.select().from(posts).where(eq(posts.id, fixtureIds[0]))
    expect(row.finalMdContent).toBe(`See [live](${base}/ok) and dead.`)
    expect(logs).toContainEqual({
      level: "warn",
      message: `Stripped 1 dead link(s): ${base}/gone`,
    })
  })

  it("commits the model's own output when link validation throws", async () => {
    const fixture = fixtures[0]
    vi.setSystemTime(new Date(fixture.captured_at))
    stub.impl = async () => {
      throw new Error("network down")
    }

    const { logs, output } = await runStep(fixtureIds[0], replayOf(fixture))

    expect(output.stage).toBe("edit")
    const [row] = await db.select().from(posts).where(eq(posts.id, fixtureIds[0]))
    expect(row.finalMdContent).toBe(fixture.stage_output.final_md)
    expect(logs.filter((line) => line.level === "error")).toEqual([
      { level: "error", message: "link validation failed, skipping" },
    ])
  })
})

describe("edit step persistence and output", () => {
  it("commits the final markdown to its column and reports Python's stage meta", async () => {
    const fixture = fixtures[0]
    vi.setSystemTime(new Date(fixture.captured_at))

    const { output } = await runStep(fixtureIds[0], replayOf(fixture))

    expect(output).toMatchObject({
      postId: fixtureIds[0],
      stage: "edit",
      model: fixture.stage_output._stage_meta.model,
      tokensIn: fixture.stage_output._stage_meta.tokens_in,
      tokensOut: fixture.stage_output._stage_meta.tokens_out,
    })

    const [row] = await db.select().from(posts).where(eq(posts.id, fixtureIds[0]))
    expect(row.finalMdContent).toBe(fixture.stage_output.final_md)
    expect(row.currentStage).toBe(fixture.stage_output.current_stage)
    // Python merges into the map the previous stages left, so all four survive.
    expect(row.stageStatus).toEqual(fixture.stage_output.stage_status)
    // The stages it chains from are untouched, and the ones after it stay empty.
    expect(row.draftContent).toBe(fixture.state_input.draft)
    expect(row.readyContent).toBeNull()
  })

  it("fails loudly on a post that does not exist rather than billing a call", async () => {
    const harness = replayMastra(replayOf(fixtures[0]))
    await expect(
      editStep.execute({
        inputData: { postId: "00000000-0000-4000-8000-0000000000ff" },
        mastra: harness.mastra,
      } as unknown as ExecuteParams),
    ).rejects.toThrow("not found")
    expect(harness.prompts).toEqual([])
  })
})

describe("buildAnalyticsSection", () => {
  it("returns the empty string for a post with no draft", () => {
    const state = { draft: "", relatedKeywords: [], topic: "", websiteUrl: "", wordCount: 2000 }
    expect(buildAnalyticsSection(state as unknown as Parameters<typeof buildAnalyticsSection>[0])).toBe("")
  })
})

describe("edit step announcement", () => {
  it("announces the stage on the event bus, in Python's payload shape", async () => {
    const { announced } = await runStep(fixtureIds[0], replayOf(fixtures[0]))

    expect(announced).toEqual([
      {
        event: "stage_start",
        post_id: fixtureIds[0],
        stage: "edit",
        message: "Starting edit...",
      },
    ])
  })
})
