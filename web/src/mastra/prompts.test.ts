// @vitest-environment node
/**
 * Phase 3 item 3.1a: the TypeScript prompt assembly renders the same prompt the
 * Python pipeline sent to the provider.
 *
 * The oracle is `docs/mastra-port/golden/`, captured in Phase 0 from live runs
 * of the Python stack. Each fixture holds the exact `PipelineState` a stage was
 * given and the exact prompt string that state produced, so the comparison is
 * against a real rendered prompt rather than against a reimplementation of the
 * renderer.
 *
 * The gate the objective sets is whitespace-normalized equality. These tests
 * assert byte equality as well, because the two renderers currently agree
 * exactly and a whitespace-only divergence would still be a defect worth
 * seeing.
 */
import fs from "node:fs"
import path from "node:path"

import { describe, expect, it } from "vitest"

import { buildStagePrompt, loadRules, rulesDir } from "./prompts"
import { pipelineContextSchema, STAGE_RULES_MAP, STAGES } from "./state"
import type { PipelineContext, Stage } from "./state"

const GOLDEN_DIR = path.resolve(process.cwd(), "..", "docs", "mastra-port", "golden")

type GoldenFixture = {
  captured_at: string
  post_slug: string
  stage: Stage
  state_input: Record<string, unknown>
  rendered_prompts: string[]
}

function readFixture(slug: string, stage: Stage): GoldenFixture {
  const file = path.join(GOLDEN_DIR, slug, `${stage}.json`)
  return JSON.parse(fs.readFileSync(file, "utf8")) as GoldenFixture
}

const GOLDEN_SLUGS = fs
  .readdirSync(GOLDEN_DIR, { withFileTypes: true })
  .filter((entry) => entry.isDirectory())
  .map((entry) => entry.name)
  .sort()

/**
 * Map a captured Python `PipelineState` onto the TypeScript context. Doubles as
 * the written-down snake_case to camelCase mapping the steps will use when they
 * read a `posts` row through drizzle.
 */
function contextFromState(state: Record<string, unknown>): PipelineContext {
  return pipelineContextSchema.parse({
    topic: state.topic,
    targetAudience: state.target_audience,
    niche: state.niche,
    intent: state.intent,
    articleType: state.article_type,
    additionalInfo: state.additional_info,
    wordCount: state.word_count,
    tone: state.tone,
    outputFormat: state.output_format,
    websiteUrl: state.website_url,
    brandVoice: state.brand_voice,
    avoid: state.avoid,
    requiredMentions: state.required_mentions,
    relatedKeywords: state.related_keywords,
    competitorUrls: state.competitor_urls,
    internalLinks: state.internal_links,
    research: state.research,
    outline: state.outline,
    draft: state.draft,
    finalMd: state.final_md,
    imageManifest: state.image_manifest,
    ready: state.ready,
  })
}

/** The UTC date the fixture was captured, which is the TODAY_DATE it stamped. */
function capturedDate(fixture: GoldenFixture): string {
  return fixture.captured_at.slice(0, 10)
}

function normalizeWhitespace(value: string): string {
  return value.replace(/\s+/g, " ").trim()
}

/** A context with every field at the value `state_from_post()` coalesces to. */
function emptyContext(): PipelineContext {
  return pipelineContextSchema.parse({
    topic: "",
    targetAudience: "",
    niche: "",
    intent: "",
    articleType: "",
    additionalInfo: "",
    wordCount: 0,
    tone: "",
    outputFormat: "",
    websiteUrl: "",
    brandVoice: "",
    avoid: "",
    requiredMentions: "",
    relatedKeywords: [],
    competitorUrls: [],
    internalLinks: [],
    research: "",
    outline: "",
    draft: "",
    finalMd: "",
    imageManifest: {},
    ready: "",
  })
}

