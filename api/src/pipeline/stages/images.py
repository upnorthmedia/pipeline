"""Images stage: manifest via Claude, generation via Gemini."""

from __future__ import annotations

import asyncio
import json
import logging
import random
from datetime import UTC, datetime
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

    # Timer wraps the entire stage (manifest + all image generation)
    with StageTimer() as timer:
        # Step 1: Generate image manifest via Claude
        rules = load_rules("images")
        await publish_stage_log("Rules loaded, building prompt...", stage="images")
        prompt = build_stage_prompt("images", rules, state)

        claude = ClaudeClient()
        await publish_stage_log("Calling Claude for image manifest...", stage="images")
        try:
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
            f"Manifest received ({response.tokens_out} tokens)",
            stage="images",
        )

        # Parse manifest JSON from response
        manifest = _parse_manifest(response.content)

        if manifest.get("error"):
            error_msg = manifest["error"]
            raw_snippet = response.content[:500]
            await publish_stage_log(
                f"Manifest parse failed: {error_msg}",
                stage="images",
                level="warning",
                event="log",
                data={"error": error_msg, "raw_snippet": raw_snippet},
            )
            meta = {
                "stage": "images",
                "model": response.model,
                "tokens_in": response.tokens_in,
                "tokens_out": response.tokens_out,
                "duration_s": timer.duration,
            }
            return {
                "image_manifest": manifest,
                "current_stage": "images",
                "stage_status": {
                    **state.get("stage_status", {}),
                    "images": "failed",
                },
                "_stage_meta": meta,
            }

        # Step 2: Generate images via Gemini
        num_images = len(manifest.get("images", []))
        await publish_stage_log(
            f"Generating {num_images} images via Gemini...", stage="images"
        )
        post_id = state.get("post_id", "unknown")
        media_dir = Path(settings.media_dir) / post_id
        media_dir.mkdir(parents=True, exist_ok=True)

        gemini = GeminiClient()
        sem = asyncio.Semaphore(3)

        async def _generate_one(i: int, image_spec: dict) -> dict:
            image_prompt = image_spec.get("prompt", "")
            if not image_prompt:
                return {
                    **image_spec,
                    "generated": False,
                    "error": "no prompt",
                    "index": i,
                }

            aspect_ratio = image_spec.get("aspect_ratio", "4:3")
            image_size = image_spec.get("image_size", "1K")

            if image_spec.get("placement") == "featured":
                image_size = "2K"
                if "aspect_ratio" not in image_spec:
                    aspect_ratio = "16:9"

            async with sem:
                try:
                    image_bytes = await gemini.generate_image(
                        prompt=image_prompt,
                        aspect_ratio=aspect_ratio,
                        image_size=image_size,
                    )
                    filename = image_spec.get("filename", f"image-{i}.png")

                    # Override featured image filename with date+random suffix
                    is_featured = (
                        image_spec.get("placement") == "featured"
                        or image_spec.get("type") == "featured"
                    )
                    if is_featured:
                        now = datetime.now(UTC)
                        date_str = now.strftime("%m%d%y")
                        rand_digits = f"{random.randint(10, 99)}"
                        filename = f"featured-{date_str}-{rand_digits}.png"
                    image_path = media_dir / filename
                    image_path.write_bytes(image_bytes)
                    image_url = f"/media/{post_id}/{filename}"

                    await publish_stage_log(
                        f"Image {i} generated ({len(image_bytes)} bytes)",
                        stage="images",
                        event="image_generated",
                        data={"index": i, "bytes": len(image_bytes), "path": image_url},
                    )
                    return {
                        **image_spec,
                        "generated": True,
                        "size_bytes": len(image_bytes),
                        "url": image_url,
                        "index": i,
                    }
                except Exception as e:
                    logger.error(f"Failed to generate image {i}: {e}")
                    await publish_stage_log(
                        f"Image {i} failed: {e}",
                        stage="images",
                        level="error",
                        event="image_failed",
                        data={"index": i, "error": str(e)},
                    )
                    return {
                        **image_spec,
                        "generated": False,
                        "error": str(e),
                        "index": i,
                    }

        tasks = [
            _generate_one(i, spec) for i, spec in enumerate(manifest.get("images", []))
        ]
        generated_images = list(await asyncio.gather(*tasks))

        manifest["images"] = generated_images
        manifest["total_generated"] = sum(
            1 for img in generated_images if img.get("generated")
        )
        manifest["total_failed"] = sum(
            1 for img in generated_images if not img.get("generated")
        )

    meta = {
        "stage": "images",
        "model": response.model,
        "tokens_in": response.tokens_in,
        "tokens_out": response.tokens_out,
        "duration_s": timer.duration,
    }

    return {
        "image_manifest": manifest,
        "current_stage": "images",
        "stage_status": {
            **state.get("stage_status", {}),
            "images": "complete",
        },
        "_stage_meta": meta,
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
