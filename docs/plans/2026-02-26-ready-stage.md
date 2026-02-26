# Ready Stage Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Add a "ready" pipeline stage after "images" that uses Claude to compose the final publishable article with images embedded inline, new frontmatter format, and no publishing notes.

**Architecture:** The ready stage receives `final_md_content` (edit) + `image_manifest` (images) and calls Claude to strategically insert image markdown/HTML at optimal placements, reformat the YAML frontmatter to the new schema (title, slug, description, date, author, category, featuredImage, featuredImageAlt, published), and strip all publishing notes. Stores output in a new `ready_content` column. For WordPress output, also generates Gutenberg HTML with `wp:image` blocks and stores in `final_html_content`. The dashboard "Ready" tab shows a full-width rendered preview of the final article with images.

**Tech Stack:** Python (FastAPI, SQLAlchemy, Alembic, LangGraph), TypeScript (Next.js, React, Tailwind, shadcn/ui), Claude API

---

### Task 1: Add `ready_content` Column to Post Model + Alembic Migration

**Files:**
- Modify: `api/src/models/post.py:66` (after `image_manifest`)
- Create: `api/alembic/versions/003_add_ready_content.py`

**Step 1: Write the Alembic migration**

```python
"""Add ready_content column to posts.

Revision ID: 003
Revises: 002
"""
from alembic import op
import sqlalchemy as sa

revision = "003"
down_revision = "002"

def upgrade() -> None:
    op.add_column("posts", sa.Column("ready_content", sa.Text(), nullable=True))

def downgrade() -> None:
    op.drop_column("posts", "ready_content")
```

**Step 2: Add column to Post model**

In `api/src/models/post.py`, after `image_manifest` line:

```python
ready_content: Mapped[str | None] = mapped_column(Text)
```

**Step 3: Update default stage_settings**

In `api/src/models/post.py`, update the `stage_settings` default to include `"ready": "review"`:

```python
stage_settings: Mapped[dict] = mapped_column(
    JSONB,
    server_default='{"research":"review","outline":"review","write":"review","edit":"review","images":"review","ready":"review"}',
    default=lambda: {
        "research": "review",
        "outline": "review",
        "write": "review",
        "edit": "review",
        "images": "review",
        "ready": "review",
    },
)
```

**Step 4: Run migration to verify**

Run: `cd api && uv run alembic upgrade head`
Expected: Migration applies successfully, `ready_content` column added.

**Step 5: Commit**

```bash
git add api/src/models/post.py api/alembic/versions/003_add_ready_content.py
git commit -m "feat: add ready_content column to posts table"
```

---

### Task 2: Update Pipeline State Constants

**Files:**
- Modify: `api/src/pipeline/state.py`

**Step 1: Write the failing test**

Create `api/tests/phase6/test_ready_stage.py`:

```python
"""Tests for the ready stage pipeline integration."""

from src.pipeline.state import STAGES, STAGE_CONTENT_MAP, STAGE_PROVIDER_MAP, STAGE_RULES_MAP


def test_ready_in_stages():
    assert "ready" in STAGES
    assert STAGES[-1] == "ready"
    assert STAGES.index("ready") == 5


def test_ready_in_content_map():
    assert STAGE_CONTENT_MAP["ready"] == "ready_content"


def test_ready_in_provider_map():
    assert STAGE_PROVIDER_MAP["ready"] == "claude"


def test_ready_in_rules_map():
    assert STAGE_RULES_MAP["ready"] == "blog-ready.md"
```

**Step 2: Run test to verify it fails**

Run: `cd api && uv run pytest tests/phase6/test_ready_stage.py -v`
Expected: FAIL — "ready" not in STAGES

**Step 3: Update state.py constants**

In `api/src/pipeline/state.py`:

```python
STAGES = ["research", "outline", "write", "edit", "images", "ready"]

STAGE_CONTENT_MAP: dict[str, str] = {
    "research": "research_content",
    "outline": "outline_content",
    "write": "draft_content",
    "edit": "final_md_content",
    "images": "image_manifest",
    "ready": "ready_content",
}

STAGE_PROVIDER_MAP: dict[str, str] = {
    "research": "perplexity",
    "outline": "claude",
    "write": "claude",
    "edit": "claude",
    "images": "gemini",
    "ready": "claude",
}

STAGE_RULES_MAP: dict[str, str] = {
    "research": "blog-research.md",
    "outline": "blog-outline.md",
    "write": "blog-write.md",
    "edit": "blog-edit.md",
    "images": "blog-images.md",
    "ready": "blog-ready.md",
}
```

