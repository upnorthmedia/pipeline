"""Content analytics computation: readability, keyword density, SEO checks."""

import re
from dataclasses import dataclass, field

import textstat


@dataclass
class ContentAnalytics:
    word_count: int = 0
    sentence_count: int = 0
    paragraph_count: int = 0
    avg_sentence_length: float = 0.0
    flesch_reading_ease: float = 0.0
    keyword_density: dict[str, float] = field(default_factory=dict)
    seo_checklist: dict[str, bool] = field(default_factory=dict)


def compute_analytics(
    content: str,
    primary_keyword: str = "",
    secondary_keywords: list[str] | None = None,
    title: str = "",
    website_url: str = "",
) -> ContentAnalytics:
    """Compute content analytics for a piece of text."""
    if not content:
        return ContentAnalytics()

    # Unwrap outer code fence before any analysis (LLM wraps in ```markdown)
    content = re.sub(r"^```(?:markdown|md)?\s*\n", "", content.strip())
    content = re.sub(r"\n```\s*$", "", content)

    # Strip markdown formatting for text analysis
    plain = _strip_markdown(content)

    words = plain.split()
    word_count = len(words)

    sentences = textstat.sentence_count(plain)
    paragraphs = len([p for p in content.split("\n\n") if p.strip()])

    avg_sentence_length = word_count / sentences if sentences > 0 else 0.0
    flesch = textstat.flesch_reading_ease(plain)

    # Keyword density
    density: dict[str, float] = {}
    if primary_keyword and word_count > 0:
        pk_lower = primary_keyword.lower()
        plain_lower = plain.lower()
        pk_count = plain_lower.count(pk_lower)
        # Count words in keyword phrase
        pk_words = len(pk_lower.split())
        density[primary_keyword] = round((pk_count * pk_words / word_count) * 100, 2)

    for kw in secondary_keywords or []:
        if kw and word_count > 0:
            kw_lower = kw.lower()
            kw_count = plain.lower().count(kw_lower)
            kw_words = len(kw_lower.split())
            density[kw] = round((kw_count * kw_words / word_count) * 100, 2)

    # SEO checklist
    seo = _seo_checklist(content, plain, title, primary_keyword, website_url)

    return ContentAnalytics(
        word_count=word_count,
        sentence_count=sentences,
        paragraph_count=paragraphs,
        avg_sentence_length=round(avg_sentence_length, 1),
        flesch_reading_ease=round(flesch, 1),
        keyword_density=density,
        seo_checklist=seo,
    )


def _seo_checklist(
    markdown: str,
    plain: str,
    title: str,
    primary_keyword: str,
    website_url: str = "",
) -> dict[str, bool]:
    """Run SEO checks against content."""
    from urllib.parse import urlparse

    checks: dict[str, bool] = {}
    pk_lower = primary_keyword.lower() if primary_keyword else ""

    # Keyword in title
    checks["keyword_in_title"] = bool(pk_lower and pk_lower in title.lower())

    # Keyword in first 100 words
    first_100 = " ".join(plain.split()[:100]).lower()
    checks["keyword_in_first_100_words"] = bool(pk_lower and pk_lower in first_100)

    # Keyword in H2s
    h2_pattern = re.compile(r"^##\s+(.+)$", re.MULTILINE)
    h2s = h2_pattern.findall(markdown)
    checks["keyword_in_h2"] = bool(
        pk_lower and any(pk_lower in h2.lower() for h2 in h2s)
    )

    # Has H2 headings
    checks["has_h2_headings"] = len(h2s) > 0

    # Internal links (markdown links) — domain-aware classification
    domain = urlparse(website_url).netloc if website_url else ""
    link_pattern = re.compile(r"\[([^\]]+)\]\(([^)]+)\)")
    links = link_pattern.findall(markdown)
    internal_links = [
        url
        for _, url in links
        if url.startswith("/")
        or url.startswith("#")
        or (domain and domain in urlparse(url).netloc)
    ]
    external_links = [
        url
        for _, url in links
        if url.startswith("http") and not (domain and domain in urlparse(url).netloc)
    ]
    checks["has_internal_links"] = len(internal_links) >= 1
    checks["has_external_links"] = len(external_links) >= 1
    checks["internal_link_count"] = len(internal_links)  # type: ignore[assignment]
    checks["external_link_count"] = len(external_links)  # type: ignore[assignment]

    # Meta description (check for YAML frontmatter description field)
    checks["has_meta_description"] = bool(
        re.search(r"^description:\s*.+", markdown, re.MULTILINE)
    )

    return checks


def _strip_markdown(text: str) -> str:
    """Remove markdown formatting for plain text analysis."""
    # Remove YAML frontmatter
    text = re.sub(r"^---\n.*?\n---\n", "", text, flags=re.DOTALL)
    # Remove HTML tags
    text = re.sub(r"<[^>]+>", "", text)
    # Remove markdown headings
    text = re.sub(r"^#{1,6}\s+", "", text, flags=re.MULTILINE)
    # Remove bold/italic markers
    text = re.sub(r"[*_]{1,3}", "", text)
    # Remove image syntax (before links to avoid partial match)
    text = re.sub(r"!\[([^\]]*)\]\([^)]+\)", r"\1", text)
    # Remove link syntax but keep text
    text = re.sub(r"\[([^\]]+)\]\([^)]+\)", r"\1", text)
    # Remove code blocks
    text = re.sub(r"```[\s\S]*?```", "", text)
    # Remove inline code
    text = re.sub(r"`[^`]+`", "", text)
    # Remove blockquotes
    text = re.sub(r"^>\s+", "", text, flags=re.MULTILINE)
    # Collapse whitespace
    text = re.sub(r"\n{3,}", "\n\n", text)
    return text.strip()
