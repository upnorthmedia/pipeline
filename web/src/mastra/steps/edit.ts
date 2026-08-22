/**
 * The `edit` stage as a Mastra step, ported from `edit_node` in
 * `api/src/pipeline/stages/edit.py`.
 *
 * This is the stage with the most around its provider call. Three things happen
 * that no other stage does:
 *
 * 1. the prompt gets an analytics section appended, built from
 *    `compute_analytics` over the draft the `write` stage committed, so the
 *    numbers the model is asked to fix are computed here rather than guessed at;
 * 2. the model's answer is re-analysed and its remaining quality problems are
 *    logged as warnings, which never block the run;
 * 3. every markdown link in the answer is checked over the network and the
 *    confirmed-dead ones are stripped before the result is committed.
 *
 * Steps 2 and 3 are both best-effort in Python and stay best-effort here: a
 * failure in either leaves the model's own output as the stage result rather
 * than failing a run that has already been paid for.
 */
import { createStep } from "@mastra/core/workflows/evented"

import { computeAnalytics } from "../analytics"
import { pythonFloat } from "../analytics/python-float"
import { validateLinks } from "../links"
import type { ValidationResult } from "../links"
import { loadPipelineState, saveStageOutput } from "../post-state"
import type { PipelineState } from "../post-state"
import { buildStagePrompt, loadRules } from "../prompts"
import { STATUS_COMPLETE } from "../state"
import {
  markRerunComplete,
  skippedStageOutput,
  shouldRunStage,
  stageStepInputSchema,
  stageStepOutputSchema,
} from "./stage-io"

/** The separator `edit_node` joins the rules prompt and the analytics section with. */
const ANALYTICS_SEPARATOR = "\n\n---\n\n"

/**
 * Python's `str.title()`, restricted to ASCII.
 *
 * The checklist keys are rendered with `check.replaceAll("_", " ").title()`, and
 * `title()` is not `capitalize each word`: it uppercases the first cased
 * character of every run of cased characters and lowercases the rest, so
 * `keyword_in_first_100_words` becomes `Keyword In First 100 Words`. Every key
 * `_seo_checklist` produces is ASCII snake_case, which is why the cased test
 * here is an ASCII one; a non-ASCII key would need Python's full Unicode
 * definition of "cased".
 */
function pythonTitleAscii(text: string): string {
  let out = ""
  let previousCased = false
  for (const character of text) {
    const cased = character >= "a" && character <= "z" ? true : character >= "A" && character <= "Z"
    out += cased
      ? previousCased
        ? character.toLowerCase()
        : character.toUpperCase()
      : character
    previousCased = cased
  }
  return out
}

/** The analytics `edit_node` computes, over whichever text it is handed. */
function analyticsOf(state: PipelineState, content: string) {
  const keywords = state.relatedKeywords
  return {
    primaryKeyword: keywords[0] ?? "",
    analytics: computeAnalytics(content, {
      primaryKeyword: keywords[0] ?? "",
      secondaryKeywords: keywords.slice(1),
      title: state.topic,
      websiteUrl: state.websiteUrl,
    }),
  }
}

/**
 * `_build_analytics_section`: the block appended to the edit prompt describing
 * how the draft scores today and, for anything failing, what to do about it.
 *
 * Returns `""` for a post with no draft, which is what suppresses the whole
 * section (separator included) rather than appending an empty one.
 */
export function buildAnalyticsSection(state: PipelineState): string {
  const draft = state.draft
  if (!draft) return ""

  const { primaryKeyword, analytics } = analyticsOf(state, draft)
  const targetWordCount = state.wordCount

  const lines = [
    "## Current Content Analytics",
    "",
    `- **Word Count:** ${analytics.wordCount} (target: ${targetWordCount})`,
    `- **Flesch Reading Ease:** ${pythonFloat(analytics.fleschReadingEase)}` +
      " (target: 60-70; lower means harder to read)",
    `- **Avg Sentence Length:** ${pythonFloat(analytics.avgSentenceLength)} words` +
      " (target: <20)",
  ]

  const densities = Object.entries(analytics.keywordDensity)
  if (densities.length > 0) {
    lines.push("")
    lines.push("### Keyword Density")
    for (const [keyword, density] of densities) {
      lines.push(`- **${keyword}:** ${pythonFloat(density)}% (target: 1-2%)`)
    }
  }

  const checks = Object.entries(analytics.seoChecklist)
  if (checks.length > 0) {
    lines.push("")
    lines.push("### SEO Checklist")
    const failed: string[] = []
    for (const [check, passed] of checks) {
      // The map also carries the two link *counts*, which are integers and are
      // deliberately not printed; Python filters them out with `isinstance(bool)`.
      if (typeof passed !== "boolean") continue
      lines.push(`- [${passed ? "PASS" : "FAIL"}] ${pythonTitleAscii(check.replaceAll("_", " "))}`)
      if (!passed) failed.push(check)
    }

    if (failed.length > 0) {
      lines.push("")
      // The em-dash is the product's prompt text, carried across verbatim for
      // the same reason `EDIT_SYSTEM_MESSAGE`'s are.
      lines.push("### ACTION REQUIRED — Fix These Failures")
      lines.push("You MUST resolve every [FAIL] item above during editing.")
      if (failed.includes("keyword_in_first_100_words")) {
        lines.push(
          `- INSERT the primary keyword '${primaryKeyword}' into the first paragraph naturally`,
        )
      }
      if (failed.includes("keyword_in_title")) {
        lines.push(`- ADD the primary keyword '${primaryKeyword}' to the title`)
      }
      if (failed.includes("keyword_in_h2")) {
        lines.push(
          `- INCLUDE the primary keyword '${primaryKeyword}' in at least one H2 heading`,
        )
      }
      if (failed.includes("has_internal_links")) {
        lines.push("- INSERT 3-5 internal links from the provided list")
      }
      if (failed.includes("has_external_links")) {
        lines.push("- INSERT 3 external links from authoritative sources")
      }
      if (analytics.fleschReadingEase < 55) {
        lines.push(
          `- SIMPLIFY: Current Flesch score is ${pythonFloat(analytics.fleschReadingEase)}. ` +
            "Break long sentences, use shorter words, target 60-70",
        )
      }
    }
  }

  return lines.join("\n")
}