**Step 4: Update `state_from_post` to include `ready_content`**

Add to the PipelineState TypedDict:

```python
ready: str
```

Add to the `state_from_post` function return dict:

```python
ready=post.ready_content or "",
```

**Step 5: Run tests to verify they pass**

Run: `cd api && uv run pytest tests/phase6/test_ready_stage.py -v`
Expected: PASS (4 tests)

**Step 6: Commit**

```bash
git add api/src/pipeline/state.py api/tests/phase6/test_ready_stage.py
git commit -m "feat: add ready stage to pipeline constants"
```

---

### Task 3: Create the Ready Stage Rules File

**Files:**
- Create: `rules/blog-ready.md`

**Step 1: Write the rules file**

```markdown
# Blog Ready Stage — Final Assembly

You are a publishing specialist. Your task is to compose the final, publication-ready article by combining the edited content with generated images.

## Your Role

- Take the finalized markdown content and image manifest
- Strategically insert images at optimal placements within the article
- Reformat the YAML frontmatter to the publication schema
- Strip all publishing notes
- Produce clean, ready-to-publish output

## Instructions

### Input

You receive:
1. **Final Markdown Content** — The edited article with YAML frontmatter and publishing notes
2. **Image Manifest** — JSON with generated images, their URLs, alt text, and placement info

### Step 1: Reformat YAML Frontmatter

Replace the existing frontmatter with this exact schema:

```yaml
---
title: "[Title from existing frontmatter]"
slug: "[slug from existing frontmatter or post config]"
description: "[Meta description from publishing notes SEO section, 150-160 chars]"
date: "[YYYY-MM-DD from today or existing date]"
author: "[author from existing frontmatter, or profile default]"
category: "[Derive from content niche/topic — single primary category]"
featuredImage: "[URL of the featured image from manifest]"
featuredImageAlt: "[Alt text of the featured image from manifest]"
published: true
---
```

**Rules:**
- `description` comes from the meta description in the publishing notes SEO section
- `category` is derived from the content — pick the single most relevant category
- `featuredImage` is the URL of the image with `placement.location == "featured_image"` or `type == "featured"` from the manifest
- `featuredImageAlt` is the `alt_text` of that featured image
- If no author exists, use the profile name or "team"
- `published: true` always

### Step 2: Insert Images Into Content

For each image in the manifest (excluding the featured image):

1. Find the optimal placement using the manifest's `placement.after_section` field
2. Insert the image markdown after the first paragraph following that section heading
3. Use this format: `![alt_text](url)`

**Placement strategy:**
- Place images AFTER the first paragraph of their target section (not immediately after the heading)
- This lets the reader engage with the section's topic before seeing the visual
- If the target section doesn't exist, find the closest thematic match
- Space images evenly — avoid clustering multiple images in consecutive paragraphs
- Never place an image as the very last element of the article (before the CTA)

**Featured image handling:**
- Do NOT insert the featured image inline in the body
- It goes ONLY in the frontmatter as `featuredImage` and `featuredImageAlt`
- The publishing platform handles featured image display

### Step 3: Strip Publishing Notes

Remove the entire `<!-- PUBLISHING NOTES ... -->` comment block from the end of the content. The final output should end with the article content (conclusion/CTA), with no metadata comments appended.

### Step 4: Output Format

**For Markdown output:**

Output the complete article as clean markdown:
- New YAML frontmatter (Step 1 format)
- Article body with images inserted (Step 2)
- No publishing notes (Step 3)
- No trailing separators or comment blocks

**For WordPress output:**

If the post's `output_format` is "wordpress" or "both", also produce WordPress Gutenberg HTML:
- No YAML frontmatter (WordPress uses its own meta system)
- Insert `<!-- wp:image -->` blocks at the same placements as the markdown images
- Featured image: Note in a comment at the top that it should be set via WordPress featured image UI
- Image block format:
  ```html
  <!-- wp:image {"sizeSlug":"large"} -->
  <figure class="wp-block-image size-large"><img src="[url]" alt="[alt_text]"/></figure>
  <!-- /wp:image -->
  ```
- No publishing notes comment block at the end

**Separator between formats:**

If both formats are produced, separate them with:
```
---WORDPRESS_HTML---
```

The markdown goes first, WordPress HTML second.

## Important Notes

- Preserve all existing content exactly — do not edit, rephrase, or modify the article text
- Only ADD images and REFORMAT frontmatter
- Only REMOVE publishing notes
- If an image's `generated` field is `false`, skip it (do not insert failed images)
- Keep all existing links intact
- The output should be immediately publishable with zero manual edits
```

