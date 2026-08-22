/**
 * Parity tests for the `compute_analytics` port (ledger item 3.4b).
 *
 * Two oracles, deliberately independent of each other:
 *
 * 1. `docs/mastra-port/golden/<slug>/edit.json` carries the *rendered* edit
 *    prompt Python produced, with the word count, Flesch score, average
 *    sentence length and keyword densities in it as literals. Nothing in this
 *    repo generated those digits for the benefit of this test, so they are the
 *    strongest evidence available that the port agrees with Python.
 * 2. `data/analytics-parity.json`, written by
 *    `api/scripts/export_analytics_parity.py`, covers what the fixtures cannot
 *    reach: empty input, code fences, frontmatter, link classification, `\r\n`
 *    endings, the line separators JavaScript treats as newlines and Python does
 *    not, `urlparse().netloc`, and exact rounding ties.
 */
import { readFileSync } from "node:fs"
import path from "node:path"

import { describe, expect, it } from "vitest"

import { computeAnalytics, stripMarkdown, urlNetloc, type ContentAnalytics } from "./index"
import { pythonRound } from "./python-round"

interface ParityCase {
  name: string
  args: {
    content: string
    primary_keyword: string
    secondary_keywords: string[]
    title: string
    website_url: string
  }
  plain: string
  expected: {
    word_count: number
    sentence_count: number
    paragraph_count: number
    avg_sentence_length: number
    flesch_reading_ease: number
    keyword_density: Record<string, number>
    seo_checklist: Record<string, boolean | number>
  }
}

interface ParityData {
  generated_by: string
  source: string
  round_cases: { value: number; ndigits: number; expected: number }[]
  netloc_cases: { url: string; expected: string }[]
  cases: ParityCase[]
}

const parity: ParityData = JSON.parse(
  readFileSync(path.join(__dirname, "data", "analytics-parity.json"), "utf8"),
)

const goldenDir = path.resolve(__dirname, "../../../../docs/mastra-port/golden")

function run(testCase: ParityCase): ContentAnalytics {
  return computeAnalytics(testCase.args.content, {
    primaryKeyword: testCase.args.primary_keyword,
    secondaryKeywords: testCase.args.secondary_keywords,
    title: testCase.args.title,
    websiteUrl: testCase.args.website_url,
  })
}

/**
 * Camelize the oracle's top-level keys generically rather than through a listed
 * mapping, so a field the port forgot shows up as a missing key rather than
 * being silently skipped. Only the top level: `keyword_density`'s keys are
 * arbitrary keywords and `seo_checklist`'s are rendered verbatim by the edit
 * prompt.
 */
function camelizeTopLevel(expected: ParityCase["expected"]): Record<string, unknown> {
  return Object.fromEntries(
    Object.entries(expected).map(([key, value]) => [
      key.replace(/_([a-z])/g, (_, letter: string) => letter.toUpperCase()),
      value,
    ]),
  )
}

describe("pythonRound", () => {
  it("matches Python's round() on every exported case, ties included", () => {
    expect(parity.round_cases.length).toBeGreaterThan(0)
    const mismatches = parity.round_cases
      .map((c) => ({ ...c, actual: pythonRound(c.value, c.ndigits) }))
      .filter((c) => !Object.is(c.actual, c.expected))
    expect(mismatches).toEqual([])
  })

  it("breaks exact ties to even, where toFixed breaks them away from zero", () => {
    // The values a double can hit exactly: odd / 2**k.
    expect(pythonRound(0.125, 2)).toBe(0.12)
    expect(Number((0.125).toFixed(2))).toBe(0.13)
    expect(pythonRound(0.375, 2)).toBe(0.38)
    expect(pythonRound(20.25, 1)).toBe(20.2)
    expect(Number((20.25).toFixed(1))).toBe(20.3)
    expect(pythonRound(20.75, 1)).toBe(20.8)
  })

  it("rounds by the double's exact binary value, not by its shortest repr", () => {
    // 2.675 is really 2.67499999999999982236431605997495353221893310546875.
    expect(pythonRound(2.675, 2)).toBe(2.67)
  })

  it("rejects a negative ndigits rather than silently returning the input", () => {
    expect(() => pythonRound(1.5, -1)).toThrow(/negative ndigits/)
  })
})

describe("urlNetloc", () => {
  it("matches urllib.parse.urlparse(url).netloc on every exported case", () => {
    expect(parity.netloc_cases.length).toBeGreaterThan(0)
    const actual = parity.netloc_cases.map((c) => ({ url: c.url, netloc: urlNetloc(c.url) }))
    const expected = parity.netloc_cases.map((c) => ({ url: c.url, netloc: c.expected }))
    expect(actual).toEqual(expected)
  })
})

