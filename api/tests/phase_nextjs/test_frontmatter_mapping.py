from __future__ import annotations

from src.services.frontmatter_mapping import apply_frontmatter_mapping


def test_simple_field_mapping():
    mapping = {"title": "title", "description": "description"}
    jena_frontmatter = {"title": "My Post", "description": "A description"}
    result = apply_frontmatter_mapping(jena_frontmatter, mapping)
    assert result["title"] == "My Post"
    assert result["description"] == "A description"


def test_array_transform():
    mapping = {"category": {"key": "category", "transform": "array"}}
    jena_frontmatter = {"category": "Tech"}
    result = apply_frontmatter_mapping(jena_frontmatter, mapping)
    assert result["category"] == ["Tech"]


def test_array_transform_already_array():
    mapping = {"category": {"key": "category", "transform": "array"}}
    jena_frontmatter = {"category": ["Tech", "AI"]}
    result = apply_frontmatter_mapping(jena_frontmatter, mapping)
    assert result["category"] == ["Tech", "AI"]


def test_default_value():
    mapping = {"author": {"key": "author", "default": "Ship Restrict"}}
    jena_frontmatter = {}
    result = apply_frontmatter_mapping(jena_frontmatter, mapping)
    assert result["author"] == "Ship Restrict"


def test_default_not_used_when_value_present():
    mapping = {"author": {"key": "author", "default": "Ship Restrict"}}
    jena_frontmatter = {"author": "Cody"}
    result = apply_frontmatter_mapping(jena_frontmatter, mapping)
    assert result["author"] == "Cody"


def test_jena_cdn_url_transform():
    mapping = {"image": {"key": "image", "transform": "jena-cdn-url"}}
    jena_frontmatter = {"image": "https://cdn.jena.ai/images/abc/hero.webp"}
    result = apply_frontmatter_mapping(jena_frontmatter, mapping)
    assert result["image"] == "https://cdn.jena.ai/images/abc/hero.webp"
