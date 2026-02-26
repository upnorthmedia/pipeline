"""Tests for profile-driven post prefill on creation."""

import uuid

import pytest
from httpx import AsyncClient

pytestmark = pytest.mark.anyio


@pytest.fixture
async def profile_with_defaults(client: AsyncClient):
    """Create a profile with specific defaults for testing prefill."""
    resp = await client.post(
        "/api/profiles",
        json={
            "name": "Prefill Test Blog",
            "website_url": "https://prefilltest.com",
            "niche": "firearms",
            "target_audience": "gun enthusiasts",
            "tone": "Expert and authoritative",
            "brand_voice": "Knowledgeable but approachable",
            "word_count": 3000,
            "output_format": "wordpress",
            "image_style": "realistic photography",
            "image_brand_colors": ["#ff0000", "#000000"],
            "image_exclude": ["clipart"],
            "avoid": "political opinions",
            "required_mentions": "Check local laws",
            "related_keywords": ["ar-15", "build kit"],
            "default_stage_settings": {
                "research": "auto",
                "outline": "review",
                "write": "auto",
                "edit": "review",
                "images": "auto",
            },
        },
    )
    assert resp.status_code == 201
    return resp.json()


async def test_create_post_with_profile_prefill(
    client: AsyncClient, profile_with_defaults
):
    profile = profile_with_defaults
    resp = await client.post(
        "/api/posts",
        json={
            "slug": f"prefill-test-{uuid.uuid4().hex[:6]}",
            "topic": "Best AR-15 Build Kits",
            "profile_id": profile["id"],
        },
    )
    assert resp.status_code == 201
    post = resp.json()

    # Verify all prefilled fields
    assert post["niche"] == "firearms"
    assert post["target_audience"] == "gun enthusiasts"
    assert post["tone"] == "Expert and authoritative"
    assert post["brand_voice"] == "Knowledgeable but approachable"
    assert post["word_count"] == 3000
    assert post["output_format"] == "wordpress"
    assert post["website_url"] == "https://prefilltest.com"
    assert post["image_style"] == "realistic photography"
    assert post["image_brand_colors"] == ["#ff0000", "#000000"]
    assert post["image_exclude"] == ["clipart"]
    assert post["avoid"] == "political opinions"
    assert post["required_mentions"] == "Check local laws"
    assert post["related_keywords"] == ["ar-15", "build kit"]

    # Stage settings from profile defaults
    assert post["stage_settings"]["research"] == "auto"
    assert post["stage_settings"]["write"] == "auto"
    assert post["stage_settings"]["edit"] == "review"


async def test_create_post_explicit_values_override_profile(
    client: AsyncClient, profile_with_defaults
):
    """User-specified values should override profile defaults."""
    profile = profile_with_defaults
    resp = await client.post(
        "/api/posts",
        json={
            "slug": f"override-test-{uuid.uuid4().hex[:6]}",
            "topic": "Custom Topic",
            "profile_id": profile["id"],
            "word_count": 1500,
            "tone": "Casual and fun",
            "niche": "custom niche",
        },
    )
    assert resp.status_code == 201
    post = resp.json()

    assert post["word_count"] == 1500
    assert post["tone"] == "Casual and fun"
    assert post["niche"] == "custom niche"


async def test_create_post_invalid_profile_id(client: AsyncClient):
    fake_id = str(uuid.uuid4())
    resp = await client.post(
        "/api/posts",
        json={
            "slug": "bad-profile",
            "topic": "Test",
            "profile_id": fake_id,
        },
    )
    assert resp.status_code == 404


async def test_create_post_without_profile(client: AsyncClient):
    """Post without profile_id should use schema defaults."""
    resp = await client.post(
        "/api/posts",
        json={
            "slug": f"no-profile-{uuid.uuid4().hex[:6]}",
            "topic": "Standalone Post",
        },
    )
    assert resp.status_code == 201
    post = resp.json()

    assert post["profile_id"] is None
    assert post["word_count"] == 2000
    assert post["tone"] == "Conversational and friendly"
    assert post["output_format"] == "both"
