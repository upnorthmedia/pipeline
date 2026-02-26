"""Tests for PipelineState TypedDict and state_from_post helper."""

import uuid

from src.pipeline.state import (
    GATE_MODES,
    STAGE_CONTENT_MAP,
    STAGE_PROVIDER_MAP,
    STAGE_RULES_MAP,
    STAGES,
    PipelineState,
    state_from_post,
)


class TestConstants:
    def test_stages_order(self):
        assert STAGES == ["research", "outline", "write", "edit", "images", "ready"]

    def test_stage_content_map_covers_all_stages(self):
        for stage in STAGES:
            assert stage in STAGE_CONTENT_MAP

    def test_stage_provider_map_covers_all_stages(self):
        for stage in STAGES:
            assert stage in STAGE_PROVIDER_MAP

    def test_stage_rules_map_covers_all_stages(self):
        for stage in STAGES:
            assert stage in STAGE_RULES_MAP
            assert STAGE_RULES_MAP[stage].endswith(".md")

    def test_gate_modes(self):
        assert "auto" in GATE_MODES
        assert "review" in GATE_MODES
        assert "approve_only" in GATE_MODES


class TestPipelineState:
    def test_create_minimal_state(self):
        state: PipelineState = {
            "post_id": "abc",
            "topic": "Test topic",
        }
        assert state["post_id"] == "abc"
        assert state["topic"] == "Test topic"

    def test_create_full_state(self):
        state: PipelineState = {
            "post_id": str(uuid.uuid4()),
            "slug": "test-post",
            "profile_id": str(uuid.uuid4()),
            "topic": "Test topic",
            "target_audience": "developers",
            "niche": "tech",
            "intent": "informational",
            "word_count": 2000,
            "tone": "friendly",
            "output_format": "both",
            "website_url": "https://example.com",
            "related_keywords": ["python", "api"],
            "competitor_urls": [],
            "image_style": "photorealistic",
            "image_brand_colors": ["#000"],
            "image_exclude": [],
            "brand_voice": "casual",
            "avoid": "jargon",
            "required_mentions": "",
            "internal_links": [],
            "research": "",
            "outline": "",
            "draft": "",
            "final_md": "",
            "final_html": "",
            "image_manifest": {},
            "current_stage": "pending",
            "stage_settings": {s: "review" for s in STAGES},
            "stage_status": {},
        }
        assert state["word_count"] == 2000
        assert len(state["stage_settings"]) == 6


class FakePost:
    """Minimal mock of the Post ORM model."""

    def __init__(self, **kwargs):
        defaults = {
            "id": uuid.uuid4(),
            "slug": "test-slug",
            "profile_id": uuid.uuid4(),
            "topic": "Test Topic",
            "target_audience": "devs",
            "niche": "tech",
            "intent": "informational",
            "word_count": 2000,
            "tone": "Conversational and friendly",
            "output_format": "both",
            "website_url": "https://example.com",
            "related_keywords": ["kw1"],
            "competitor_urls": [],
            "image_style": None,
            "image_brand_colors": [],
            "image_exclude": [],
            "brand_voice": None,
            "avoid": None,
            "required_mentions": None,
            "research_content": None,
            "outline_content": None,
            "draft_content": None,
            "final_md_content": None,
            "final_html_content": None,
            "image_manifest": None,
            "ready_content": None,
            "current_stage": "pending",
            "stage_settings": {s: "review" for s in STAGES},
            "stage_status": {},
        }
        defaults.update(kwargs)
        for k, v in defaults.items():
            setattr(self, k, v)


class TestStateFromPost:
    def test_basic_conversion(self):
        post = FakePost()
        state = state_from_post(post)
        assert state["post_id"] == str(post.id)
        assert state["slug"] == "test-slug"
        assert state["topic"] == "Test Topic"
        assert state["word_count"] == 2000

    def test_none_fields_become_empty(self):
        post = FakePost(brand_voice=None, avoid=None)
        state = state_from_post(post)
        assert state["brand_voice"] == ""
        assert state["avoid"] == ""

    def test_with_internal_links(self):
        links = [
            {"url": "/page1/", "title": "Page 1"},
            {"url": "/page2/", "title": "Page 2"},
        ]
        post = FakePost()
        state = state_from_post(post, internal_links=links)
        assert len(state["internal_links"]) == 2

    def test_existing_content_preserved(self):
        post = FakePost(
            research_content="Research data here",
            current_stage="outline",
        )
        state = state_from_post(post)
        assert state["research"] == "Research data here"
        assert state["current_stage"] == "outline"

    def test_no_profile_id(self):
        post = FakePost(profile_id=None)
        state = state_from_post(post)
        assert state["profile_id"] == ""