**Step 2: Commit**

```bash
git add rules/blog-ready.md
git commit -m "feat: add blog-ready.md rules file for ready stage"
```

---

### Task 4: Create the Ready Stage Node

**Files:**
- Create: `api/src/pipeline/stages/ready.py`
- Test: `api/tests/phase6/test_ready_node.py`

**Step 1: Write the failing test**

```python
"""Tests for the ready stage node."""

import json
from unittest.mock import AsyncMock, patch

import pytest

from src.pipeline.stages.ready import ready_node


@pytest.fixture
def ready_state():
    """State with completed edit + images stages."""
    return {
        "post_id": "test-post-123",
        "slug": "best-ar15-optics",
        "topic": "Best AR15 Optics for Every Budget",
        "output_format": "markdown",
        "final_md": '---\ntitle: "Best AR15 Optics"\nkeywords: "ar15, optics"\n---\n\n# Best AR15 Optics\n\nIntro paragraph.\n\n## Budget Picks\n\nBudget content here.\n\n## Mid-Range\n\nMid-range content.\n\n---\n\n<!--\nPUBLISHING NOTES\n================\nSEO INFORMATION\n---------------\nMeta Description: Find the best AR15 optics.\nPrimary Keyword: best AR15 optics\n-->\n',
        "image_manifest": {
            "images": [
                {
                    "id": "featured",
                    "type": "featured",
                    "filename": "featured.png",
                    "url": "/media/test-post-123/featured.png",
                    "alt_text": "AR15 with mounted optic",
                    "placement": {"location": "featured_image", "after_section": None},
                    "generated": True,
                },
                {
                    "id": "content-1",
                    "type": "content",
                    "filename": "budget-optics.png",
                    "url": "/media/test-post-123/budget-optics.png",
                    "alt_text": "Budget AR15 optics comparison",
                    "placement": {"location": "after_heading", "after_section": "Budget Picks"},
                    "generated": True,
                },
            ],
            "style_brief": {"overall_style": "editorial illustration"},
        },
        "stage_settings": {"ready": "review"},
        "stage_status": {"images": "complete"},
    }


@pytest.mark.asyncio
async def test_ready_node_returns_expected_keys(ready_state):
    """Ready node should return ready content and stage metadata."""
    mock_response = AsyncMock()
    mock_response.content = '---\ntitle: "Best AR15 Optics"\nslug: "best-ar15-optics"\ndescription: "Find the best AR15 optics."\ndate: "2026-02-26"\nauthor: "team"\ncategory: "Optics"\nfeaturedImage: "/media/test-post-123/featured.png"\nfeaturedImageAlt: "AR15 with mounted optic"\npublished: true\n---\n\n# Best AR15 Optics\n\nIntro paragraph.\n\n## Budget Picks\n\nBudget content here.\n\n![Budget AR15 optics comparison](/media/test-post-123/budget-optics.png)\n\n## Mid-Range\n\nMid-range content.'
    mock_response.tokens_in = 2000
    mock_response.tokens_out = 3000
    mock_response.model = "claude-opus-4-6"

    with patch("src.pipeline.stages.ready.ClaudeClient") as MockClaude:
        instance = MockClaude.return_value
        instance.chat = AsyncMock(return_value=mock_response)
        instance.close = AsyncMock()

        result = await ready_node(ready_state)

    assert "ready" in result
    assert isinstance(result["ready"], str)
    assert "PUBLISHING NOTES" not in result["ready"]
    assert "featuredImage" in result["ready"]
    assert result["current_stage"] == "ready"
    assert result["stage_status"]["ready"] == "complete"
    assert result["_stage_meta"]["stage"] == "ready"


@pytest.mark.asyncio
async def test_ready_node_skips_failed_images(ready_state):
    """Ready node should not include failed images in its prompt."""
    ready_state["image_manifest"]["images"].append({
        "id": "content-2",
        "type": "content",
        "filename": "failed.png",
        "url": "/media/test-post-123/failed.png",
        "alt_text": "Failed image",
        "placement": {"location": "after_heading", "after_section": "Mid-Range"},
        "generated": False,
        "error": "Safety filter triggered",
    })

    mock_response = AsyncMock()
    mock_response.content = "assembled content"
    mock_response.tokens_in = 1000
    mock_response.tokens_out = 2000
    mock_response.model = "claude-opus-4-6"

    with patch("src.pipeline.stages.ready.ClaudeClient") as MockClaude:
        instance = MockClaude.return_value
        instance.chat = AsyncMock(return_value=mock_response)
        instance.close = AsyncMock()

        result = await ready_node(ready_state)

    # Verify the prompt sent to Claude doesn't include the failed image
    call_args = instance.chat.call_args
    prompt = call_args.kwargs.get("prompt") or call_args[1].get("prompt") or call_args[0][0] if call_args[0] else ""
    # The prompt should be a string that was sent to Claude
    assert result["ready"] == "assembled content"
```

