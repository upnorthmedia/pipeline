"""Tests for stage output key mapping (formerly in gates.py, now in state.py)."""

from src.pipeline.state import STAGE_OUTPUT_KEY, STAGES


class TestStageOutputKey:
    def test_all_stages_have_output_keys(self):
        for stage in STAGES:
            assert stage in STAGE_OUTPUT_KEY

    def test_output_keys_are_correct(self):
        assert STAGE_OUTPUT_KEY["research"] == "research"
        assert STAGE_OUTPUT_KEY["outline"] == "outline"
        assert STAGE_OUTPUT_KEY["write"] == "draft"
        assert STAGE_OUTPUT_KEY["edit"] == "final_md"
        assert STAGE_OUTPUT_KEY["images"] == "image_manifest"
        assert STAGE_OUTPUT_KEY["ready"] == "ready"
