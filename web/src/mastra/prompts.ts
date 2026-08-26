/** Stage-scoped prompt assembly for the five model-backed pipeline stages. */
import { existsSync, readFileSync } from "node:fs"
import path from "node:path"

import { STAGE_OUTPUT_KEY, STAGE_RULES_MAP, STAGES } from "./state"
import type { PipelineContext, Stage } from "./state"

type PromptContext = PipelineContext & {
  imageStyle?: string
  imageBrandColors?: string[]
  imageExclude?: string[]
}

/**
 * Where `rules/*.md` live: the repo root by default, overridden by `RULES_DIR`
 * in Docker, where the worker bundle's cwd is its own output directory.
 */
export function rulesDir(): string {
  return process.env.RULES_DIR ?? path.resolve(process.cwd(), "..", "rules")
}

/**
 * Read a stage's rule file.
 *
 * A missing file throws. Python's `load_rules` answered `""` and this port
 * copied it, which is the one place the copy was wrong: `rules/*.md` are the
 * product's prompt IP, and a stage that loses its rule file does not fail, it
 * quietly bills a provider call for a prompt that is a configuration block and
 * nothing else. Nothing downstream can tell that apart from a stage that ran
 * properly, so six stages of a run can complete on stripped prompts with every
 * status column reading `complete`.
 *
 * The default path is the failure: `rulesDir()` resolves against `cwd`, and the
 * worker bundle runs with its own output directory as the cwd, so an unset
 * `RULES_DIR` points at `web/.mastra/rules`, which no image creates. Throwing
 * costs a failed `research` stage with a legible reason instead. The message
 * names the variable as well as the resolved path, because the path alone
 * reads as a packaging bug rather than as one variable away from correct.
 */
export function loadRules(stage: Stage): string {
  const file = path.join(rulesDir(), STAGE_RULES_MAP[stage])
  if (!existsSync(file)) {
    throw new Error(
      `Rule file not found for the ${stage} stage: ${file}. ` +
        "Set RULES_DIR to the directory holding rules/*.md; it defaults to a path " +
        "relative to the working directory, which the worker bundle does not share.",
    )
  }
  return readFileSync(file, "utf8")
}

/**
 * Python's `json.dumps(..., indent=2)` escapes every non-ASCII character to a
 * `\uXXXX` sequence (`ensure_ascii` defaults to true) while `JSON.stringify`
 * emits it literally.
 *
 * Iterating the string by UTF-16 code unit escapes astral characters as the
 * surrogate pair Python also emits.
 *
 * The class starts at `\u007f`, not `\u0080`: `ESCAPE_ASCII` is `[^\ -~]`, so
 * the delete character escapes too, and `JSON.stringify` emits it literally.
 * It cannot start lower without also matching the newlines and spaces `indent`
 * puts *between* the strings, which are structure rather than content.
 * Nothing is lost by stopping there: over `\x00`-`\x1f`, `"` and `\\`,
 * `JSON.stringify` and `json.dumps` emit byte-identical escapes, verified
 * against CPython.
 */
export function pythonJsonDumps(value: unknown): string {
  return JSON.stringify(value, null, 2).replace(/[\u007f-\uffff]/g, (char) =>
    `\\u${char.charCodeAt(0).toString(16).padStart(4, "0")}`,
  )
}

/** Identity fields shared by every model-backed stage. */
const COMMON_CONFIG_FIELDS: [string, keyof PromptContext][] = [
  ["BLOG_POST_TOPIC", "topic"],
  ["TARGET_AUDIENCE", "targetAudience"],
  ["NICHE", "niche"],
  ["INTENT", "intent"],
  ["ARTICLE_TYPE", "articleType"],
  ["WEBSITE_URL", "websiteUrl"],
]

const WRITING_CONFIG_FIELDS: [string, keyof PromptContext][] = [
  ["WORD_COUNT", "wordCount"],
  ["TONE", "tone"],
  ["BRAND_VOICE", "brandVoice"],
  ["AVOID", "avoid"],
  ["REQUIRED_MENTIONS", "requiredMentions"],
]

