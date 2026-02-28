"""Tests for export endpoints (markdown, HTML, ZIP)."""

import io
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
            "ready_content": (
                "---\ntitle: Test Post\nslug: test\n---\n\n"
                "# Ready Post\n\nFinal ready content."
            ),
        },
    )
    # Refresh
    resp = await client.get(f"/api/posts/{post['id']}")
    return resp.json()


async def test_export_markdown_prefers_ready(client: AsyncClient, post_with_content):
    """Markdown export should prefer ready_content over final_md."""
    post = post_with_content
    resp = await client.get(f"/api/posts/{post['id']}/export/markdown")
    assert resp.status_code == 200
    assert resp.headers["content-type"] == "text/markdown; charset=utf-8"
    assert "attachment" in resp.headers["content-disposition"]
    assert post["slug"] in resp.headers["content-disposition"]
    # Export rewrites /media/{id}/ paths to /
    expected = post["ready_content"]
    assert resp.text == expected


async def test_export_markdown_falls_back_to_final(
    client: AsyncClient, sample_post_data
):
    """Falls back to final_md_content when no ready_content."""
    create_resp = await client.post("/api/posts", json=sample_post_data)
    post = create_resp.json()
    md = "# Final\n\nContent here."
    await client.patch(
        f"/api/posts/{post['id']}",
        json={"final_md_content": md},
    )
    resp = await client.get(f"/api/posts/{post['id']}/export/markdown")
    assert resp.status_code == 200
    assert resp.text == md


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


async def test_export_zip_contains_ready_post(client: AsyncClient, post_with_content):
    """ZIP should contain {slug}.md with ready content and no stage dumps."""
    post = post_with_content
    resp = await client.get(f"/api/posts/{post['id']}/export/all")
    assert resp.status_code == 200
    assert resp.headers["content-type"] == "application/zip"
    assert f"{post['slug']}.zip" in resp.headers["content-disposition"]

    buf = io.BytesIO(resp.content)
    with zipfile.ZipFile(buf) as zf:
        names = zf.namelist()
        assert f"{post['slug']}.mdx" in names
        # Should NOT contain old stage dump files
        assert "00-input.json" not in names
        assert "01-research.md" not in names
        assert "final.md" not in names

        content = zf.read(f"{post['slug']}.mdx").decode()
        assert "Ready Post" in content


async def test_export_zip_rewrites_image_urls(client: AsyncClient, sample_post_data):
    """ZIP should rewrite /media/{id}/ URLs to relative filenames."""
    create_resp = await client.post("/api/posts", json=sample_post_data)
    post = create_resp.json()
    post_id = post["id"]
    ready = (
        f"# Post\n\n"
        f"![hero](/media/{post_id}/hero.png)\n\n"
        f"Content with ![img](/media/{post_id}/section.png)"
    )
    await client.patch(
        f"/api/posts/{post_id}",
        json={"ready_content": ready},
    )

    resp = await client.get(f"/api/posts/{post_id}/export/all")
    assert resp.status_code == 200

    buf = io.BytesIO(resp.content)
    with zipfile.ZipFile(buf) as zf:
        md = zf.read(f"{post['slug']}.mdx").decode()
        assert f"/media/{post_id}/" not in md
        assert "![hero](/hero.png)" in md
        assert "![img](/section.png)" in md


async def test_export_zip_no_content(client: AsyncClient, sample_post_data):
    """ZIP export should 404 when no ready or final content."""
    create_resp = await client.post("/api/posts", json=sample_post_data)
    post = create_resp.json()
    resp = await client.get(f"/api/posts/{post['id']}/export/all")
    assert resp.status_code == 404


async def test_export_zip_wordpress_split(client: AsyncClient, sample_post_data):
    """ZIP should split markdown and WordPress HTML when separator present."""
    create_resp = await client.post(
        "/api/posts", json={**sample_post_data, "output_format": "both"}
    )
    post = create_resp.json()

    ready = (
        "# Markdown Version\n\nContent here.\n\n"
        "---WORDPRESS_HTML---\n\n"
        "<!-- wp:paragraph --><p>WP content</p>"
        "<!-- /wp:paragraph -->"
    )
    await client.patch(
        f"/api/posts/{post['id']}",
        json={"ready_content": ready},
    )

    resp = await client.get(f"/api/posts/{post['id']}/export/all")
    buf = io.BytesIO(resp.content)
    with zipfile.ZipFile(buf) as zf:
        names = zf.namelist()
        assert f"{post['slug']}.mdx" in names
        assert f"{post['slug']}.html" in names

        md = zf.read(f"{post['slug']}.mdx").decode()
        assert "Markdown Version" in md
        assert "WORDPRESS_HTML" not in md

        html = zf.read(f"{post['slug']}.html").decode()
        assert "wp:paragraph" in html


async def test_export_not_found(client: AsyncClient):
    fake_id = str(uuid.uuid4())
    resp = await client.get(f"/api/posts/{fake_id}/export/markdown")
    assert resp.status_code == 404
