"""Research stage: Perplexity API for keyword research."""

from __future__ import annotations

import logging

from src.pipeline.helpers import (
    StageTimer,
    build_stage_prompt,
    load_rules,
    publish_stage_log,
)
from src.pipeline.state import PipelineState
from src.services.llm import LLMResponse, PerplexityClient

logger = logging.getLogger(__name__)


async def research_node(state: PipelineState) -> dict:
    """Execute the research stage using Perplexity API."""
    logger.info(f"Research stage starting for post {state.get('post_id')}")

    rules = load_rules("research")
    await publish_stage_log("Rules loaded, building prompt...", stage="research")
    prompt = build_stage_prompt("research", rules, state)

    client = PerplexityClient()
    await publish_stage_log("Calling Perplexity sonar-pro...", stage="research")
    try:
        with StageTimer() as timer:
            response: LLMResponse = await client.chat(
                prompt=prompt,
                system=(
                    "You are an expert SEO content researcher. "
                    "Provide thorough, actionable research."
                ),
            )
    finally:
        await client.close()

    await publish_stage_log(
        f"Received {response.tokens_out} tokens in {timer.duration:.1f}s",
        stage="research",
    )

    meta = {
        "stage": "research",
        "model": response.model,
        "tokens_in": response.tokens_in,
        "tokens_out": response.tokens_out,
        "duration_s": timer.duration,
    }

    return {
        "research": response.content,
        "current_stage": "research",
        "stage_status": {
            **state.get("stage_status", {}),
            "research": "complete",
        },
        "_stage_meta": meta,
    }
