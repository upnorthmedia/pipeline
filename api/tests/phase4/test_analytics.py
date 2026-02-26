"""Tests for analytics computation service."""

import pytest
from src.services.analytics import compute_analytics


def test_word_count():
    text = " ".join(["word"] * 500)
    result = compute_analytics(text)
    assert result.word_count == 500


def test_word_count_empty():
    result = compute_analytics("")
    assert result.word_count == 0


def test_sentence_count():
    # textstat needs longer text for reliable sentence detection
    text = (
        "This is the first sentence about a topic. "
        "This is the second sentence with more detail. "
        "This is the third sentence to wrap things up."
    )
    result = compute_analytics(text)
    assert result.sentence_count >= 2  # textstat may merge short sentences


def test_paragraph_count():
    text = "Paragraph one.\n\nParagraph two.\n\nParagraph three."
    result = compute_analytics(text)
    assert result.paragraph_count == 3


def test_avg_sentence_length():
    # 3 sentences, 12 words total = avg 4.0
    text = "One two three four. Five six seven eight. Nine ten eleven twelve."
    result = compute_analytics(text)
    assert result.avg_sentence_length == 4.0


def test_flesch_reading_ease():
    # Simple text should score high (easy to read)
    simple_text = (
        "The cat sat on the mat. "
        "The dog ran in the park. "
        "The sun was bright and warm. "
        "The kids played all day long. "
        "They had a lot of fun. "
    ) * 5
    result = compute_analytics(simple_text)
    assert result.flesch_reading_ease > 70


def test_flesch_reading_ease_complex():
    # More complex text should score lower
    complex_text = (
        "The implementation of sophisticated algorithmic methodologies "
        "necessitates comprehensive understanding of computational complexity. "
        "Furthermore, the architectural paradigm fundamentally restructures "
        "the foundational infrastructure of distributed systems. "
    ) * 5
    result = compute_analytics(complex_text)
    assert result.flesch_reading_ease < 40


def test_keyword_density_primary():
    # "ghost gun" appears 5 times in ~50 words (2 words per occurrence)
    words = ["This is a regular sentence."] * 10
    words[0] = "The ghost gun is popular."
    words[2] = "Building a ghost gun requires parts."
    words[4] = "A ghost gun has no serial number."
    words[6] = "The ghost gun debate continues."
    words[8] = "Each ghost gun is unique."
    text = " ".join(words)

    result = compute_analytics(text, primary_keyword="ghost gun")
    density = result.keyword_density.get("ghost gun", 0)
    assert density > 0
    # 5 occurrences × 2 words / ~55 words ≈ 18%
    # The exact value depends on word count
    assert density > 5  # at least noticeable density


def test_keyword_density_secondary():
    text = "Python is great. Python rocks. Python is the best. " * 3
    result = compute_analytics(
        text,
        primary_keyword="Python",
        secondary_keywords=["great", "best"],
    )
    assert "great" in result.keyword_density
    assert "best" in result.keyword_density
    assert result.keyword_density["great"] > 0
    assert result.keyword_density["best"] > 0


def test_keyword_density_zero():
    text = "This text has no target keywords at all."
    result = compute_analytics(text, primary_keyword="missing")
    assert result.keyword_density["missing"] == 0


def test_seo_keyword_in_title():
    text = "Some content about AR-15 builds."
    result = compute_analytics(
        text, primary_keyword="ar-15", title="Best AR-15 Build Guide"
    )
    assert result.seo_checklist["keyword_in_title"] is True


def test_seo_keyword_not_in_title():
    text = "Some content about builds."
    result = compute_analytics(text, primary_keyword="ar-15", title="Best Rifles Guide")
    assert result.seo_checklist["keyword_in_title"] is False


def test_seo_keyword_in_first_100_words():
    text = "The ar-15 is a versatile platform. " + "Filler text. " * 50
    result = compute_analytics(text, primary_keyword="ar-15")
    assert result.seo_checklist["keyword_in_first_100_words"] is True


def test_seo_keyword_not_in_first_100_words():
    text = "Filler text. " * 50 + "The ar-15 is mentioned late."
    result = compute_analytics(text, primary_keyword="ar-15")
    assert result.seo_checklist["keyword_in_first_100_words"] is False


def test_seo_keyword_in_h2():
    text = "# Title\n\n## AR-15 Build Guide\n\nContent here."
    result = compute_analytics(text, primary_keyword="ar-15")
    assert result.seo_checklist["keyword_in_h2"] is True


def test_seo_has_h2_headings():
    text = "# Title\n\n## Section One\n\n## Section Two\n\nContent."
    result = compute_analytics(text)
    assert result.seo_checklist["has_h2_headings"] is True


def test_seo_no_h2_headings():
    text = "Just plain text with no headings at all."
    result = compute_analytics(text)
    assert result.seo_checklist["has_h2_headings"] is False


def test_seo_internal_links():
    text = "Check [our guide](/ar15-guide/) for more info."
    result = compute_analytics(text)
    assert result.seo_checklist["has_internal_links"] is True


def test_seo_external_links():
    text = "See [Wikipedia](https://en.wikipedia.org) for details."
    result = compute_analytics(text)
    assert result.seo_checklist["has_external_links"] is True


def test_seo_meta_description():
    text = (
        "---\ntitle: Test\n"
        "description: A great article about building.\n"
        "---\n\nContent."
    )
    result = compute_analytics(text)
    assert result.seo_checklist["has_meta_description"] is True


def test_markdown_stripping():
    """Analytics should work on markdown content."""
    md = """---
title: Test Post
---

# Main Title

**Bold text** and *italic text*.

## Section with [a link](https://example.com)

Some `inline code` and a paragraph.

```python
def hello():
    pass
```

> A blockquote here.
"""
    result = compute_analytics(md)
    assert result.word_count > 0
    assert result.seo_checklist["has_h2_headings"] is True


pytestmark_api = pytest.mark.anyio


@pytest.mark.anyio
async def test_analytics_endpoint(client, sample_post_data):
    """Test the analytics API endpoint."""

    create_resp = await client.post("/api/posts", json=sample_post_data)
    post = create_resp.json()

    # Add content with keywords
    await client.patch(
        f"/api/posts/{post['id']}",
        json={
            "final_md_content": (
                "# Great REST API Guide\n\n"
                "## Building REST APIs\n\n"
                "REST API development is important. "
            )
            * 10,
            "related_keywords": ["REST API", "development"],
        },
    )

    resp = await client.get(f"/api/posts/{post['id']}/analytics")
    assert resp.status_code == 200
    data = resp.json()
    assert "word_count" in data
    assert "flesch_reading_ease" in data
    assert "keyword_density" in data
    assert "seo_checklist" in data
    assert data["word_count"] > 0
