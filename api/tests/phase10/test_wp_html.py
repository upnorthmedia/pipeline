"""Tests for WordPress HTML converter."""

from src.services.wp_html import markdown_to_wp_html


def test_paragraph():
    result = markdown_to_wp_html("Hello world")
    assert "<!-- wp:paragraph -->" in result
    assert "<p>Hello world</p>" in result
    assert "<!-- /wp:paragraph -->" in result


def test_heading_h2():
    result = markdown_to_wp_html("## My Heading")
    assert "<!-- wp:heading -->" in result
    assert "<h2>My Heading</h2>" in result


def test_heading_h3():
    result = markdown_to_wp_html("### Sub Heading")
    assert '<!-- wp:heading {"level":3} -->' in result
    assert "<h3>Sub Heading</h3>" in result


def test_unordered_list():
    md = "- Item 1\n- Item 2\n- Item 3"
    result = markdown_to_wp_html(md)
    assert "<!-- wp:list -->" in result
    assert "<ul>" in result
    assert "<li>" in result
    assert "<!-- /wp:list -->" in result


def test_ordered_list():
    md = "1. First\n2. Second"
    result = markdown_to_wp_html(md)
    assert "<!-- wp:list" in result
    assert "<ol>" in result


def test_image():
    md = "![Alt text](https://example.com/img.jpg)"
    result = markdown_to_wp_html(md)
    assert "<!-- wp:image -->" in result
    assert 'src="https://example.com/img.jpg"' in result
    assert 'alt="Alt text"' in result


def test_code_block():
    md = "```python\nprint('hello')\n```"
    result = markdown_to_wp_html(md)
    assert "<!-- wp:code" in result
    assert "<pre" in result
    assert "print('hello')" in result


def test_blockquote():
    md = "> This is a quote"
    result = markdown_to_wp_html(md)
    assert "<!-- wp:quote -->" in result
    assert "<blockquote" in result


def test_strips_frontmatter():
    md = "---\ntitle: Test\ndescription: A test\n---\n\nHello world"
    result = markdown_to_wp_html(md)
    assert "title:" not in result
    assert "---" not in result
    assert "<p>Hello world</p>" in result


def test_bold_and_italic():
    md = "This is **bold** and *italic* text"
    result = markdown_to_wp_html(md)
    assert "<strong>bold</strong>" in result
    assert "<em>italic</em>" in result


def test_link():
    md = "Visit [Example](https://example.com) for more"
    result = markdown_to_wp_html(md)
    assert '<a href="https://example.com">Example</a>' in result


def test_horizontal_rule():
    md = "Above\n\n---\n\nBelow"
    result = markdown_to_wp_html(md)
    assert "<!-- wp:separator -->" in result