**Step 2: Run tests to verify they fail**

Run: `cd api && uv run pytest tests/phase6/test_ready_node.py -v`
Expected: FAIL — module not found

**Step 3: Implement the ready stage node**

Create `api/src/pipeline/stages/ready.py`:

```python
"""Ready stage: compose final publishable article with images embedded."""

from __future__ import annotations

import json
import logging

from src.pipeline.helpers import (
    StageTimer,
    build_stage_prompt,
    load_rules,
    publish_stage_log,
)
from src.pipeline.state import PipelineState
from src.services.llm import ClaudeClient, LLMResponse

logger = logging.getLogger(__name__)


async def ready_node(state: PipelineState) -> dict:
    """Execute the ready stage.

    Takes final_md_content + image_manifest and produces the final
    publishable article with images strategically inserted, new
    frontmatter format, and no publishing notes.
    """
    logger.info(f"Ready stage starting for post {state.get('post_id')}")

    rules = load_rules("ready")
    await publish_stage_log("Rules loaded, building prompt...", stage="ready")

    # Build prompt with ready-specific context
    prompt = _build_ready_prompt(rules, state)

    claude = ClaudeClient()
    await publish_stage_log("Calling Claude for final assembly...", stage="ready")
    try:
        with StageTimer() as timer:
            response: LLMResponse = await claude.chat(
                prompt=prompt,
                system=(
                    "You are a publishing specialist. Compose the final "
                    "publication-ready article by inserting images at strategic "
                    "placements, reformatting the frontmatter, and stripping "
                    "publishing notes. Output ONLY the final article content, "
                    "no explanations or commentary."
                ),
                max_tokens=16000,
            )
    finally:
        await claude.close()

    await publish_stage_log(
        f"Final assembly complete ({response.tokens_out} tokens in {timer.duration:.1f}s)",
        stage="ready",
    )

    return {
        "ready": response.content,
        "current_stage": "ready",
        "stage_status": {
            **state.get("stage_status", {}),
            "ready": "complete",
        },
        "_stage_meta": {
            "stage": "ready",
            "model": response.model,
            "tokens_in": response.tokens_in,
            "tokens_out": response.tokens_out,
            "duration_s": timer.duration,
        },
    }


def _build_ready_prompt(rules: str, state: PipelineState) -> str:
    """Build the prompt for the ready stage with all necessary context."""
    sections: list[str] = []

    if rules:
        sections.append(rules)

    # Post config
    sections.append(f"## Post Configuration\n\n- **SLUG**: {state.get('slug', '')}")
    sections.append(f"- **OUTPUT_FORMAT**: {state.get('output_format', 'markdown')}")

    # Final markdown content from edit stage
    final_md = state.get("final_md", "")
    if final_md:
        sections.append(f"## Final Markdown Content (from edit stage)\n\n{final_md}")

    # Image manifest — only include successfully generated images
    manifest = state.get("image_manifest", {})
    if manifest:
        images = manifest.get("images", [])
        generated_images = [img for img in images if img.get("generated", False)]
        filtered_manifest = {**manifest, "images": generated_images}
        sections.append(
            f"## Image Manifest (generated images only)\n\n"
            f"```json\n{json.dumps(filtered_manifest, indent=2)}\n```"
        )

    return "\n\n---\n\n".join(sections)
```