/** One warning `_validate_edit_output` would have published, as text. */
export interface EditWarning {
  message: string
}

/**
 * `_validate_edit_output`, returned rather than published.
 *
 * Python sends these to the dashboard through `publish_stage_log(..., level=
 * "warning")`. The event bus that carries them is ledger item 5.5, so for now
 * the step logs them; returning them keeps the decision in one place and makes
 * them assertable without a logger spy.
 */
export function editOutputWarnings(state: PipelineState, content: string): EditWarning[] {
  const warnings: EditWarning[] = []

  const emDashes = content.split("—").length - 1
  if (emDashes > 0) {
    warnings.push({
      message: `Edit output contains ${emDashes} em-dash(es) — should be zero`,
    })
  }

  const { analytics } = analyticsOf(state, content)

  if (analytics.fleschReadingEase < 55) {
    warnings.push({
      message:
        `Flesch reading ease is ${pythonFloat(analytics.fleschReadingEase)} ` +
        "(target 60-70, still too hard to read)",
    })
  }

  const stillFailing = Object.entries(analytics.seoChecklist)
    .filter(([, passed]) => typeof passed === "boolean" && !passed)
    .map(([check]) => pythonTitleAscii(check.replaceAll("_", " ")))
  if (stillFailing.length > 0) {
    warnings.push({ message: `SEO checks still failing after edit: ${stillFailing.join(", ")}` })
  }

  return warnings
}

export const editStep = createStep({
  id: "edit",
  inputSchema: stageStepInputSchema,
  outputSchema: stageStepOutputSchema,
  execute: async ({ inputData, mastra }) => {
    const { postId } = inputData
    const state = await loadPipelineState(postId)
    if (!shouldRunStage("edit", inputData, state.stageStatus)) {
      return skippedStageOutput(inputData, "edit")
    }
    const rulesPrompt = buildStagePrompt("edit", loadRules("edit"), state)
    const analyticsSection = buildAnalyticsSection(state)
    const prompt = analyticsSection
      ? rulesPrompt + ANALYTICS_SEPARATOR + analyticsSection
      : rulesPrompt

    const startedAt = Date.now()
    const result = await mastra.getAgent("edit").generate(prompt)
    const durationMs = Date.now() - startedAt

    const logger = mastra.getLogger()
    for (const warning of editOutputWarnings(state, result.text)) {
      logger?.warn(warning.message, { postId, stage: "edit" })
    }

    let validation: ValidationResult
    try {
      validation = await validateLinks(result.text)
    } catch (error) {
      // Never blocks the pipeline: an unreachable network leaves the model's own
      // links in place rather than throwing away a paid-for edit.
      logger?.error("link validation failed, skipping", { postId, error })
      validation = { content: result.text, removed: [] }
    }

    if (validation.removed.length > 0) {
      logger?.warn(
        `Stripped ${validation.removed.length} dead link(s): ` +
          validation.removed.map((link) => link.url).join(", "),
        { postId, stage: "edit" },
      )
    }

    await saveStageOutput(postId, "edit", validation.content, {
      ...state.stageStatus,
      edit: STATUS_COMPLETE,
    })
    await markRerunComplete(inputData)

    return {
      postId,
      stages: inputData.stages,
      stage: "edit" as const,
      skipped: false,
      // The provider's own reported model id, not the one requested, so a
      // silent server-side alias shows up in the run trace.
      model: result.response?.modelId ?? "",
      tokensIn: result.usage?.inputTokens ?? 0,
      tokensOut: result.usage?.outputTokens ?? 0,
      durationS: durationMs / 1000,
    }
  },
})
