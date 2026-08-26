// @vitest-environment node
/** Prompt assembly and stage-context regressions. */
import fs from "node:fs"
import path from "node:path"

import { describe, expect, it } from "vitest"

import { buildStagePrompt, loadRules, rulesDir } from "./prompts"
import { pipelineContextSchema, STAGE_RULES_MAP, STAGES } from "./state"
import type { PipelineContext } from "./state"

const GOLDEN_DIR = path.resolve(process.cwd(), "..", "docs", "mastra-port", "golden")

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

  /**
   * Ledger item P2.22. `loadRules` used to answer `""` for a missing file, the
   * way Python's `load_rules` did, and nothing downstream noticed: the stage
   * ran, the provider was billed, and the product's prompt IP was simply not in
   * the prompt. That is the failure mode a wrong `RULES_DIR` produces, and the
   * bundle's own cwd produces it by default, so it has to be loud.
   *
   * The message has to name the variable as well as the path: the resolved
   * path alone reads as a packaging bug rather than as one environment variable
   * away from correct.
   */
  it("refuses a rules directory that does not hold the stage's file", () => {
    const original = process.env.RULES_DIR
    const missing = path.join(GOLDEN_DIR, "does-not-exist")
    process.env.RULES_DIR = missing
    try {
      // A string matcher asserts substring inclusion in the message.
      expect(() => loadRules("research")).toThrowError("RULES_DIR")
      expect(() => loadRules("research")).toThrowError(
        path.join(missing, "blog-research.md"),
      )
    } finally {
      if (original === undefined) delete process.env.RULES_DIR
      else process.env.RULES_DIR = original
    }
  })

  /**
   * What the throw replaces. Built with `""` rather than by reading a broken
   * directory, so this case still says what a stripped rule file costs after
   * `loadRules` stopped being able to produce one: the whole rules section
   * disappears and the prompt is otherwise well-formed, which is why six
   * stages could run on it without anything failing.
   */
  it("would have sent a prompt with no rules section at all", () => {
    const context = emptyContext()
    expect(buildStagePrompt("research", "", context, "2026-08-21")).not.toContain(
      "## Rules",
    )
    expect(buildStagePrompt("research", "", context, "2026-08-21")).toBe(
      "## Post Configuration\n\n- **TODAY_DATE**: 2026-08-21",
    )
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

  it("escapes the delete character, which `ensure_ascii` also escapes", () => {
    // Python's `ESCAPE_ASCII` is `[^\ -~]`, so `\x7f` is outside the range that
    // passes through. The old regex started at `\u0080` and left it literal.
    const context = emptyContext()
    context.imageManifest = { alt: "a\u007fb" }
    const prompt = buildStagePrompt("ready", "", context, "2026-08-21")
    expect(prompt).toContain('{\n  "alt": "a\\u007fb"\n}')
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

describe("stage-specific prompt context", () => {
  function configuredContext(): PipelineContext & {
    imageStyle: string
    imageBrandColors: string[]
    imageExclude: string[]
  } {
    return Object.assign(emptyContext(), {
      topic: "The History of 80 Percent Pistol Frames",
      targetAudience: "Experienced builders",
      niche: "Firearm component history",
      intent: "informational",
      articleType: "historical guide",
      additionalInfo: "Research source packet only",
      wordCount: 1800,
      tone: "Direct and technically precise",
      websiteUrl: "https://g80.com",
      brandVoice: "Practical subject matter expert",
      avoid: "Unsupported legal conclusions",
      requiredMentions: "G80 steel FCU",
      relatedKeywords: ["80 percent frame"],
      competitorUrls: ["https://competitor.example/article"],
      research: [
        "## Research summary",
        "Summary that later stages do not need.",
        "## Claim ledger",
        "- Claim: Polymer80 introduced a pistol frame.",
        "  Source: https://example.com/source",
        "## Topic coverage",
        "Coverage notes that later stages do not need.",
      ].join("\n"),
      outline: "## Origins\n- Establish the chronology.",
      draft: "---\ntitle: History\n---\n\n# History\n\nDraft body.",
      imageStyle: "Documentary product photography",
      imageBrandColors: ["#111111", "#D4A017"],
      imageExclude: ["exploded firearm diagrams"],
    })
  }

  it("keeps voice controls out of research", () => {
    const prompt = buildStagePrompt("research", "Research rules", configuredContext(), "2026-08-26")

    expect(prompt).toContain("Research source packet only")
    expect(prompt).toContain("https://competitor.example/article")
    expect(prompt).not.toContain("Direct and technically precise")
    expect(prompt).not.toContain("Practical subject matter expert")
    expect(prompt).not.toContain("Unsupported legal conclusions")
    expect(prompt).not.toContain("G80 steel FCU")
  })

  it("gives write the outline and voice controls without research-only context", () => {
    const prompt = buildStagePrompt("write", "Write rules", configuredContext(), "2026-08-26")

    expect(prompt).toContain("## Origins")
    expect(prompt).toContain("Direct and technically precise")
    expect(prompt).toContain("Practical subject matter expert")
    expect(prompt).toContain("Unsupported legal conclusions")
    expect(prompt).toContain("G80 steel FCU")
    expect(prompt).not.toContain("Research source packet only")
    expect(prompt).not.toContain("https://competitor.example/article")
    expect(prompt).not.toContain("Documentary product photography")
  })

  it("gives edit only the claim ledger from research", () => {
    const prompt = buildStagePrompt("edit", "Edit rules", configuredContext(), "2026-08-26")

    expect(prompt).toContain("## Claim ledger")
    expect(prompt).toContain("https://example.com/source")
    expect(prompt).not.toContain("Summary that later stages do not need")
    expect(prompt).not.toContain("Coverage notes that later stages do not need")
  })

  it("gives images visual controls and the claim ledger without prose controls", () => {
    const prompt = buildStagePrompt("images", "Image rules", configuredContext(), "2026-08-26")

    expect(prompt).toContain("Documentary product photography")
    expect(prompt).toContain("#111111, #D4A017")
    expect(prompt).toContain("exploded firearm diagrams")
    expect(prompt).toContain("## Claim ledger")
    expect(prompt).not.toContain("Direct and technically precise")
    expect(prompt).not.toContain("Practical subject matter expert")
    expect(prompt).not.toContain("Research source packet only")
  })
})