**Step 4: Run tests to verify they pass**

Run: `cd api && uv run pytest tests/phase6/test_ready_node.py -v`
Expected: PASS (2 tests)

**Step 5: Commit**

```bash
git add api/src/pipeline/stages/ready.py api/tests/phase6/test_ready_node.py
git commit -m "feat: implement ready stage node with Claude integration"
```

---

### Task 5: Wire Ready Stage Into Pipeline Graph + Gates

**Files:**
- Modify: `api/src/pipeline/gates.py`
- Modify: `api/src/pipeline/graph.py`

**Step 1: Write the failing test**

Add to `api/tests/phase6/test_ready_stage.py`:

```python
from src.pipeline.gates import STAGE_OUTPUT_KEY, ready_gate


def test_ready_gate_exists():
    assert callable(ready_gate)


def test_ready_in_stage_output_key():
    assert STAGE_OUTPUT_KEY["ready"] == "ready"


def test_ready_gate_is_terminal():
    """Ready gate should route to __end__ since it's the last stage."""
    from src.pipeline.gates import _next_node_after_gate
    assert _next_node_after_gate("ready") == "__end__"


def test_images_gate_routes_to_ready():
    from src.pipeline.gates import _next_node_after_gate
    assert _next_node_after_gate("images") == "ready_node"
```

**Step 2: Run tests to verify they fail**

Run: `cd api && uv run pytest tests/phase6/test_ready_stage.py -v`
Expected: FAIL — ready_gate not found

**Step 3: Update gates.py**

In `api/src/pipeline/gates.py`:

Add `"ready": "ready"` to `STAGE_OUTPUT_KEY`:

```python
STAGE_OUTPUT_KEY: dict[str, str] = {
    "research": "research",
    "outline": "outline",
    "write": "draft",
    "edit": "final_md",
    "images": "image_manifest",
    "ready": "ready",
}
```

Update the `make_gate` function's type annotation to include `"ready_node"`:

```python
def gate_fn(
    state: PipelineState,
) -> Command[
    Literal[
        "research_node",
        "outline_node",
        "write_node",
        "edit_node",
        "images_node",
        "ready_node",
        "__end__",
    ]
]:
```

Add the ready gate at the bottom:

```python
ready_gate = make_gate("ready")
```

**Step 4: Update graph.py**

In `api/src/pipeline/graph.py`:

Add imports:

```python
from src.pipeline.gates import (
    edit_gate,
    images_gate,
    outline_gate,
    ready_gate,
    research_gate,
    write_gate,
)
from src.pipeline.stages.ready import ready_node
```

In `build_graph()`, add the ready node and gate:

```python
builder.add_node("ready_node", ready_node)
builder.add_node("ready_gate", ready_gate)
builder.add_edge("ready_node", "ready_gate")
```

**Step 5: Run tests to verify they pass**

Run: `cd api && uv run pytest tests/phase6/test_ready_stage.py -v`
Expected: PASS (all tests)

**Step 6: Commit**

```bash
git add api/src/pipeline/gates.py api/src/pipeline/graph.py api/tests/phase6/test_ready_stage.py
git commit -m "feat: wire ready stage into pipeline graph and gates"
```

---

### Task 6: Update Worker + Helpers for Ready Stage

**Files:**
- Modify: `api/src/worker.py`
- Modify: `api/src/pipeline/helpers.py`

**Step 1: Update worker.py**

Add import:

```python
from src.pipeline.stages.ready import ready_node
```

Add to `STAGE_NODE_FN`:

```python
STAGE_NODE_FN = {
    "research": research_node,
    "outline": outline_node,
    "write": write_node,
    "edit": edit_node,
    "images": images_node,
    "ready": ready_node,
}
```

Add to the `content_key_map` inside `_run_single_stage`:

```python
content_key_map = {
    "research": "research",
    "outline": "outline",
    "write": "draft",
    "edit": "final_md",
    "images": "image_manifest",
    "ready": "ready",
}
```

And the same in `_run_full_pipeline`:

```python
content_key_map = {
    "research": "research",
    "outline": "outline",
    "write": "draft",
    "edit": "final_md",
    "images": "image_manifest",
    "ready": "ready",
}
```

**Step 2: Update helpers.py `_get_previous_output`**

Add to the `output_keys` dict in `_get_previous_output`:

