"""Tests for the ready stage pipeline integration."""

from src.pipeline.state import (
    STAGE_CONTENT_MAP,
    STAGE_OUTPUT_KEY,
    STAGE_PROVIDER_MAP,
    STAGE_RULES_MAP,
    STAGES,
)


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


def test_ready_in_stage_output_key():
    assert STAGE_OUTPUT_KEY["ready"] == "ready"


def test_ready_is_last_stage():
    """Ready is the final stage in the pipeline."""
    assert STAGES[-1] == "ready"


def test_images_before_ready():
    """Images stage comes right before ready."""
    images_idx = STAGES.index("images")
    ready_idx = STAGES.index("ready")
    assert ready_idx == images_idx + 1
