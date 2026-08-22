"""Export the parity oracle the TypeScript `POST /api/posts` port needs.

`create_post` in `api/src/api/posts.py` decides what a new post row holds by
folding three sources together: the `PostCreate` body, the pydantic defaults it
was dumped with, and the referenced profile. The fold is subtle enough to be
worth an oracle rather than a reading: a field the client sent explicitly is
still overwritten by the profile when the value happens to equal the schema
default, and the two `wp_*` fields use a different rule again.

The real endpoint coroutine is driven here rather than reimplemented, so the
oracle cannot drift from what the endpoint actually does. The session, the
request and the queue are stubbed; the `Post` object handed to `session.add` is
what gets recorded, so every line of the prefill block runs for real.

Usage:
    uv run python scripts/export_post_create_parity.py
"""

from __future__ import annotations

import asyncio
import json
import uuid
from pathlib import Path
from types import SimpleNamespace

from src.api.posts import create_post
from src.models.post import Post
from src.models.profile import WebsiteProfile
from src.models.schemas import PostCreate

OUT = (
    Path(__file__).resolve().parents[2]
    / "web"
    / "src"
    / "app"
    / "api"
    / "posts"
    / "data"
    / "create-parity.json"
)

# Every column `create_post` can decide the value of, plus the two it stamps.
RECORDED = list(PostCreate.model_fields) + ["current_stage", "stage_status"]

PROFILE_ID = uuid.UUID("11111111-1111-4111-8111-111111111111")
USER_ID = "user-under-test"


class _Result:
    def __init__(self, value):
        self._value = value

    def scalar_one_or_none(self):
        return self._value


class _Session:
    """Just enough of `AsyncSession` for the endpoint's happy path."""

    def __init__(self, profile):
        self._profile = profile
        self.added = None

    async def execute(self, _statement):
        return _Result(self._profile)

    def add(self, obj):
        self.added = obj

    async def commit(self):
        return None

    async def refresh(self, _obj):
        return None


class _Redis:
    def __init__(self):
        self.jobs = []

    async def enqueue_job(self, name, *args):
        self.jobs.append([name, *args])


def _profile(**overrides) -> WebsiteProfile:
    """A profile with every prefill source populated, before overrides."""
    fields = {
        "id": PROFILE_ID,
        "user_id": USER_ID,
        "name": "Profile",
        "website_url": "https://profile.example.com",
        "niche": "profile niche",
        "target_audience": "profile audience",
        "tone": "Profile tone",
        "brand_voice": "profile voice",
        "word_count": 3300,
        "output_format": "html",
        "image_style": "profile style",
        "image_brand_colors": ["#111111"],
        "image_exclude": ["profile exclusion"],
        "avoid": "profile avoid",
        "required_mentions": "profile mentions",
        "related_keywords": ["profile keyword"],
        "default_stage_settings": {
            "research": "review",
            "outline": "auto",
            "write": "review",
            "edit": "auto",
            "images": "auto",
            "ready": "auto",
        },
        "wp_default_category_id": 77,
        "wp_default_author_id": 88,
    }
    fields.update(overrides)
    return WebsiteProfile(**fields)


NULL_PROFILE_FIELDS = {
    "niche": None,
    "target_audience": None,
    "tone": None,
    "brand_voice": None,
    "word_count": None,
    "output_format": None,
    "website_url": None,
    "image_style": None,
    "image_brand_colors": None,
    "image_exclude": None,
    "avoid": None,
    "required_mentions": None,
    "related_keywords": None,
    "default_stage_settings": None,
    "wp_default_category_id": None,
    "wp_default_author_id": None,
}

FULL_BODY = {
    "slug": "explicit",
    "topic": "Explicit topic",
    "profile_id": str(PROFILE_ID),
    "target_audience": "body audience",
    "niche": "body niche",
    "intent": "body intent",
    "word_count": 4400,
    "tone": "Body tone",
    "output_format": "both",
    "website_url": "https://body.example.com",
    "related_keywords": ["body keyword"],
    "competitor_urls": ["https://competitor.example.com"],
    "image_style": "body style",
    "image_brand_colors": ["#222222"],
    "image_exclude": ["body exclusion"],
    "brand_voice": "body voice",
    "avoid": "body avoid",
    "required_mentions": "body mentions",
    "article_type": "listicle",
    "additional_info": "body info",
    "stage_settings": {"research": "auto", "outline": "review"},
    "wp_category_id": 5,
    "wp_author_id": 6,
}

