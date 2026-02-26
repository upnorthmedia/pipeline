"""Write stage — calls Claude API to produce the full blog draft."""

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


async def write_node(state: PipelineState) -> dict:
    """Execute the write stage using Claude API."""
    logger.info(f"Write stage starting for post {state.get('post_id')}")

    rules = load_rules("write")
    await publish_stage_log("Rules loaded, building prompt...", stage="write")
    prompt = build_stage_prompt("write", rules, state)

    client = ClaudeClient()
    await publish_stage_log("Calling Claude for draft (up to 16k tokens)...", stage="write")
    try:
        with StageTimer() as timer:
            response: LLMResponse = await client.chat(
                prompt=prompt,
                system=(
                    "You are an expert blog writer. Write "
                    "engaging, SEO-optimized content following "
                    "the outline exactly. Use a conversational "
                    "tone, short paragraphs, and varied sentence "
                    "structure. Never use em-dashes."
                ),
                max_tokens=16000,
            )
    finally:
        await client.close()

    await publish_stage_log(
        f"Received {response.tokens_out} tokens in {timer.duration:.1f}s",
        stage="write",
    )

    return {
        "draft": response.content,
        "current_stage": "write",
        "stage_status": {
            **state.get("stage_status", {}),
            "write": "complete",
        },
        "_stage_meta": {
            "stage": "write",
            "model": response.model,
            "tokens_in": response.tokens_in,
            "tokens_out": response.tokens_out,
            "duration_s": timer.duration,
        },
    }
