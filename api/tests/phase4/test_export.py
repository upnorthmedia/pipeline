"""Tests for export endpoints (markdown, HTML, ZIP)."""

import io
import json
import uuid
import zipfile

import pytest
from httpx import AsyncClient

pytestmark = pytest.mark.anyio


@pytest.fixture
async def post_with_content(client: AsyncClient, sample_post_data):
    """Create a post with all stage content populated."""
    create_resp = await client.post("/api/posts", json=sample_post_data)
    post = create_resp.json()

    await client.patch(
        f"/api/posts/{post['id']}",
        json={
            "research_content": "# Research\n\nKeyword analysis results.",
            "outline_content": "# Outline\n\n## Section 1\n## Section 2",
            "draft_content": "# Draft\n\nFull blog post draft content.",
            "final_md_content": (
                "---\ntitle: Test Post\n---\n\n# Final Post\n\nPublished content."
            ),
            "final_html_content": (
                "<!-- wp:paragraph --><p>WordPress content</p><!-- /wp:paragraph -->"
            ),
        },
    )
    # Refresh
    resp = await client.get(f"/api/posts/{post['id']}")
    return resp.json()


async def test_export_markdown(client: AsyncClient, post_with_content):
    post = post_with_content
    resp = await client.get(f"/api/posts/{post['id']}/export/markdown")
    assert resp.status_code == 200
    assert resp.headers["content-type"] == "text/markdown; charset=utf-8"
    assert "attachment" in resp.headers["content-disposition"]
    assert post["slug"] in resp.headers["content-disposition"]
    assert resp.text == post["final_md_content"]


async def test_export_html(client: AsyncClient, post_with_content):
    post = post_with_content
    resp = await client.get(f"/api/posts/{post['id']}/export/html")
    assert resp.status_code == 200
    assert "text/html" in resp.headers["content-type"]
    assert resp.text == post["final_html_content"]


async def test_export_markdown_no_content(client: AsyncClient, sample_post_data):
    create_resp = await client.post("/api/posts", json=sample_post_data)
    post = create_resp.json()

    resp = await client.get(f"/api/posts/{post['id']}/export/markdown")
    assert resp.status_code == 404


async def test_export_html_no_content(client: AsyncClient, sample_post_data):
    create_resp = await client.post("/api/posts", json=sample_post_data)
    post = create_resp.json()

    resp = await client.get(f"/api/posts/{post['id']}/export/html")
    assert resp.status_code == 404


async def test_export_all_zip(client: AsyncClient, post_with_content):
    post = post_with_content
    resp = await client.get(f"/api/posts/{post['id']}/export/all")
    assert resp.status_code == 200
    assert resp.headers["content-type"] == "application/zip"

    buf = io.BytesIO(resp.content)
    with zipfile.ZipFile(buf) as zf:
        names = zf.namelist()
        assert "00-input.json" in names
        assert "01-research.md" in names
        assert "02-outline.md" in names
        assert "03-draft.md" in names
        assert "final.md" in names
        assert "final.html" in names

        # Verify content
        assert zf.read("final.md").decode() == post["final_md_content"]
        assert zf.read("final.html").decode() == post["final_html_content"]

        # Verify input config
        config = json.loads(zf.read("00-input.json"))
        assert config["topic"] == post["topic"]
        assert config["slug"] == post["slug"]


async def test_export_all_zip_partial_content(client: AsyncClient, sample_post_data):
    """ZIP should include only available stages."""
    create_resp = await client.post("/api/posts", json=sample_post_data)
    post = create_resp.json()

    await client.patch(
        f"/api/posts/{post['id']}",
        json={"research_content": "Some research"},
    )

    resp = await client.get(f"/api/posts/{post['id']}/export/all")
    assert resp.status_code == 200

    buf = io.BytesIO(resp.content)
    with zipfile.ZipFile(buf) as zf:
        names = zf.namelist()
        assert "00-input.json" in names
        assert "01-research.md" in names
        assert "final.md" not in names


async def test_export_not_found(client: AsyncClient):
    fake_id = str(uuid.uuid4())
    resp = await client.get(f"/api/posts/{fake_id}/export/markdown")
    assert resp.status_code == 404
