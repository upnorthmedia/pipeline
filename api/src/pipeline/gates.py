"""Review gate logic for pipeline stages.

Each gate checks the stage_settings to determine whether to:
- auto: pass through immediately
- review: interrupt with content for human editing, resume with edited content
- approve_only: interrupt for approval, resume without content change
"""

from __future__ import annotations

import logging
from typing import Literal

from langgraph.types import Command, interrupt

from src.pipeline.state import STAGES, PipelineState

logger = logging.getLogger(__name__)

# State key that holds the output for each stage
STAGE_OUTPUT_KEY: dict[str, str] = {
    "research": "research",
    "outline": "outline",
    "write": "draft",
    "edit": "final_md",
    "images": "image_manifest",
}


def _next_node_after_gate(stage: str) -> str:
    """Return the next node name after a gate, or '__end__' if last stage."""
    idx = STAGES.index(stage)
    if idx + 1 < len(STAGES):
        return f"{STAGES[idx + 1]}_node"
    return "__end__"


def make_gate(stage: str):
    """Factory that creates a gate function for a specific stage."""

    def gate_fn(
        state: PipelineState,
    ) -> Command[
        Literal[
            "research_node",
            "outline_node",
            "write_node",
            "edit_node",
            "images_node",
            "__end__",
        ]
    ]:
        mode = state.get("stage_settings", {}).get(stage, "review")
        output_key = STAGE_OUTPUT_KEY[stage]
        content = state.get(output_key, "")
        next_node = _next_node_after_gate(stage)

        if mode == "auto":
            logger.info(f"Gate [{stage}]: auto mode, proceeding to {next_node}")
            return Command(goto=next_node)

        elif mode == "review":
            logger.info(f"Gate [{stage}]: review mode, interrupting for human edit")
            edited = interrupt(
                {
                    "stage": stage,
                    "content": content,
                    "action": "review_and_edit",
                }
            )
            # Human may return edited content or None to keep original
            update: dict = {}
            if edited is not None and edited != content:
                update[output_key] = edited
            return Command(goto=next_node, update=update)

        elif mode == "approve_only":
            logger.info(f"Gate [{stage}]: approve_only mode, interrupting for approval")
            interrupt(
                {
                    "stage": stage,
                    "content": content,
                    "action": "approve",
                }
            )
            return Command(goto=next_node)

        else:
            logger.warning(
                f"Gate [{stage}]: unknown mode '{mode}', defaulting to review"
            )
            edited = interrupt(
                {
                    "stage": stage,
                    "content": content,
                    "action": "review_and_edit",
                }
            )
            update = {}
            if edited is not None and edited != content:
                update[output_key] = edited
            return Command(goto=next_node, update=update)

    gate_fn.__name__ = f"{stage}_gate"
    gate_fn.__qualname__ = f"{stage}_gate"
    return gate_fn


# Pre-built gate functions for each stage
research_gate = make_gate("research")
outline_gate = make_gate("outline")
write_gate = make_gate("write")
edit_gate = make_gate("edit")
images_gate = make_gate("images")
