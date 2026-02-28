"""Outline stage — calls Claude API to create structured blog outline."""

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


async def outline_node(state: PipelineState) -> dict:
    """Execute the outline stage using Claude API."""
    logger.info(f"Outline stage starting for post {state.get('post_id')}")

    rules = load_rules("outline")
    await publish_stage_log("Rules loaded, building prompt...", stage="outline")
    prompt = build_stage_prompt("outline", rules, state)

    client = ClaudeClient()
    await publish_stage_log("Calling Claude for outline...", stage="outline")
    try:
        with StageTimer() as timer:
            response: LLMResponse = await client.chat(
                prompt=prompt,
                system=(
                    "You are an expert content strategist. "
                    "Create detailed, SEO-optimized blog outlines."
                ),
                max_tokens=8000,
            )
    finally:
        await client.close()

    await publish_stage_log(
        f"Received {response.tokens_out} tokens in {timer.duration:.1f}s",
        stage="outline",
    )

    meta = {
        "stage": "outline",
        "model": response.model,
        "tokens_in": response.tokens_in,
        "tokens_out": response.tokens_out,
        "duration_s": timer.duration,
    }

    return {
        "outline": response.content,
        "current_stage": "outline",
        "stage_status": {
            **state.get("stage_status", {}),
            "outline": "complete",
        },
        "_stage_meta": meta,
    }