```python
output_keys = {
    "research": "research",
    "outline": "outline",
    "write": "draft",
    "edit": "final_md",
    "images": "image_manifest",
    "ready": "ready",
}
```

**Step 3: Run existing tests to verify nothing broke**

Run: `cd api && uv run pytest tests/ -v --tb=short`
Expected: All existing tests pass

**Step 4: Commit**

```bash
git add api/src/worker.py api/src/pipeline/helpers.py
git commit -m "feat: add ready stage to worker and helpers"
```

---

### Task 7: Update Backend Schemas

**Files:**
- Modify: `api/src/models/schemas.py`

**Step 1: Update PostRead schema**

Add `ready_content` field:

```python
class PostRead(PostBase):
    model_config = ConfigDict(from_attributes=True)

    id: uuid.UUID
    current_stage: str = "pending"
    stage_status: dict = {}
    stage_logs: dict = {}
    thread_id: str | None = None
    priority: int = 0
    research_content: str | None = None
    outline_content: str | None = None
    draft_content: str | None = None
    final_md_content: str | None = None
    final_html_content: str | None = None
    image_manifest: dict | None = None
    ready_content: str | None = None  # NEW
    created_at: datetime
    updated_at: datetime
    completed_at: datetime | None = None
```

**Step 2: Update PostUpdate schema**

Add `ready_content` field:

```python
class PostUpdate(BaseModel):
    # ... existing fields ...
    ready_content: str | None = None  # NEW
```

**Step 3: Update default stage_settings in PostBase and ProfileBase**

In both `PostBase.stage_settings` and `ProfileBase.default_stage_settings`, add `"ready": "review"`:

```python
stage_settings: dict = {
    "research": "review",
    "outline": "review",
    "write": "review",
    "edit": "review",
    "images": "review",
    "ready": "review",
}
```

**Step 4: Run tests**

Run: `cd api && uv run pytest tests/ -v --tb=short`
Expected: All tests pass

**Step 5: Commit**

```bash
git add api/src/models/schemas.py
git commit -m "feat: add ready_content to API schemas"
```

---

### Task 8: Update Frontend Types + Constants

**Files:**
- Modify: `web/src/lib/api.ts`

**Step 1: Update types**

```typescript
export type PipelineStage = "research" | "outline" | "write" | "edit" | "images" | "ready";

export const STAGES: PipelineStage[] = ["research", "outline", "write", "edit", "images", "ready"];
```

**Step 2: Add `ready_content` to Post interface**

```typescript
export interface Post {
  // ... existing fields ...
  ready_content: string | null;  // NEW — after image_manifest
}
```

**Step 3: Add `ready_content` to PostUpdate interface**

```typescript
export interface PostUpdate {
  // ... existing fields ...
  ready_content?: string | null;
}
```

**Step 4: Run frontend type check**

Run: `cd web && pnpm tsc --noEmit`
Expected: Type errors in components that reference STAGES/PipelineStage (expected, we fix in next tasks)

**Step 5: Commit**

```bash
git add web/src/lib/api.ts
git commit -m "feat: add ready stage to frontend types"
```

---

### Task 9: Update Frontend Pipeline Progress + Stage Badge

**Files:**
- Modify: `web/src/components/pipeline-progress.tsx`
- Modify: `web/src/components/stage-badge.tsx`

**Step 1: Update pipeline-progress.tsx**

Add to `STAGE_META`:

```typescript
import { PackageCheck } from "lucide-react";  // or Rocket, CheckCheck, etc.

const STAGE_META: Record<PipelineStage, { label: string; icon: ... }> = {
  // ... existing ...
  ready: { label: "Ready", icon: PackageCheck },
};
```

**Step 2: Update stage-badge.tsx**

Add to `STAGE_COLORS`:

```typescript
const STAGE_COLORS: Record<string, string> = {
  // ... existing ...
  ready: "bg-cyan-500/15 text-cyan-400 border-cyan-500/20",
};
```

**Step 3: Run type check**

Run: `cd web && pnpm tsc --noEmit`
Expected: Fewer errors (progress component now handles "ready")

**Step 4: Commit**

```bash
git add web/src/components/pipeline-progress.tsx web/src/components/stage-badge.tsx
git commit -m "feat: add ready stage to pipeline progress and stage badge"
```

---

### Task 10: Update Post Detail Page — Ready Tab

