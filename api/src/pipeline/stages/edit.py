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
                    "You are an expert blog editor and SEO "
                    "specialist. Polish the draft, insert internal "
                    "and external links, optimize for SEO. "
                    "Never use em-dashes. " + format_instruction
                ),
                max_tokens=16000,
            )
    finally:
        await client.close()

    await publish_stage_log(
        f"Received {response.tokens_out} tokens in {timer.duration:.1f}s",
        stage="edit",
    )

    # Parse output into markdown and html parts
    content = response.content
    final_md = content
    final_html = ""

    if output_format == "both" and "---WORDPRESS_HTML---" in content:
        parts = content.split("---WORDPRESS_HTML---", 1)
        final_md = parts[0].strip()
        final_html = parts[1].strip()
    elif output_format == "wordpress":
        final_html = content
        final_md = ""

    result: dict = {
        "final_md": final_md,
        "current_stage": "edit",
        "stage_status": {
            **state.get("stage_status", {}),
            "edit": "complete",
        },
        "_stage_meta": {
            "stage": "edit",
            "model": response.model,
            "tokens_in": response.tokens_in,
            "tokens_out": response.tokens_out,
            "duration_s": timer.duration,
        },
    }

    if final_html:
        result["final_html"] = final_html

    return result
