"""Ready stage: compose final publishable article with images embedded."""

from __future__ import annotations

import json
import logging

from src.pipeline.helpers import (
    StageTimer,
    load_rules,
    publish_stage_log,
)
from src.pipeline.state import PipelineState
from src.services.llm import ClaudeClient, LLMResponse

logger = logging.getLogger(__name__)


async def ready_node(state: PipelineState) -> dict:
    """Execute the ready stage.

    Takes final_md_content + image_manifest and produces the final
    publishable article with images strategically inserted, new
    frontmatter format, and no publishing notes.
    """
    logger.info(f"Ready stage starting for post {state.get('post_id')}")

    rules = load_rules("ready")
    await publish_stage_log("Rules loaded, building prompt...", stage="ready")

    prompt = _build_ready_prompt(rules, state)

    claude = ClaudeClient()
    await publish_stage_log("Calling Claude for final assembly...", stage="ready")
    try:
        with StageTimer() as timer:
            response: LLMResponse = await claude.chat(
                prompt=prompt,
                system=(
                    "You are a publishing specialist. Compose the final "
                    "publication-ready article by inserting images at strategic "
                    "placements, reformatting the frontmatter, and stripping "
                    "publishing notes. Output ONLY the final article content, "
                    "no explanations or commentary."
                ),
                max_tokens=16000,
            )
    finally:
        await claude.close()

    await publish_stage_log(
        f"Final assembly complete ({response.tokens_out} tokens in {timer.duration:.1f}s)",
        stage="ready",
    )

    return {
        "ready": response.content,
        "current_stage": "ready",
        "stage_status": {
            **state.get("stage_status", {}),
            "ready": "complete",
        },
        "_stage_meta": {
            "stage": "ready",
            "model": response.model,
            "tokens_in": response.tokens_in,
            "tokens_out": response.tokens_out,
            "duration_s": timer.duration,
        },
    }


def _build_ready_prompt(rules: str, state: PipelineState) -> str:
    """Build the prompt for the ready stage with all necessary context."""
    sections: list[str] = []

    if rules:
        sections.append(rules)

    # Post config
    sections.append(f"## Post Configuration\n\n- **SLUG**: {state.get('slug', '')}")
    sections.append(f"- **OUTPUT_FORMAT**: {state.get('output_format', 'markdown')}")

    # Final markdown content from edit stage
    final_md = state.get("final_md", "")
    if final_md:
        sections.append(f"## Final Markdown Content (from edit stage)\n\n{final_md}")

    # Image manifest — only include successfully generated images
    manifest = state.get("image_manifest", {})
    if manifest:
        images = manifest.get("images", [])
        generated_images = [img for img in images if img.get("generated", False)]
        filtered_manifest = {**manifest, "images": generated_images}
        sections.append(
            f"## Image Manifest (generated images only)\n\n"
            f"```json\n{json.dumps(filtered_manifest, indent=2)}\n```"
        )

    return "\n\n---\n\n".join(sections)
