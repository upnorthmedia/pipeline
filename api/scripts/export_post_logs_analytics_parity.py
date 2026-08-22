"""Export the parity oracle the TypeScript `/logs` and `/analytics` ports need.

`get_execution_logs` and `post_analytics` in `api/src/api/posts.py` are both
thin, and both hide a decision that a reading would get wrong:

* `/logs` filters three ways over the `execution_logs` jsonb column with
  `entry.get(...)`, so an entry missing the key still takes part in the
  comparison, and `since` is a plain `str` comparison rather than a date one.
* `/analytics` picks the content column, then splits `related_keywords` into a
  primary and a secondary list with two different `isinstance` rules.

Both real endpoint coroutines are driven here rather than reimplemented, with a
stubbed session standing in for the `_get_user_post` lookup, so every line of
the filter block and the keyword block runs for real.

Usage:
    uv run python scripts/export_post_logs_analytics_parity.py
"""

from __future__ import annotations

import asyncio
import json
import uuid
from pathlib import Path
from types import SimpleNamespace

from src.api.posts import get_execution_logs, post_analytics
from src.models.post import Post

OUT = (
    Path(__file__).resolve().parents[2]
    / "web"
    / "src"
    / "app"
    / "api"
    / "posts"
    / "data"
    / "logs-analytics-parity.json"
)

POST_ID = uuid.UUID("11111111-1111-4111-8111-111111111111")
USER = SimpleNamespace(id="user-under-test")


class _Result:
    def __init__(self, value):
        self._value = value

    def scalar_one_or_none(self):
        return self._value


class _Session:
    """Just enough of `AsyncSession` for `_get_user_post`'s happy path."""

    def __init__(self, post):
        self._post = post

    async def execute(self, _statement):
        return _Result(self._post)


ARTICLE = """---
title: Espresso Machine Descaling
description: How often to descale an espresso machine.
---

# Espresso Machine Descaling

Descaling an espresso machine is the single maintenance task owners skip most.
Scale builds in the boiler and the group head, and it changes the taste of the
shot long before the machine fails outright.

## When to descale an espresso machine

Water hardness decides the interval. Read our [water hardness guide](/water)
and the [manufacturer notes](https://example.org/manual) before you start.

![A descaling kit](https://cdn.example.com/kit.png)

## What descaling does not fix

A worn group gasket leaks whatever you do. Replace it separately.
"""

LOG_ENTRIES = [
    {
        "ts": "2026-08-01T10:00:00Z",
        "level": "info",
        "stage": "research",
        "message": "start",
    },
    {
        "ts": "2026-08-01T10:05:00Z",
        "level": "warning",
        "stage": "research",
        "message": "slow",
    },
    {
        "ts": "2026-08-02T09:00:00Z",
        "level": "error",
        "stage": "write",
        "message": "retry",
    },
    {
        "ts": "2026-08-03T08:00:00Z",
        "level": "info",
        "stage": "write",
        "message": "done",
    },
    {"level": "debug", "stage": "edit", "message": "no ts"},
    {"ts": "2026-08-04T07:00:00Z", "stage": "edit", "message": "no level"},
    {"ts": "2026-08-05T06:00:00Z", "level": 1, "stage": None, "message": "odd types"},
]

# name, execution_logs, level, stage, since
LOG_CASES: list[tuple[str, object, object, object, object]] = [
    ("empty list", [], None, None, None),
    ("no filters returns every entry in order", LOG_ENTRIES, None, None, None),
    ("single level", LOG_ENTRIES, ["info"], None, None),
    ("two levels", LOG_ENTRIES, ["info", "error"], None, None),
    ("level matching nothing", LOG_ENTRIES, ["critical"], None, None),
    ("empty level list is falsy, so no filter", LOG_ENTRIES, [], None, None),
    (
        "level of the empty string filters, matching nothing",
        LOG_ENTRIES,
        [""],
        None,
        None,
    ),
    (
        "an entry with no level key never matches a level filter",
        LOG_ENTRIES,
        ["debug"],
        None,
        None,
    ),
    (
        "a non-string level is compared by equality, not by str()",
        LOG_ENTRIES,
        ["1"],
        None,
        None,
    ),
    ("stage", LOG_ENTRIES, None, "write", None),
    ("stage matching nothing", LOG_ENTRIES, None, "images", None),
    ("empty stage is falsy, so no filter", LOG_ENTRIES, None, "", None),
    ("a null stage value never matches", LOG_ENTRIES, None, "None", None),
    (
        "since is a strict string comparison",
        LOG_ENTRIES,
        None,
        None,
        "2026-08-02T09:00:00Z",
    ),
    ("since before everything", LOG_ENTRIES, None, None, "2026-01-01T00:00:00Z"),
    ("since after everything", LOG_ENTRIES, None, None, "2027-01-01T00:00:00Z"),
    (
        "an entry with no ts defaults to the empty string and loses",
        LOG_ENTRIES,
        None,
        None,
        "a",
    ),
    (
        "since is not parsed as a date, so a bare word filters",
        LOG_ENTRIES,
        None,
        None,
        "2026-08",
    ),
    (
        "all three filters compose",
        LOG_ENTRIES,
        ["info", "warning"],
        "research",
        "2026-08-01T10:00:00Z",
    ),
]

