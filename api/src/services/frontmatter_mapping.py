from __future__ import annotations

from typing import Any


def apply_frontmatter_mapping(
    jena_frontmatter: dict[str, Any],
    mapping: dict[str, Any],
) -> dict[str, Any]:
    """Apply a frontmatter mapping to transform Jena AI output to the target schema."""
    result: dict[str, Any] = {}

    for jena_field, target in mapping.items():
        if isinstance(target, str):
            if jena_field in jena_frontmatter:
                result[target] = jena_frontmatter[jena_field]
        elif isinstance(target, dict):
            key = target.get("key", jena_field)
            transform = target.get("transform")
            default = target.get("default")

            value = jena_frontmatter.get(jena_field)

            if value is None and default is not None:
                result[key] = default
                continue

            if value is None:
                continue

            if transform == "array" and not isinstance(value, list):
                value = [value]

            result[key] = value

    return result
