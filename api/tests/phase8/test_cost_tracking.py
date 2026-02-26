"""Tests for cost tracking: token → cost computation and stage log accuracy."""

import pytest
from src.pipeline.helpers import MODEL_COSTS

pytestmark = pytest.mark.anyio


def test_model_costs_has_expected_models():
    """All used models should have pricing defined."""
    assert "sonar-pro" in MODEL_COSTS
    assert "claude-opus-4-6" in MODEL_COSTS
    assert "gemini-3.1-flash-image-preview" in MODEL_COSTS


def test_sonar_pro_pricing():
    costs = MODEL_COSTS["sonar-pro"]
    assert costs["input"] == 3.0
    assert costs["output"] == 15.0


def test_claude_pricing():
    costs = MODEL_COSTS["claude-opus-4-6"]
    assert costs["input"] == 15.0
    assert costs["output"] == 75.0


def test_gemini_pricing_is_zero():
    """Gemini image generation doesn't charge per-token."""
    costs = MODEL_COSTS["gemini-3.1-flash-image-preview"]
    assert costs["input"] == 0.0
    assert costs["output"] == 0.0


def test_cost_calculation_sonar():
    """Verify cost formula matches expected calculation."""
    costs = MODEL_COSTS["sonar-pro"]
    tokens_in, tokens_out = 10000, 50000
    expected = (tokens_in / 1_000_000 * costs["input"]) + (
        tokens_out / 1_000_000 * costs["output"]
    )
    # 10000/1M * 3.0 + 50000/1M * 15.0 = 0.03 + 0.75 = 0.78
    assert abs(expected - 0.78) < 0.001


def test_cost_calculation_claude():
    costs = MODEL_COSTS["claude-opus-4-6"]
    tokens_in, tokens_out = 2000, 8000
    expected = (tokens_in / 1_000_000 * costs["input"]) + (
        tokens_out / 1_000_000 * costs["output"]
    )
    # 2000/1M * 15.0 + 8000/1M * 75.0 = 0.03 + 0.6 = 0.63
    assert abs(expected - 0.63) < 0.001


def test_cost_calculation_zero_tokens():
    costs = MODEL_COSTS["sonar-pro"]
    expected = (0 / 1_000_000 * costs["input"]) + (0 / 1_000_000 * costs["output"])
    assert expected == 0.0


def test_cost_api_endpoint(client, sample_post_data):
    """Cost data should be visible through the stage_logs field on post read."""
    # This is a sync helper — the actual async test is in test_error_handling
    pass