describe("computeAnalytics parity oracle", () => {
  it("exports the cases this test expects", () => {
    expect(parity.generated_by).toBe("api/scripts/export_analytics_parity.py")
    expect(parity.cases.length).toBeGreaterThanOrEqual(17)
  })

  for (const testCase of parity.cases) {
    it(`matches compute_analytics for ${testCase.name}`, () => {
      expect(run(testCase)).toEqual(camelizeTopLevel(testCase.expected))
    })
  }

  for (const testCase of parity.cases.filter((c) => c.args.content)) {
    it(`matches _strip_markdown for ${testCase.name}`, () => {
      const unwrapped = testCase.args.content
        .trim()
        .replace(/^```(?:markdown|md)?\s*\n/, "")
        .replace(/\n```\s*$/, "")
      expect(stripMarkdown(unwrapped)).toBe(testCase.plain)
    })
  }
})

/**
 * The numbers Python actually printed, read back out of the captured edit
 * prompt rather than out of anything this port produced.
 */
/**
 * Python's `str(float)`: the shortest repr that round-trips, always carrying a
 * decimal point. `edit_node` interpolates the floats with an f-string, so a
 * density of exactly zero prints as `0.0%` where JavaScript would print `0%`.
 * Item 3.4e needs the production version of this; here it only reads the
 * fixture back.
 */
function pythonFloat(value: number): string {
  const text = String(value)
  return /[.e]/.test(text) ? text : `${text}.0`
}

describe("golden fixture edit prompts", () => {
  const slugs = ["how-to-choose-a-crm-for-a-small-team", "best-time-tracking-tools-for-agencies"]

  for (const slug of slugs) {
    it(`reproduces every analytics literal in ${slug}'s rendered prompt`, () => {
      const fixture = JSON.parse(
        readFileSync(path.join(goldenDir, slug, "edit.json"), "utf8"),
      ) as {
        state_input: { draft: string; related_keywords: string[]; topic: string; website_url: string }
        rendered_prompts: string[]
      }
      const state = fixture.state_input
      const prompt = fixture.rendered_prompts[0]
      const analytics = computeAnalytics(state.draft, {
        primaryKeyword: state.related_keywords[0] ?? "",
        secondaryKeywords: state.related_keywords.slice(1),
        title: state.topic,
        websiteUrl: state.website_url,
      })

      expect(prompt).toContain(`- **Word Count:** ${analytics.wordCount} (target:`)
      expect(prompt).toContain(
        `- **Flesch Reading Ease:** ${pythonFloat(analytics.fleschReadingEase)} (target: 60-70`,
      )
      expect(prompt).toContain(
        `- **Avg Sentence Length:** ${pythonFloat(analytics.avgSentenceLength)} words (target: <20)`,
      )
      for (const [keyword, density] of Object.entries(analytics.keywordDensity)) {
        expect(prompt).toContain(`- **${keyword}:** ${pythonFloat(density)}% (target: 1-2%)`)
      }
      for (const [check, passed] of Object.entries(analytics.seoChecklist)) {
        if (typeof passed !== "boolean") continue
        const label = check
          .replaceAll("_", " ")
          .replace(/(^|[^A-Za-z])([a-z])/g, (_, prefix: string, letter: string) => prefix + letter.toUpperCase())
        expect(prompt).toContain(`- [${passed ? "PASS" : "FAIL"}] ${label}`)
      }
    })
  }
})

describe("Python primitives the port cannot borrow from JavaScript", () => {
  it("does not treat a carriage return as the start of a markdown line", () => {
    const markdown = "Intro.\r## Not a heading to Python\n"
    expect(stripMarkdown(markdown)).toBe(markdown.trimEnd())
    expect(computeAnalytics(markdown).seoChecklist.has_h2_headings).toBe(false)
  })

  it("does not treat U+2028 or U+2029 as the start of a markdown line", () => {
    const markdown = "Intro. ## Nope > Also nope\n"
    expect(stripMarkdown(markdown)).toContain(" ## Nope")
    expect(stripMarkdown(markdown)).toContain(" > Also nope")
  })

  it("splits on Python's whitespace class, which includes \\x85 and \\x1c", () => {
    expect(computeAnalytics("Alpha\x85beta gamma.\x1cDelta epsilon.").wordCount).toBe(5)
  })

  it("counts non-overlapping keyword occurrences the way str.count does", () => {
    const analytics = computeAnalytics("aaaa " + "filler ".repeat(95), { primaryKeyword: "aa" })
    // 4 a's -> 2 non-overlapping matches, not 3 overlapping ones.
    expect(analytics.keywordDensity.aa).toBe(pythonRound((2 / analytics.wordCount) * 100, 2))
  })

  it("treats a bare host as having no netloc, so nothing is internal", () => {
    const markdown = "[a](https://example.com/x) and [b](https://other.org/y)\n"
    const bare = computeAnalytics(markdown, { websiteUrl: "example.com" })
    const full = computeAnalytics(markdown, { websiteUrl: "https://example.com" })
    expect(bare.seoChecklist.internal_link_count).toBe(0)
    expect(bare.seoChecklist.external_link_count).toBe(2)
    expect(full.seoChecklist.internal_link_count).toBe(1)
    expect(full.seoChecklist.external_link_count).toBe(1)
  })
})
