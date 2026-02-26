"""Tests for the review gate logic."""

from unittest.mock import patch

import pytest
from src.pipeline.gates import (
    STAGE_OUTPUT_KEY,
    make_gate,
)
from src.pipeline.state import STAGES


class TestGateFactory:
    def test_make_gate_returns_callable(self):
        gate = make_gate("research")
        assert callable(gate)

    def test_gate_has_correct_name(self):
        gate = make_gate("outline")
        assert gate.__name__ == "outline_gate"

    def test_all_stages_have_output_keys(self):
        for stage in STAGES:
            assert stage in STAGE_OUTPUT_KEY


class TestAutoMode:
    def test_auto_mode_returns_command_to_next(self):
        gate = make_gate("research")
        state = {
            "stage_settings": {"research": "auto"},
            "research": "Research content here",
        }
        # Auto mode should return a Command with goto=next node
        # We can't easily test Command without LangGraph runtime,
        # but we can verify the gate function doesn't raise
        with patch("src.pipeline.gates.interrupt") as mock_interrupt:
            result = gate(state)
            mock_interrupt.assert_not_called()
            assert result.goto == "outline_node"

    def test_auto_mode_last_stage_goes_to_end(self):
        gate = make_gate("images")
        state = {
            "stage_settings": {"images": "auto"},
            "image_manifest": {"images": []},
        }
        with patch("src.pipeline.gates.interrupt"):
            result = gate(state)
            assert result.goto == "__end__"


class TestReviewMode:
    def test_review_mode_calls_interrupt(self):
        gate = make_gate("research")
        state = {
            "stage_settings": {"research": "review"},
            "research": "Original content",
        }
        with patch(
            "src.pipeline.gates.interrupt",
            return_value="Edited content",
        ) as mock_interrupt:
            gate(state)
            mock_interrupt.assert_called_once()
            call_args = mock_interrupt.call_args[0][0]
            assert call_args["stage"] == "research"
            assert call_args["content"] == "Original content"
            assert call_args["action"] == "review_and_edit"

    def test_review_mode_with_edits_updates_state(self):
        gate = make_gate("research")
        state = {
            "stage_settings": {"research": "review"},
            "research": "Original content",
        }
        with patch(
            "src.pipeline.gates.interrupt",
            return_value="Edited content",
        ):
            result = gate(state)
            assert result.update == {"research": "Edited content"}

    def test_review_mode_no_change_empty_update(self):
        gate = make_gate("research")
        state = {
            "stage_settings": {"research": "review"},
            "research": "Same content",
        }
        with patch(
            "src.pipeline.gates.interrupt",
            return_value="Same content",
        ):
            result = gate(state)
            assert result.update == {}

    def test_review_mode_none_response_empty_update(self):
        gate = make_gate("research")
        state = {
            "stage_settings": {"research": "review"},
            "research": "Content",
        }
        with patch(
            "src.pipeline.gates.interrupt",
            return_value=None,
        ):
            result = gate(state)
            assert result.update == {}


class TestApproveOnlyMode:
    def test_approve_only_calls_interrupt(self):
        gate = make_gate("outline")
        state = {
            "stage_settings": {"outline": "approve_only"},
            "outline": "Outline content",
        }
        with patch("src.pipeline.gates.interrupt") as mock_interrupt:
            gate(state)
            mock_interrupt.assert_called_once()
            call_args = mock_interrupt.call_args[0][0]
            assert call_args["action"] == "approve"

    def test_approve_only_does_not_update_content(self):
        gate = make_gate("outline")
        state = {
            "stage_settings": {"outline": "approve_only"},
            "outline": "Outline content",
        }
        with patch("src.pipeline.gates.interrupt"):
            result = gate(state)
            # approve_only should not have update
            assert not hasattr(result, "update") or result.update is None


class TestDefaultMode:
    def test_missing_settings_defaults_to_review(self):
        gate = make_gate("research")
        state = {
            "stage_settings": {},
            "research": "Content",
        }
        with patch(
            "src.pipeline.gates.interrupt",
            return_value="Edited",
        ) as mock_interrupt:
            gate(state)
            mock_interrupt.assert_called_once()


class TestGateRouting:
    @pytest.mark.parametrize(
        "stage,expected_next",
        [
            ("research", "outline_node"),
            ("outline", "write_node"),
            ("write", "edit_node"),
            ("edit", "images_node"),
            ("images", "__end__"),
        ],
    )
    def test_gate_routes_to_correct_next_node(self, stage, expected_next):
        gate = make_gate(stage)
        output_key = STAGE_OUTPUT_KEY[stage]
        state = {
            "stage_settings": {stage: "auto"},
            output_key: "content",
        }
        with patch("src.pipeline.gates.interrupt"):
            result = gate(state)
            assert result.goto == expected_next
