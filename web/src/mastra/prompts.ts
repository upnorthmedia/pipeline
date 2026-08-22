/**
 * Stage prompt assembly, ported from `load_rules()` / `build_stage_prompt()` in
 * `api/src/pipeline/helpers.py`.
 *
 * This is the one piece of the port that must be byte-identical to the Python
 * original: the rendered prompt is the product's prompt IP, and every stage's
 * parity test compares what this produces against the prompt the Python stage
 * actually sent to the provider (`docs/mastra-port/golden/`). Behaviour changes
 * here are prompt changes, not refactors.
 *
 * `rules/*.md` are inputs, never rewritten by this port.
 */
import { existsSync, readFileSync } from "node:fs"
import path from "node:path"

import { STAGE_OUTPUT_KEY, STAGE_RULES_MAP, STAGES } from "./state"
import type { PipelineContext, Stage } from "./state"

/**
 * Where `rules/*.md` live. Python resolves this from the repo root and lets
 * `RULES_DIR` override it in Docker; this module keeps both behaviours so the
 * two stacks read the same files from the same place while they coexist.
 */
export function rulesDir(): string {
  return process.env.RULES_DIR ?? path.resolve(process.cwd(), "..", "rules")
}

/**
 * Read a stage's rule file. A missing file yields `""` rather than throwing,
 * matching Python: a stage still runs (badly) without its rules, and the
 * failure surfaces in the output instead of taking the run down.
 */
export function loadRules(stage: Stage): string {
  const file = path.join(rulesDir(), STAGE_RULES_MAP[stage])
  if (!existsSync(file)) return ""
  return readFileSync(file, "utf8")
}

/**
 * Python's `json.dumps(..., indent=2)` escapes every non-ASCII character to a
 * `\uXXXX` sequence (`ensure_ascii` defaults to true) while `JSON.stringify`
 * emits it literally. The only prompt that serializes JSON is `ready`, whose
 * previous-stage output is the image manifest, and manifest prose routinely
 * carries typographic punctuation. Without this the two stacks' prompts differ
 * on exactly the posts that matter.
 *
 * Iterating the string by UTF-16 code unit escapes astral characters as the
 * surrogate pair Python also emits.
 */
function pythonJsonDumps(value: unknown): string {
  return JSON.stringify(value, null, 2).replace(/[\u0080-\uffff]/g, (char) =>
    `\\u${char.charCodeAt(0).toString(16).padStart(4, "0")}`,
  )
}

/** `- **LABEL**: value` lines, in the order the Python field list declares. */
const CONFIG_FIELDS: [string, keyof PipelineContext][] = [
  ["BLOG_POST_TOPIC", "topic"],
  ["TARGET_AUDIENCE", "targetAudience"],
  ["NICHE", "niche"],
  ["INTENT", "intent"],
  ["ARTICLE_TYPE", "articleType"],
  ["ADDITIONAL_INFO", "additionalInfo"],
  ["WORD_COUNT", "wordCount"],
  ["TONE", "tone"],
  ["OUTPUT_FORMAT", "outputFormat"],
  ["WEBSITE_URL", "websiteUrl"],
  ["BRAND_VOICE", "brandVoice"],
  ["AVOID", "avoid"],
  ["REQUIRED_MENTIONS", "requiredMentions"],
]

function buildConfigContext(context: PipelineContext, today: string): string {
  const lines = ["## Post Configuration\n"]
  for (const [label, key] of CONFIG_FIELDS) {
    const value = context[key]
    // Python skips falsy values, so an empty string and a zero word count are
    // both omitted rather than rendered.
    if (!value) continue
    lines.push(`- **${label}**: ${String(value)}`)
  }
  if (context.relatedKeywords.length > 0) {
    lines.push(`- **RELATED_KEYWORDS**: ${context.relatedKeywords.join(", ")}`)
  }
  if (context.competitorUrls.length > 0) {
    lines.push(`- **COMPETITOR_URLS**: ${context.competitorUrls.join(", ")}`)
  }
  lines.push(`- **TODAY_DATE**: ${today}`)
  return lines.join("\n")
}

/** The previous stage's output, which is this stage's chain input. */
function previousOutput(stage: Stage, context: PipelineContext): string {
  const index = STAGES.indexOf(stage)
  if (index === 0) return ""
  const value = context[STAGE_OUTPUT_KEY[STAGES[index - 1]]]
  // The manifest is the only object-valued output. Note that an empty manifest
  // serializes to "{}", which is truthy, so `ready` still gets a (useless)
  // previous-output section when `images` produced nothing. Python does the
  // same and the golden fixtures were captured with that behaviour.
  if (typeof value === "object" && value !== null) return pythonJsonDumps(value)
  return typeof value === "string" ? value : ""
}

function buildLinksContext(context: PipelineContext): string {
  const links = context.internalLinks
  if (links.length === 0) return ""

  const lines = [`## Available Internal Links (${links.length} total)\n`]
  if (context.websiteUrl) {
    // Verbatim from `_build_links_context`, em dash included: this text goes to
    // the provider, so changing it would change the product's prompt.
    lines.push(
      `**YOUR DOMAIN**: ${context.websiteUrl} — ` +
        "Any link to this domain is an internal link.\n" +
        "**INSTRUCTION**: Use these URLs directly. " +
        "Do NOT search for internal links. " +
        "Insert 3-5 of these into the content " +
        "with natural anchor text.\n",
    )
  }
  for (const link of links.slice(0, 50)) {
    const url = link.url ?? ""
    const title = link.title ?? ""
    lines.push(title ? `- ${url} - "${title}"` : `- ${url}`)
  }
  return lines.join("\n")
}

/**
 * Assemble a stage's full prompt: rules, post configuration, the previous
 * stage's output, and (for `edit` only) the internal link inventory, joined by
 * a markdown rule.
 *
 * `today` is injectable because the config block stamps TODAY_DATE from the
 * clock; parity tests pin it to the date the golden fixture was captured.
 */
export function buildStagePrompt(
  stage: Stage,
  rules: string,
  context: PipelineContext,
  today: string = new Date().toISOString().slice(0, 10),
): string {
  const sections: string[] = []

  if (rules) sections.push(rules)

  const config = buildConfigContext(context, today)
  if (config) sections.push(config)

  const previous = previousOutput(stage, context)
  if (previous) sections.push(`## Previous Stage Output\n\n${previous}`)

  if (stage === "edit" && context.internalLinks.length > 0) {
    sections.push(buildLinksContext(context))
  }

  return sections.join("\n\n---\n\n")
}