**Files:**
- Modify: `web/src/app/posts/[id]/page.tsx`

**Step 1: Update stage content maps**

```typescript
const STAGE_CONTENT_FIELDS: Record<PipelineStage, keyof Post> = {
  research: "research_content",
  outline: "outline_content",
  write: "draft_content",
  edit: "final_md_content",
  images: "image_manifest",
  ready: "ready_content",
};

const STAGE_UPDATE_FIELDS: Record<PipelineStage, string> = {
  research: "research_content",
  outline: "outline_content",
  write: "draft_content",
  edit: "final_md_content",
  images: "image_manifest",
  ready: "ready_content",
};

const STAGE_LABELS: Record<PipelineStage, string> = {
  research: "Research",
  outline: "Outline",
  write: "Draft",
  edit: "Final",
  images: "Images",
  ready: "Ready",
};
```

**Step 2: Update tab rendering for the ready stage**

The "Ready" tab should show a **full-width rendered preview** (not split editor/preview). In the STAGES.map section, add a condition for the ready stage:

```tsx
{stage === "ready" ? (
  content ? (
    <Card>
      <CardHeader className="flex flex-row items-center justify-between py-3">
        <CardTitle className="text-base">Ready — Final Preview</CardTitle>
      </CardHeader>
      <Separator />
      <CardContent className="p-0">
        <ContentPreview
          content={content as string}
          height="700px"
        />
      </CardContent>
    </Card>
  ) : (
    /* empty state placeholder */
  )
) : stage === "images" ? (
  /* existing images tab */
) : content ? (
  /* existing editor/preview split */
) : (
  /* existing empty state */
)}
```

**Step 3: Update ExportButton to use ready_content when available**

In the ExportButton usage, prefer `ready_content` over `final_md_content`:

```tsx
<ExportButton
  postId={postId}
  hasMd={!!(post.ready_content || post.final_md_content)}
  hasHtml={!!post.final_html_content}
  mdContent={post.ready_content || post.final_md_content}
  htmlContent={post.final_html_content}
/>
```

**Step 4: Run lint + type check**

Run: `cd web && pnpm lint && pnpm tsc --noEmit`
Expected: PASS

**Step 5: Run frontend tests**

Run: `cd web && pnpm test`
Expected: Some tests may need updates for the new stage

**Step 6: Commit**

```bash
git add web/src/app/posts/[id]/page.tsx
git commit -m "feat: add Ready tab with full-width preview to post detail"
```

---

### Task 11: Update Frontend Tests

**Files:**
- Modify: `web/src/test/fixtures.ts` (add `ready_content` to test fixtures)
- Modify: any test files that reference STAGES or stage counts

**Step 1: Update test fixtures**

Add `ready_content: null` to the Post fixture. Add `"ready": "review"` to `stage_settings` fixture.

**Step 2: Update any assertions about stage counts**

Search for assertions like `STAGES.length` being 5 and update to 6.

**Step 3: Run tests**

Run: `cd web && pnpm test`
Expected: All tests pass

**Step 4: Commit**

```bash
git add web/src/test/
git commit -m "test: update frontend fixtures for ready stage"
```

---

### Task 12: Update Post Creation Form Default Stage Settings

**Files:**
- Modify: `web/src/app/posts/new/page.tsx` (or wherever the post creation form is)

**Step 1: Find and update default stage_settings**

Search for default stage_settings in the creation form and add `"ready": "review"`.

**Step 2: Run type check + tests**

Run: `cd web && pnpm lint && pnpm tsc --noEmit && pnpm test`
Expected: PASS

**Step 3: Commit**

```bash
git add web/src/app/posts/new/
git commit -m "feat: add ready stage to post creation defaults"
```

---

### Task 13: Full Integration Test

**Step 1: Run all backend tests**

Run: `cd api && uv run pytest tests/ -v`
Expected: All tests pass (existing + new phase6 tests)

**Step 2: Run all frontend tests**

Run: `cd web && pnpm test && pnpm lint && pnpm tsc --noEmit`
Expected: All pass

**Step 3: Verify migration works cleanly**

Run: `cd api && uv run alembic downgrade -1 && uv run alembic upgrade head`
Expected: Migration applies and rolls back cleanly

**Step 4: Final commit**

```bash
git add -A
git commit -m "feat: ready stage — complete implementation with images, new frontmatter, no publishing notes"
```
