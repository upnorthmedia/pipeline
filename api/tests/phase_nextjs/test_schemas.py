from __future__ import annotations

from src.models.schemas import ProfileCreate, ProfileUpdate, ProfileRead, PostRead


def test_profile_create_accepts_nextjs_fields():
    profile = ProfileCreate(
        name="Test",
        website_url="https://test.com",
        nextjs_webhook_url="https://test.com/api/jena-webhook",
        nextjs_webhook_secret="my-secret",
        nextjs_frontmatter_map={"title": "title"},
    )
    assert profile.nextjs_webhook_url == "https://test.com/api/jena-webhook"
    assert profile.nextjs_webhook_secret == "my-secret"


def test_profile_update_accepts_nextjs_fields():
    update = ProfileUpdate(nextjs_webhook_url="https://new.com/api/jena-webhook")
    assert update.nextjs_webhook_url == "https://new.com/api/jena-webhook"


def test_profile_read_excludes_webhook_secret():
    read = ProfileRead(
        id="00000000-0000-0000-0000-000000000000",
        name="Test",
        website_url="https://test.com",
        nextjs_webhook_url="https://test.com/api/jena-webhook",
        created_at="2026-01-01T00:00:00Z",
        updated_at="2026-01-01T00:00:00Z",
    )
    data = read.model_dump()
    assert "nextjs_webhook_secret" not in data
    assert data["nextjs_webhook_url"] == "https://test.com/api/jena-webhook"


def test_post_read_includes_nextjs_status():
    post = PostRead(
        id="00000000-0000-0000-0000-000000000000",
        slug="test",
        topic="Test",
        nextjs_publish_status="published",
        created_at="2026-01-01T00:00:00Z",
        updated_at="2026-01-01T00:00:00Z",
    )
    assert post.nextjs_publish_status == "published"
