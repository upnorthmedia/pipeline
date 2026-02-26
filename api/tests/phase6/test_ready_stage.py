"""Tests for the ready stage pipeline integration."""

from src.pipeline.gates import STAGE_OUTPUT_KEY, _next_node_after_gate, ready_gate
from src.pipeline.state import STAGES, STAGE_CONTENT_MAP, STAGE_PROVIDER_MAP, STAGE_RULES_MAP


def test_ready_in_stages():
    assert "ready" in STAGES
    assert STAGES[-1] == "ready"
    assert STAGES.index("ready") == 5


def test_ready_in_content_map():
    assert STAGE_CONTENT_MAP["ready"] == "ready_content"


def test_ready_in_provider_map():
    assert STAGE_PROVIDER_MAP["ready"] == "claude"


def test_ready_in_rules_map():
    assert STAGE_RULES_MAP["ready"] == "blog-ready.md"


def test_ready_gate_exists():
    assert callable(ready_gate)


def test_ready_in_stage_output_key():
    assert STAGE_OUTPUT_KEY["ready"] == "ready"


def test_ready_gate_is_terminal():
    """Ready gate should route to __end__ since it's the last stage."""
    assert _next_node_after_gate("ready") == "__end__"


def test_images_gate_routes_to_ready():
    assert _next_node_after_gate("images") == "ready_node"
