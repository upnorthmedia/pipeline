"""Tests for the ready stage pipeline integration."""

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
