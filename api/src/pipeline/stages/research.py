"""Research stage: Perplexity API for keyword research."""

from __future__ import annotations

import logging
import re

from src.pipeline.helpers import (
    StageTimer,
    build_stage_prompt,
    load_rules,
    publish_stage_log,
)
from src.pipeline.state import PipelineState
from src.services.llm import LLMResponse, PerplexityClient

logger = logging.getLogger(__name__)

# Phrases that indicate Perplexity returned a meta-response instead of research
_REFUSAL_PATTERNS = [
    r"I'm\s+\*?\*?Perplexity\*?\*?",
    r"I(?:'m| am) a search assistant",
    r"I need to clarify my role",
    r"I(?:'m| am) not a blog research agent",
    r"I can(?:not|'t) (?:create|execute|generate|access)",
    r"What I \*?can\*? do instead",
    r"To move forward",
    r"Please provide (?:either|new search results)",
    r"Which would be most helpful\?",
]
_REFUSAL_RE = re.compile("|".join(_REFUSAL_PATTERNS), re.IGNORECASE)

# Sections we expect in valid research output
_EXPECTED_SECTIONS = ["keyword", "pain point", "competitor", "search intent"]

MAX_RESEARCH_ATTEMPTS = 3


def _is_valid_research(content: str) -> bool:
    """Return True if the response looks like actual research, not a meta-response."""
    if _REFUSAL_RE.search(content):
        return False
    content_lower = content.lower()
    matches = sum(1 for s in _EXPECTED_SECTIONS if s in content_lower)
    if matches < 2:
        return False
    return True


async def research_node(state: PipelineState) -> dict:
    """Execute the research stage using Perplexity API."""
    logger.info(f"Research stage starting for post {state.get('post_id')}")

    rules = load_rules("research")
    await publish_stage_log("Rules loaded, building prompt...", stage="research")
    prompt = build_stage_prompt("research", rules, state)

    system_msg = (
        "You are an expert SEO content researcher. "
        "Respond ONLY with the research document in markdown format. "
        "Do not discuss your capabilities or ask clarifying questions. "
        "Produce the complete research directly."
    )

    client = PerplexityClient(api_key=state.get("api_keys", {}).get("perplexity"))
    try:
        response: LLMResponse | None = None
        total_tokens_in = 0
        total_tokens_out = 0
        total_duration = 0.0

        for attempt in range(1, MAX_RESEARCH_ATTEMPTS + 1):
            msg = (
                f"Calling Perplexity sonar-pro "
                f"(attempt {attempt}/{MAX_RESEARCH_ATTEMPTS})..."
                if attempt > 1
                else "Calling Perplexity sonar-pro..."
            )
            await publish_stage_log(msg, stage="research")

            with StageTimer() as timer:
                response = await client.chat(
                    prompt=prompt if attempt == 1 else _reinforced_prompt(prompt),
                    system=system_msg,
                )

            total_tokens_in += response.tokens_in
            total_tokens_out += response.tokens_out
            total_duration += timer.duration

            if _is_valid_research(response.content):
                break

            logger.warning(
                f"Research attempt {attempt} returned meta-response, "
                f"retrying... (tokens: {response.tokens_out})"
            )
            await publish_stage_log(
                f"Response validation failed (attempt {attempt}), retrying...",
                stage="research",
                level="warning",
            )
        else:
            # All attempts returned invalid responses — use last response but log error
            logger.error(
                "All research attempts returned meta-responses. "
                "Using last response as fallback."
            )
            await publish_stage_log(
                "WARNING: Research quality may be degraded — "
                "Perplexity returned unexpected responses.",
                stage="research",
                level="error",
            )
    finally:
        await client.close()

    assert response is not None  # guaranteed by loop

    await publish_stage_log(
        f"Received {total_tokens_out} tokens in {total_duration:.1f}s",
        stage="research",
    )

    meta = {
        "stage": "research",
        "model": response.model,
        "tokens_in": total_tokens_in,
        "tokens_out": total_tokens_out,
        "duration_s": total_duration,
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


def _reinforced_prompt(original_prompt: str) -> str:
    """Wrap the original prompt with stronger instructions for retry attempts."""
    return (
        "IMPORTANT: You must respond with ONLY the research document content. "
        "Do NOT describe yourself, your limitations, or ask questions. "
        "Do NOT say you are Perplexity or a search assistant. "
        "Simply produce the research document as specified.\n\n" + original_prompt
    )
