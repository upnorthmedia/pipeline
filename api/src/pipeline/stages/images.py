"""Images stage: manifest via Claude, generation via Gemini."""

from __future__ import annotations

import json
import logging
from pathlib import Path

from src.config import settings
from src.pipeline.helpers import (
    StageTimer,
    build_stage_prompt,
    load_rules,
    publish_stage_log,
)
from src.pipeline.state import PipelineState
from src.services.llm import ClaudeClient, GeminiClient, LLMResponse

logger = logging.getLogger(__name__)


async def images_node(state: PipelineState) -> dict:
    """Execute the images stage.

    Step 1: Use Claude to generate an image manifest (prompts, placements, alt text)
    Step 2: Use Gemini to generate each image from the manifest
    """
    logger.info(f"Images stage starting for post {state.get('post_id')}")

    # Step 1: Generate image manifest via Claude
    rules = load_rules("images")
    await publish_stage_log("Rules loaded, building prompt...", stage="images")
    prompt = build_stage_prompt("images", rules, state)

    claude = ClaudeClient()
    await publish_stage_log("Calling Claude for image manifest...", stage="images")
    try:
        with StageTimer() as timer:
            response: LLMResponse = await claude.chat(
                prompt=prompt,
                system=(
                    "You are an expert at crafting image generation "
                    "prompts. Create a JSON image manifest with "
                    "detailed prompts for each image placement. "
                    "Output ONLY valid JSON, no code fences."
                ),
                max_tokens=8000,
            )
    finally:
        await claude.close()

    await publish_stage_log(
        f"Manifest received ({response.tokens_out} tokens in {timer.duration:.1f}s)",
        stage="images",
    )

    # Parse manifest JSON from response
    manifest = _parse_manifest(response.content)

    # Step 2: Generate images via Gemini
    num_images = len(manifest.get("images", []))
    await publish_stage_log(
        f"Generating {num_images} images via Gemini...", stage="images"
    )
    post_id = state.get("post_id", "unknown")
    media_dir = Path(settings.media_dir) / post_id
    media_dir.mkdir(parents=True, exist_ok=True)

    gemini = GeminiClient()
    generated_images: list[dict] = []
    try:
        for i, image_spec in enumerate(manifest.get("images", [])):
            image_prompt = image_spec.get("prompt", "")
            if not image_prompt:
                continue

            aspect_ratio = image_spec.get("aspect_ratio", "4:3")
            image_size = image_spec.get("image_size", "1K")

            # Featured images are larger
            if image_spec.get("placement") == "featured":
                image_size = "2K"
                if "aspect_ratio" not in image_spec:
                    aspect_ratio = "16:9"

            try:
                image_bytes = await gemini.generate_image(
                    prompt=image_prompt,
                    aspect_ratio=aspect_ratio,
                    image_size=image_size,
                )
                # Save image to disk
                filename = image_spec.get("filename", f"image-{i}.png")
                image_path = media_dir / filename
                image_path.write_bytes(image_bytes)
                image_url = f"/media/{post_id}/{filename}"

                generated_images.append(
                    {
                        **image_spec,
                        "generated": True,
                        "size_bytes": len(image_bytes),
                        "url": image_url,
                        "index": i,
                    }
                )
                logger.info(
                    f"Generated image {i}: {len(image_bytes)} bytes"
                    f" -> {image_url}"
                )
            except Exception as e:
                logger.error(f"Failed to generate image {i}: {e}")
                generated_images.append(
                    {
                        **image_spec,
                        "generated": False,
                        "error": str(e),
                        "index": i,
                    }
                )
    finally:
        pass  # GeminiClient doesn't need explicit close

    manifest["images"] = generated_images
    manifest["total_generated"] = sum(
        1 for img in generated_images if img.get("generated")
    )
    manifest["total_failed"] = sum(
        1 for img in generated_images if not img.get("generated")
    )

    return {
        "image_manifest": manifest,
        "current_stage": "images",
        "stage_status": {
            **state.get("stage_status", {}),
            "images": "complete",
        },
        "_stage_meta": {
            "stage": "images",
            "model": response.model,
            "tokens_in": response.tokens_in,
            "tokens_out": response.tokens_out,
            "duration_s": timer.duration,
        },
    }


def _parse_manifest(content: str) -> dict:
    """Parse image manifest JSON from Claude response."""
    text = content.strip()

    # Strip markdown code fences if present
    if text.startswith("```"):
        lines = text.split("\n")
        lines = [line for line in lines if not line.strip().startswith("```")]
        text = "\n".join(lines)

    try:
        return json.loads(text)
    except json.JSONDecodeError:
        logger.warning("Failed to parse image manifest JSON, returning empty manifest")
        return {"images": [], "style_brief": {}, "error": "Failed to parse manifest"}
