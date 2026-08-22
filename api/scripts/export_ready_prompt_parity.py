"""Freeze the prompt the *production* ready stage renders, for the TS port.

`docs/mastra-port/golden/<slug>/ready.json` was captured by `capture_golden.py`,
which threads one in-memory state dict from stage to stage and never touches
Postgres. `_run_pipeline` does the opposite: it reloads the post from the
database before every stage (`api/src/worker.py`, "Load fresh post from DB each
iteration"), so the `image_manifest` the ready stage sees in production has been
through a `jsonb` column. `jsonb` does not store a document, it stores a
normalised value: object keys come back sorted by length and then bytewise.

The ready prompt embeds that manifest as pretty-printed JSON, so the golden
fixture's prompt and the prompt production sends for the same post differ in the
order of the manifest's keys. The port reads its state from the table, so its
oracle has to be the production path, not the capture harness.

This script produces it: for each golden fixture it writes the post's
`final_md_content` and `image_manifest` into the real `posts` table, reads the
row back, builds the state exactly as the worker does, and renders
`_build_ready_prompt` over it.

No provider is called and no API key is read; the only external dependency is a
running database.

    uv run python scripts/export_ready_prompt_parity.py
"""

from __future__ import annotations

import asyncio
import json
import os
import sys
import uuid
from datetime import UTC, datetime
from pathlib import Path

import asyncpg

REPO_ROOT = Path(__file__).resolve().parents[2]
sys.path.insert(0, str(REPO_ROOT / "api"))

from src.models.post import Post  # noqa: E402
from src.pipeline.helpers import load_rules  # noqa: E402
from src.pipeline.stages.ready import _build_ready_prompt  # noqa: E402
from src.pipeline.state import state_from_post  # noqa: E402

GOLDEN_DIR = REPO_ROOT / "docs" / "mastra-port" / "golden"
OUT_PATH = (
    REPO_ROOT / "web" / "src" / "mastra" / "steps" / "data" / "ready-prompt-parity.json"
)

SLUGS = [
    "how-to-choose-a-crm-for-a-small-team",
    "best-time-tracking-tools-for-agencies",
]

# The columns `_build_ready_prompt` reads, plus the ones `state_from_post`
# coalesces that could change them.
POST_FIELDS = [
    "slug",
    "topic",
    "output_format",
]


def dsn() -> str:
    """asyncpg DSN for the dev database, from the same env var the app uses."""
    url = os.environ.get(
        "DATABASE_URL", "postgresql://pipeline:pipeline@localhost:5433/content_pipeline"
    )
    return url.replace("postgresql+asyncpg://", "postgresql://")


async def manifest_through_jsonb(
    conn: asyncpg.Connection,
    post_id: uuid.UUID,
    spec: dict,
    final_md: str,
    manifest: dict,
) -> dict:
    """Write the manifest into `posts.image_manifest` and read it back."""
    await conn.execute(
        """
        INSERT INTO posts
            (id, slug, topic, output_format, final_md_content, image_manifest)
        VALUES ($1, $2, $3, $4, $5, $6::jsonb)
        """,
        post_id,
        spec["slug"],
        spec["topic"],
        spec["output_format"],
        final_md,
        json.dumps(manifest),
    )
    row = await conn.fetchval("SELECT image_manifest FROM posts WHERE id = $1", post_id)
    await conn.execute("DELETE FROM posts WHERE id = $1", post_id)
    # asyncpg hands back jsonb as text; `json.loads` keeps the order Postgres
    # emitted, which is the whole point of the round trip.
    return json.loads(row)


async def main() -> None:
    today = datetime.now(UTC).strftime("%Y-%m-%d")
    rules = load_rules("ready")
    conn = await asyncpg.connect(dsn())
    posts: dict[str, dict] = {}
    try:
        for slug in SLUGS:
            fixture = json.loads((GOLDEN_DIR / slug / "ready.json").read_text())
            spec = fixture["post_spec"]
            state_input = fixture["state_input"]

            stored = await manifest_through_jsonb(
                conn,
                uuid.uuid4(),
                spec,
                state_input["final_md"],
                state_input["image_manifest"],
            )

            post = Post(**{k: spec[k] for k in POST_FIELDS})
            post.final_md_content = state_input["final_md"]
            post.image_manifest = stored
            state = state_from_post(post, internal_links=[])

            posts[slug] = {
                "manifest_from_db": stored,
                "prompt": _build_ready_prompt(rules, state),
                "fixture_prompt_differs": _build_ready_prompt(rules, state)
                != fixture["rendered_prompts"][0],
            }
    finally:
        await conn.close()

    OUT_PATH.parent.mkdir(parents=True, exist_ok=True)
    OUT_PATH.write_text(
        json.dumps(
            {
                "why": (
                    "The prompt `_build_ready_prompt` renders when the state comes "
                    "from the posts table, which is what `_run_pipeline` does before "
                    "every stage. Differs from the golden fixture only in the order "
                    "of the image manifest's keys, because jsonb normalises them."
                ),
                "generated_by": "api/scripts/export_ready_prompt_parity.py",
                "rules_file": "rules/blog-ready.md",
                "today": today,
                "posts": posts,
            },
            indent=2,
            sort_keys=False,
        )
        + "\n"
    )
    for slug, entry in posts.items():
        print(
            f"{slug}: prompt {len(entry['prompt'])} chars, "
            f"differs from fixture: {entry['fixture_prompt_differs']}"
        )
    print(f"wrote {OUT_PATH}")


if __name__ == "__main__":
    asyncio.run(main())
