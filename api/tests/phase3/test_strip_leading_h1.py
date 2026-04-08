"""Tests for strip_leading_h1 helper."""

from src.pipeline.helpers import strip_leading_h1


def test_strips_matching_h1():
    content = '---\ntitle: "My Blog Post"\n---\n\n# My Blog Post\n\nFirst paragraph here.\n\n## Section One\n'
    result = strip_leading_h1(content)
    assert "# My Blog Post" not in result
    assert "First paragraph here." in result
    assert '---\ntitle: "My Blog Post"\n---' in result
    assert "## Section One" in result


def test_preserves_non_matching_h1():
    content = '---\ntitle: "My Blog Post"\n---\n\n# Different Title\n\nContent here.\n'
    result = strip_leading_h1(content)
    assert "# Different Title" in result


def test_preserves_content_without_h1():
    content = '---\ntitle: "My Blog Post"\n---\n\nFirst paragraph here.\n\n## Section One\n'
    result = strip_leading_h1(content)
    assert result == content


def test_preserves_content_without_frontmatter():
    content = "# My Blog Post\n\nFirst paragraph here.\n"
    result = strip_leading_h1(content)
    assert result == content


def test_case_insensitive_match():
    content = '---\ntitle: "my blog post"\n---\n\n# My Blog Post\n\nContent here.\n'
    result = strip_leading_h1(content)
    assert "# My Blog Post" not in result
    assert "Content here." in result


def test_strips_h1_with_unquoted_title():
    content = "---\ntitle: My Blog Post\n---\n\n# My Blog Post\n\nContent here.\n"
    result = strip_leading_h1(content)
    assert "# My Blog Post" not in result
    assert "Content here." in result
