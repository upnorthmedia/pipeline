"""Tests for WordPress publish hook."""

from src.pipeline.publish import _extract_frontmatter, _find_image_refs


class TestExtractFrontmatter:
    def test_with_frontmatter(self):
        content = "---\ntitle: My Post\ndescription: A test post\n---\n\nHello world"
        meta, body = _extract_frontmatter(content)
        assert meta["title"] == "My Post"
        assert meta["description"] == "A test post"
        assert body.strip() == "Hello world"

    def test_without_frontmatter(self):
        content = "Just some content"
        meta, body = _extract_frontmatter(content)
        assert meta == {}
        assert body == content

    def test_quoted_values(self):
        content = '---\ntitle: "Hello World"\n---\n\nBody'
        meta, body = _extract_frontmatter(content)
        assert meta["title"] == "Hello World"


class TestFindImageRefs:
    def test_finds_images(self):
        html = (
            '<img src="/media/123/img1.png" alt="test"/>'
            '<img src="/media/123/img2.jpg"/>'
        )
        refs = _find_image_refs(html)
        assert len(refs) == 2
        assert "/media/123/img1.png" in refs

    def test_no_images(self):
        html = "<p>No images here</p>"
        assert _find_image_refs(html) == []