# name, post field overrides
ANALYTICS_CASES: list[tuple[str, dict]] = [
    ("no content at all", {}),
    ("draft only", {"draft_content": ARTICLE}),
    (
        "final_md_content wins over draft_content",
        {
            "draft_content": "# Other\n\nSomething else entirely.\n",
            "final_md_content": ARTICLE,
        },
    ),
    (
        "empty final_md_content falls through to draft",
        {"final_md_content": "", "draft_content": ARTICLE},
    ),
    (
        "ready_content is not consulted",
        {"ready_content": ARTICLE, "draft_content": "# Draft\n\nOnly this counts.\n"},
    ),
    ("no keywords", {"final_md_content": ARTICLE, "related_keywords": None}),
    ("empty keyword list", {"final_md_content": ARTICLE, "related_keywords": []}),
    (
        "one keyword is the primary and there are no secondaries",
        {
            "final_md_content": ARTICLE,
            "related_keywords": ["descaling an espresso machine"],
        },
    ),
    (
        "the first keyword is primary and the rest are secondary",
        {
            "final_md_content": ARTICLE,
            "related_keywords": [
                "descaling an espresso machine",
                "water hardness",
                "group gasket",
            ],
        },
    ),
    (
        "a non-string first keyword yields an empty primary",
        {"final_md_content": ARTICLE, "related_keywords": [7, "water hardness"]},
    ),
    (
        "non-string keywords are dropped from the secondaries",
        {
            "final_md_content": ARTICLE,
            "related_keywords": ["descaling an espresso machine", 7, "water hardness"],
        },
    ),
    (
        "topic feeds the title check",
        {
            "final_md_content": ARTICLE,
            "related_keywords": ["descaling"],
            "topic": "Descaling an espresso machine",
        },
    ),
    (
        "an empty topic is an empty title",
        {"final_md_content": ARTICLE, "related_keywords": ["descaling"], "topic": ""},
    ),
    (
        "website_url decides which links count as internal",
        {
            "final_md_content": ARTICLE,
            "related_keywords": ["descaling"],
            "website_url": "https://example.org/blog",
        },
    ),
    (
        "a null website_url leaves the domain empty",
        {
            "final_md_content": ARTICLE,
            "related_keywords": ["descaling"],
            "website_url": None,
        },
    ),
]


def _post(**overrides) -> Post:
    fields = {
        "id": POST_ID,
        "slug": "espresso-machine-descaling",
        "topic": "Espresso machine descaling",
        "website_url": "https://example.com/blog",
        "related_keywords": None,
        "draft_content": None,
        "final_md_content": None,
        "ready_content": None,
        "execution_logs": [],
    }
    fields.update(overrides)
    return Post(**fields)


async def main() -> None:
    logs = []
    for name, entries, level, stage, since in LOG_CASES:
        post = _post(execution_logs=entries)
        result = await get_execution_logs(
            post_id=POST_ID,
            level=level,
            stage=stage,
            since=since,
            user=USER,
            session=_Session(post),
        )
        logs.append(
            {
                "name": name,
                "execution_logs": entries,
                "level": level,
                "stage": stage,
                "since": since,
                "expected": result,
            }
        )

    analytics = []
    for name, overrides in ANALYTICS_CASES:
        post = _post(**overrides)
        result = await post_analytics(
            post_id=POST_ID, user=USER, session=_Session(post)
        )
        analytics.append(
            {
                "name": name,
                "post": {
                    "topic": post.topic,
                    "website_url": post.website_url,
                    "related_keywords": post.related_keywords,
                    "draft_content": post.draft_content,
                    "final_md_content": post.final_md_content,
                    "ready_content": post.ready_content,
                },
                "expected": result,
            }
        )

    OUT.parent.mkdir(parents=True, exist_ok=True)
    OUT.write_text(json.dumps({"logs": logs, "analytics": analytics}, indent=2) + "\n")
    print(f"wrote {len(logs)} log cases and {len(analytics)} analytics cases to {OUT}")


if __name__ == "__main__":
    asyncio.run(main())
