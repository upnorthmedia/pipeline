"""Edit stage: SEO optimization, link insertion, final polish."""

from __future__ import annotations

import logging

from src.pipeline.helpers import (
    StageTimer,
    build_stage_prompt,
    load_rules,
    publish_stage_log,
)
from src.pipeline.state import PipelineState
from src.services.analytics import compute_analytics
from src.services.link_validator import (
    ValidationResult,
    strip_dead_links_html,
    validate_links,
)
from src.services.llm import ClaudeClient, LLMResponse

logger = logging.getLogger(__name__)


async def edit_node(state: PipelineState) -> dict:
    """Execute the edit stage using Claude API.

    This stage:
    - Polishes the draft for SEO
    - Inserts internal links from the profile's link database
    - Inserts external links
    - Produces final.md and optionally final.html
    """
    logger.info(f"Edit stage starting for post {state.get('post_id')}")

    rules = load_rules("edit")
    await publish_stage_log("Rules loaded, building prompt...", stage="edit")
    prompt = build_stage_prompt("edit", rules, state)

    analytics_section = _build_analytics_section(state)
    if analytics_section:
        prompt = prompt + "\n\n---\n\n" + analytics_section

    # Build system prompt with output format instructions
    output_format = state.get("output_format", "both")
    format_instruction = ""
    if output_format == "markdown":
        format_instruction = "Output only the final Markdown with YAML frontmatter."
    elif output_format == "wordpress":
        format_instruction = "Output only WordPress Gutenberg HTML blocks."
    else:
        format_instruction = (
            "Output both formats. First the complete Markdown "
            "with YAML frontmatter, then after a separator "
            "'---WORDPRESS_HTML---', the WordPress Gutenberg HTML."
        )

    client = ClaudeClient()
    await publish_stage_log("Calling Claude for editing + SEO polish...", stage="edit")
    try:
        with StageTimer() as timer:
            response: LLMResponse = await client.chat(
                prompt=prompt,
                system=(
                    "You are an expert blog editor and SEO specialist. "
                    "CRITICAL REQUIREMENTS — violations will cause rejection:\n"
                    "1. ZERO em-dashes (—) anywhere in output\n"
                    "2. ZERO line separators (---, ***, ___) between sections\n"
                    "3. ALL links must be real, working URLs inserted inline\n"
                    "4. Insert 3-5 internal links from the provided list\n"
                    "5. Insert 3 external links from authoritative sources\n"
                    "6. Primary keyword MUST appear in title, "
                    "first 100 words, and at least one H2\n"
                    "7. Flesch reading ease MUST be 60-70 "
                    "- simplify sentences and vocabulary\n"
                    "8. No filler phrases, no generic AI language\n"
                    "Fix ALL items marked [FAIL] in the analytics section. "
                    + format_instruction
                ),
                max_tokens=16000,
            )
    finally:
        await client.close()

    await publish_stage_log(
        f"Received {response.tokens_out} tokens in {timer.duration:.1f}s",
        stage="edit",
    )

    # Post-edit validation (log warnings, don't block pipeline)
    await _validate_edit_output(response.content, state)

    # Validate links — strip confirmed 404s (best-effort, never blocks pipeline)
    try:
        validation = await validate_links(response.content)
    except Exception:
        logger.exception("Link validation failed, skipping")
        validation = ValidationResult(content=response.content)

    if validation.removed:
        urls = [r.url for r in validation.removed]
        await publish_stage_log(
            f"Stripped {len(validation.removed)} dead link(s): {', '.join(urls)}",
            stage="edit",
            level="warning",
        )

    # Parse output into markdown and html parts
    content = validation.content
    final_md = content
    final_html = ""

    if output_format == "both" and "---WORDPRESS_HTML---" in content:
        parts = content.split("---WORDPRESS_HTML---", 1)
        final_md = parts[0].strip()
        final_html = parts[1].strip()
    elif output_format == "wordpress":
        final_html = content
        final_md = ""

    meta = {
        "stage": "edit",
        "model": response.model,
        "tokens_in": response.tokens_in,
        "tokens_out": response.tokens_out,
        "duration_s": timer.duration,
    }

    result: dict = {
        "final_md": final_md,
        "current_stage": "edit",
        "stage_status": {
            **state.get("stage_status", {}),
            "edit": "complete",
        },
        "_stage_meta": meta,
    }

    if final_html:
        if validation.removed:
            dead_urls = {r.url for r in validation.removed}
            final_html = strip_dead_links_html(final_html, dead_urls)
        result["final_html"] = final_html

    return result