describe("golden fixture prompt parity", () => {
  it("captured two posts covering both article types and output formats", () => {
    expect(GOLDEN_SLUGS).toHaveLength(2)
    const specs = GOLDEN_SLUGS.map((slug) => {
      const state = readFixture(slug, "research").state_input
      return `${state.article_type}/${state.output_format}`
    })
    expect(new Set(specs).size).toBe(2)
  })

  /**
   * Four of the six stages send exactly `build_stage_prompt()`'s output.
   * `images` sends it as the first of several prompts (the rest are per-image
   * and belong to item 3.5).
   */
  const EXACT_STAGES: Stage[] = ["research", "outline", "write", "images"]

  for (const slug of GOLDEN_SLUGS) {
    for (const stage of EXACT_STAGES) {
      it(`renders ${slug}/${stage} exactly as the Python stage did`, () => {
        const fixture = readFixture(slug, stage)
        expect(fixture.stage).toBe(stage)

        const rendered = buildStagePrompt(
          stage,
          loadRules(stage),
          contextFromState(fixture.state_input),
          capturedDate(fixture),
        )

        const expected = fixture.rendered_prompts[0]
        expect(normalizeWhitespace(rendered)).toBe(normalizeWhitespace(expected))
        expect(rendered).toBe(expected)
      })
    }

    /**
     * `edit_node` appends its own content-analytics block:
     *   `build_stage_prompt(...) + "\n\n---\n\n" + _build_analytics_section(...)`.
     * The shared assembly is therefore an exact prefix, and item 3.4 ports the
     * analytics tail.
     */
    it(`renders ${slug}/edit up to the analytics block the edit stage appends`, () => {
      const fixture = readFixture(slug, "edit")
      const rendered = buildStagePrompt(
        "edit",
        loadRules("edit"),
        contextFromState(fixture.state_input),
        capturedDate(fixture),
      )
      const expected = fixture.rendered_prompts[0]

      expect(expected.startsWith(rendered)).toBe(true)
      expect(expected.slice(rendered.length)).toMatch(
        /^\n\n---\n\n## Current Content Analytics\n/,
      )
    })

    /**
     * `ready_node` does not call `build_stage_prompt()` at all; `_build_ready_prompt`
     * emits a two-field configuration block (SLUG, OUTPUT_FORMAT, TODAY_DATE) and
     * fences the manifest as JSON. Pinned here so item 3.6 ports that builder
     * instead of reaching for this one.
     */
    it(`does not use the shared assembly for ${slug}/ready`, () => {
      const fixture = readFixture(slug, "ready")
      const expected = fixture.rendered_prompts[0]

      expect(expected).toContain(`## Post Configuration\n\n- **SLUG**: ${slug}\n`)
      expect(expected).toContain("## Image Manifest (generated images only)")
      expect(expected).not.toContain("- **BLOG_POST_TOPIC**:")

      const rendered = buildStagePrompt(
        "ready",
        loadRules("ready"),
        contextFromState(fixture.state_input),
        capturedDate(fixture),
      )
      expect(rendered).not.toBe(expected)
    })
  }

  it("stamps TODAY_DATE from the clock the run happens on", () => {
    const fixture = readFixture(GOLDEN_SLUGS[0], "research")
    const context = contextFromState(fixture.state_input)
    expect(buildStagePrompt("research", "", context, "2020-01-02")).toContain(
      "- **TODAY_DATE**: 2020-01-02",
    )
    // The fixtures pin the other direction: the captured date is what makes the
    // parity assertions above exact.
    expect(fixture.rendered_prompts[0]).toContain(
      `- **TODAY_DATE**: ${capturedDate(fixture)}`,
    )
  })
})

describe("loadRules", () => {
  it("reads every stage's rule file from the repo's rules directory", () => {
    for (const stage of STAGES) {
      const rules = loadRules(stage)
      expect(rules.length).toBeGreaterThan(0)
      expect(rules).toBe(
        fs.readFileSync(path.join(rulesDir(), STAGE_RULES_MAP[stage]), "utf8"),
      )
    }
  })

  it("honours RULES_DIR and yields an empty string when the file is absent", () => {
    const original = process.env.RULES_DIR
    process.env.RULES_DIR = path.join(GOLDEN_DIR, "does-not-exist")
    try {
      expect(loadRules("research")).toBe("")
    } finally {
      if (original === undefined) delete process.env.RULES_DIR
      else process.env.RULES_DIR = original
    }
  })
})

describe("buildStagePrompt edge cases", () => {
  it("omits empty configuration fields but always stamps TODAY_DATE", () => {
    const prompt = buildStagePrompt("research", "", emptyContext(), "2026-08-21")
    expect(prompt).toBe("## Post Configuration\n\n- **TODAY_DATE**: 2026-08-21")
  })

  it("escapes non-ASCII in a serialized manifest the way json.dumps does", () => {
    const context = emptyContext()
    context.imageManifest = { alt: "café — 90% sure ☕" }
    const prompt = buildStagePrompt("ready", "", context, "2026-08-21")
    expect(prompt).toContain(
      '## Previous Stage Output\n\n{\n  "alt": "caf\\u00e9 \\u2014 90% sure \\u2615"\n}',
    )
  })

  it("still emits a previous-output section for an empty manifest", () => {
    // Python's truthiness check sees the string "{}", not the empty dict, so the
    // `ready` prompt carries a useless section when `images` produced nothing.
    // Preserved because the golden fixtures were captured with this behaviour.
    const prompt = buildStagePrompt("ready", "", emptyContext(), "2026-08-21")
    expect(prompt).toContain("## Previous Stage Output\n\n{}")
  })

  it("caps the edit stage's internal link inventory at 50", () => {
    const context = emptyContext()
    context.websiteUrl = "https://example.com"
    context.internalLinks = Array.from({ length: 60 }, (_, index) => ({
      url: `https://example.com/p/${index}`,
      title: index % 2 === 0 ? `Post ${index}` : undefined,
    }))

    const prompt = buildStagePrompt("edit", "", context, "2026-08-21")
    expect(prompt).toContain("## Available Internal Links (60 total)")
    expect(prompt).toContain('- https://example.com/p/0 - "Post 0"')
    expect(prompt).toContain("- https://example.com/p/1\n")
    expect(prompt).toContain("- https://example.com/p/49")
    expect(prompt).not.toContain("- https://example.com/p/50")
  })

  it("adds the link inventory only for the edit stage", () => {
    const context = emptyContext()
    context.internalLinks = [{ url: "https://example.com/a", title: "A" }]
    for (const stage of STAGES) {
      const prompt = buildStagePrompt(stage, "", context, "2026-08-21")
      expect(prompt.includes("## Available Internal Links")).toBe(stage === "edit")
    }
  })
})