function stageConfigFields(stage: Stage): [string, keyof PromptContext][] {
  if (stage === "research") {
    return [...COMMON_CONFIG_FIELDS, ["ADDITIONAL_INFO", "additionalInfo"]]
  }
  if (stage === "outline") {
    return [
      ...COMMON_CONFIG_FIELDS,
      ["ADDITIONAL_INFO", "additionalInfo"],
      ...WRITING_CONFIG_FIELDS,
    ]
  }
  if (stage === "write" || stage === "edit") {
    return [...COMMON_CONFIG_FIELDS, ...WRITING_CONFIG_FIELDS]
  }
  if (stage === "images") {
    return [
      ...COMMON_CONFIG_FIELDS,
      ["IMAGE_STYLE", "imageStyle"],
      ["IMAGE_BRAND_COLORS", "imageBrandColors"],
      ["IMAGE_EXCLUDE", "imageExclude"],
    ]
  }
  return COMMON_CONFIG_FIELDS
}

function renderConfigValue(value: unknown): string {
  return Array.isArray(value) ? value.join(", ") : String(value)
}

function buildConfigContext(stage: Stage, context: PromptContext, today: string): string {
  const lines = ["## Post Configuration\n"]
  for (const [label, key] of stageConfigFields(stage)) {
    const value = context[key]
    if (!value || (Array.isArray(value) && value.length === 0)) continue
    lines.push(`- **${label}**: ${renderConfigValue(value)}`)
  }
  if (context.relatedKeywords.length > 0) {
    lines.push(`- **RELATED_KEYWORDS**: ${context.relatedKeywords.join(", ")}`)
  }
  if ((stage === "research" || stage === "outline") && context.competitorUrls.length > 0) {
    lines.push(`- **COMPETITOR_URLS**: ${context.competitorUrls.join(", ")}`)
  }
  lines.push(`- **TODAY_DATE**: ${today}`)
  return lines.join("\n")
}

/** The previous stage's output, which is this stage's chain input. */
function previousOutput(stage: Stage, context: PromptContext): string {
  const index = STAGES.indexOf(stage)
  if (index === 0) return ""
  const value = context[STAGE_OUTPUT_KEY[STAGES[index - 1]]]
  // The manifest is the only object-valued stage output.
  if (typeof value === "object" && value !== null) return pythonJsonDumps(value)
  return typeof value === "string" ? value : ""
}

/** Return one named Markdown section, stopping before the next heading. */
export function markdownSection(content: string, sectionName: string): string {
  const escaped = sectionName.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")
  const heading = new RegExp(`^#{1,6}\\s+${escaped}[ \\t]*$`, "im")
  const match = heading.exec(content)
  if (!match) return ""
  const tail = content.slice(match.index + match[0].length)
  const nextHeading = /^#{1,6}\s+.+$/m.exec(tail)
  const end = nextHeading ? match.index + match[0].length + nextHeading.index : content.length
  return content.slice(match.index, end).trim()
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
 * clock and tests must be deterministic.
 */
export function buildStagePrompt(
  stage: Stage,
  rules: string,
  context: PromptContext,
  today: string = new Date().toISOString().slice(0, 10),
): string {
  const sections: string[] = []

  if (rules) sections.push(rules)

  const config = buildConfigContext(stage, context, today)
  if (config) sections.push(config)

  const previous = previousOutput(stage, context)
  if (previous) sections.push(`## Previous Stage Output\n\n${previous}`)

  if (stage === "edit" || stage === "images") {
    const claimLedger = markdownSection(context.research, "Claim ledger")
    if (claimLedger) sections.push(claimLedger)
  }

  if (stage === "edit" && context.internalLinks.length > 0) {
    sections.push(buildLinksContext(context))
  }

  return sections.join("\n\n---\n\n")
}