def _build_analytics_section(state: PipelineState) -> str:
    """Build a content analytics section for the edit prompt."""
    draft = state.get("draft", "")
    if not draft:
        return ""

    keywords = state.get("related_keywords", [])
    primary_keyword = keywords[0] if keywords else ""
    secondary_keywords = keywords[1:] if len(keywords) > 1 else []

    analytics = compute_analytics(
        content=draft,
        primary_keyword=primary_keyword,
        secondary_keywords=secondary_keywords,
        title=state.get("topic", ""),
        website_url=state.get("website_url", ""),
    )

    target_wc = state.get("word_count", 2000)
    lines = [
        "## Current Content Analytics",
        "",
        f"- **Word Count:** {analytics.word_count} (target: {target_wc})",
        f"- **Flesch Reading Ease:** {analytics.flesch_reading_ease}"
        " (target: 60-70; lower means harder to read)",
        f"- **Avg Sentence Length:** {analytics.avg_sentence_length} words"
        " (target: <20)",
    ]

    if analytics.keyword_density:
        lines.append("")
        lines.append("### Keyword Density")
        for kw, density in analytics.keyword_density.items():
            lines.append(f"- **{kw}:** {density}% (target: 1-2%)")

    if analytics.seo_checklist:
        lines.append("")
        lines.append("### SEO Checklist")
        fail_items = []
        for check, passed in analytics.seo_checklist.items():
            if isinstance(passed, bool):
                icon = "PASS" if passed else "FAIL"
                label = check.replace("_", " ").title()
                lines.append(f"- [{icon}] {label}")
                if not passed:
                    fail_items.append(check)

        if fail_items:
            lines.append("")
            lines.append("### ACTION REQUIRED — Fix These Failures")
            lines.append("You MUST resolve every [FAIL] item above during editing.")
            if "keyword_in_first_100_words" in fail_items:
                lines.append(
                    f"- INSERT the primary keyword '{primary_keyword}' "
                    "into the first paragraph naturally"
                )
            if "keyword_in_title" in fail_items:
                lines.append(
                    f"- ADD the primary keyword '{primary_keyword}' to the title"
                )
            if "keyword_in_h2" in fail_items:
                lines.append(
                    f"- INCLUDE the primary keyword '{primary_keyword}' "
                    "in at least one H2 heading"
                )
            if "has_internal_links" in fail_items:
                lines.append("- INSERT 3-5 internal links from the provided list")
            if "has_external_links" in fail_items:
                lines.append("- INSERT 3 external links from authoritative sources")
            if analytics.flesch_reading_ease < 55:
                lines.append(
                    "- SIMPLIFY: Current Flesch score is "
                    f"{analytics.flesch_reading_ease}. "
                    "Break long sentences, use shorter "
                    "words, target 60-70"
                )

    return "\n".join(lines)


async def _validate_edit_output(content: str, state: PipelineState) -> None:
    """Run post-edit validation and log warnings for quality issues."""
    # Check for em-dashes
    if "\u2014" in content:
        em_count = content.count("\u2014")
        await publish_stage_log(
            f"Edit output contains {em_count} em-dash(es) — should be zero",
            stage="edit",
            level="warning",
        )

    # Run analytics on the output
    keywords = state.get("related_keywords", [])
    primary_keyword = keywords[0] if keywords else ""
    secondary_keywords = keywords[1:] if len(keywords) > 1 else []

    analytics = compute_analytics(
        content=content,
        primary_keyword=primary_keyword,
        secondary_keywords=secondary_keywords,
        title=state.get("topic", ""),
        website_url=state.get("website_url", ""),
    )

    # Log Flesch score warning
    if analytics.flesch_reading_ease < 55:
        await publish_stage_log(
            f"Flesch reading ease is {analytics.flesch_reading_ease} "
            "(target 60-70, still too hard to read)",
            stage="edit",
            level="warning",
        )

    # Log remaining SEO failures
    if analytics.seo_checklist:
        fails = [
            check.replace("_", " ").title()
            for check, passed in analytics.seo_checklist.items()
            if isinstance(passed, bool) and not passed
        ]
        if fails:
            await publish_stage_log(
                f"SEO checks still failing after edit: {', '.join(fails)}",
                stage="edit",
                level="warning",
            )