# Values that are exactly the pydantic defaults, sent explicitly. The endpoint
# cannot tell them from an unset field, so the profile still wins.
DEFAULT_VALUED_BODY = {
    "slug": "default-valued",
    "topic": "Default-valued topic",
    "profile_id": str(PROFILE_ID),
    "word_count": 2000,
    "tone": "Conversational and friendly",
    "output_format": "markdown",
    "related_keywords": [],
    "image_brand_colors": [],
    "image_exclude": [],
    "stage_settings": {
        "research": "auto",
        "outline": "auto",
        "write": "auto",
        "edit": "auto",
        "images": "auto",
        "ready": "auto",
    },
}

CASES = [
    {
        "name": "no profile: pydantic defaults reach the row untouched",
        "body": {"slug": "minimal", "topic": "Minimal topic"},
        "profile": None,
    },
    {
        "name": "no profile: an explicit body reaches the row untouched",
        "body": {**FULL_BODY, "profile_id": None, "slug": "explicit-no-profile"},
        "profile": None,
    },
    {
        "name": "profile fills every unset field",
        "body": {
            "slug": "prefilled",
            "topic": "Prefilled topic",
            "profile_id": str(PROFILE_ID),
        },
        "profile": {},
    },
    {
        "name": "an explicit body beats the profile everywhere",
        "body": FULL_BODY,
        "profile": {},
    },
    {
        "name": "a body holding the schema defaults loses to the profile",
        "body": DEFAULT_VALUED_BODY,
        "profile": {},
    },
    {
        "name": "a profile of nulls leaves the pydantic defaults in place",
        "body": {
            "slug": "null-profile",
            "topic": "Null profile",
            "profile_id": str(PROFILE_ID),
        },
        "profile": NULL_PROFILE_FIELDS,
    },
    {
        "name": "a null default_stage_settings is copied over the pydantic default",
        "body": {
            "slug": "null-ss",
            "topic": "Null stage settings",
            "profile_id": str(PROFILE_ID),
        },
        "profile": {"default_stage_settings": None},
    },
    {
        "name": "wp ids fall back to the profile only when the body left them null",
        "body": {
            "slug": "wp-partial",
            "topic": "WP partial",
            "profile_id": str(PROFILE_ID),
            "wp_category_id": 9,
        },
        "profile": {},
    },
    {
        "name": "a zero word_count is not the default, so it survives",
        "body": {
            "slug": "zero-words",
            "topic": "Zero words",
            "profile_id": str(PROFILE_ID),
            "word_count": 0,
        },
        "profile": {},
    },
    {
        "name": "an empty-string tone is not the default, so it survives",
        "body": {
            "slug": "empty-tone",
            "topic": "Empty tone",
            "profile_id": str(PROFILE_ID),
            "tone": "",
        },
        "profile": {},
    },
]


def _jsonable(value):
    if isinstance(value, uuid.UUID):
        return str(value)
    return value


async def _run_case(case) -> dict:
    profile = None if case["profile"] is None else _profile(**case["profile"])
    session = _Session(profile)
    redis = _Redis()
    request = SimpleNamespace(app=SimpleNamespace(state=SimpleNamespace(redis=redis)))
    user = SimpleNamespace(id=USER_ID)

    returned = await create_post(
        data=PostCreate(**case["body"]),
        request=request,
        user=user,
        session=session,
    )
    post: Post = session.added
    assert returned is post

    return {
        "name": case["name"],
        "body": case["body"],
        "profile": None
        if profile is None
        else {
            key: _jsonable(getattr(profile, key))
            for key in (
                "niche",
                "target_audience",
                "tone",
                "brand_voice",
                "word_count",
                "output_format",
                "website_url",
                "image_style",
                "image_brand_colors",
                "image_exclude",
                "avoid",
                "required_mentions",
                "related_keywords",
                "default_stage_settings",
                "wp_default_category_id",
                "wp_default_author_id",
            )
        },
        "post": {key: _jsonable(getattr(post, key)) for key in RECORDED},
        # Only the job name is oracle material: the stub never assigns a primary
        # key, so the id argument is the string "None" here rather than a uuid.
        "enqueued_jobs": [job[0] for job in redis.jobs],
    }


async def main() -> None:
    cases = [await _run_case(case) for case in CASES]
    payload = {
        "source": (
            "api/src/api/posts.py::create_post,"
            " driven with a stubbed session and request"
        ),
        "generator": "api/scripts/export_post_create_parity.py",
        "recorded_fields": RECORDED,
        "profile_id": str(PROFILE_ID),
        "cases": cases,
    }
    OUT.parent.mkdir(parents=True, exist_ok=True)
    OUT.write_text(json.dumps(payload, indent=2, sort_keys=False) + "\n")
    print(f"wrote {OUT} ({len(cases)} cases)")


if __name__ == "__main__":
    asyncio.run(main())
