# Jena AI Next.js Publishing — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add Next.js webhook publishing to the Jena AI platform so completed articles auto-deliver to connected Next.js blogs via signed webhooks.

**Architecture:** Mirrors the existing WordPress publishing flow. New Profile/Post fields, a new `publish_to_nextjs` ARQ job, HMAC-signed webhook delivery with optional signed download URLs for images, and dashboard UI for configuration and status tracking.

**Tech Stack:** Python (FastAPI, SQLAlchemy, ARQ), Next.js 16 + React 19 (dashboard), Alembic (migrations)

**Spec:** `docs/superpowers/specs/2026-04-09-nextjs-blog-integration-design.md`

**Key reference files (existing WordPress integration to mirror):**
- `api/src/models/profile.py:72-79` — WordPress profile fields
- `api/src/models/post.py:72-77` — WordPress post fields
- `api/src/models/schemas.py` — WordPress schema fields
- `api/src/pipeline/publish.py:43-75` — WordPress publish job
- `api/src/api/wordpress.py:54-76` — WordPress test endpoint
- `api/src/api/profiles.py:53-57,93-97` — WordPress credential encryption
- `api/src/worker.py:434-445` — WordPress auto-publish trigger
- `api/src/services/crypto.py` — Fernet encryption utilities

---

## File Map

```
api/
  alembic/versions/
    011_add_nextjs_publishing_fields.py     # New migration
  src/
    models/
      profile.py                            # Add nextjs_* fields
      post.py                               # Add nextjs_* fields
    models/
      schemas.py                            # Add nextjs_* to schemas
    services/
      nextjs_publish.py                     # New: publish_to_nextjs job
      hmac_signing.py                       # New: HMAC signing utility
    api/
      nextjs.py                             # New: test/publish endpoints
    main.py                                 # Register nextjs router
    worker.py                               # Add auto-publish trigger
  tests/
    phase_nextjs/
      test_hmac_signing.py
      test_nextjs_publish.py
      test_nextjs_api.py
      test_frontmatter_mapping.py

web/
  src/
    app/profiles/[id]/
      page.tsx                              # Add Next.js config section
    lib/
      api.ts                                # Add nextjs API methods
```

---

### Task 1: Database Migration

**Files:**
- Create: `api/alembic/versions/011_add_nextjs_publishing_fields.py`

- [ ] **Step 1: Write migration**

Create `api/alembic/versions/011_add_nextjs_publishing_fields.py`:

```python
"""Add Next.js publishing fields to profiles and posts.

Revision ID: 011
Revises: 010
"""

from __future__ import annotations

from alembic import op
import sqlalchemy as sa

revision = "011"
down_revision = "010"
branch_labels = None
depends_on = None


def upgrade() -> None:
    # Profile fields for Next.js webhook config
    op.add_column(
        "website_profiles",
        sa.Column("nextjs_webhook_url", sa.Text(), nullable=True),
    )
    op.add_column(
        "website_profiles",
        sa.Column("nextjs_webhook_secret", sa.Text(), nullable=True),
    )
    op.add_column(
        "website_profiles",
        sa.Column(
            "nextjs_frontmatter_map",
            sa.JSON(),
            nullable=True,
        ),
    )

    # Post fields for Next.js publish tracking
    op.add_column(
        "posts",
        sa.Column("nextjs_publish_status", sa.String(20), nullable=True),
    )
    op.add_column(
        "posts",
        sa.Column(
            "nextjs_published_at",
            sa.DateTime(timezone=True),
            nullable=True,
        ),
    )


def downgrade() -> None:
    op.drop_column("posts", "nextjs_published_at")
    op.drop_column("posts", "nextjs_publish_status")
    op.drop_column("website_profiles", "nextjs_frontmatter_map")
    op.drop_column("website_profiles", "nextjs_webhook_secret")
    op.drop_column("website_profiles", "nextjs_webhook_url")
```

- [ ] **Step 2: Run migration**

```bash
cd api && uv run alembic upgrade head
```
Expected: migration applies successfully

- [ ] **Step 3: Verify columns exist**

```bash
cd api && uv run python -c "
from sqlalchemy import create_engine, inspect
from src.config import settings
engine = create_engine(settings.database_url_sync)
cols = [c['name'] for c in inspect(engine).get_columns('website_profiles')]
assert 'nextjs_webhook_url' in cols, 'Missing nextjs_webhook_url'
assert 'nextjs_webhook_secret' in cols, 'Missing nextjs_webhook_secret'
assert 'nextjs_frontmatter_map' in cols, 'Missing nextjs_frontmatter_map'
print('Profile columns OK')

cols = [c['name'] for c in inspect(engine).get_columns('posts')]
assert 'nextjs_publish_status' in cols, 'Missing nextjs_publish_status'
assert 'nextjs_published_at' in cols, 'Missing nextjs_published_at'
print('Post columns OK')
"
```
Expected: "Profile columns OK" and "Post columns OK"

- [ ] **Step 4: Commit**

```bash
git add api/alembic/versions/011_add_nextjs_publishing_fields.py
git commit -m "feat: add alembic migration 011 for Next.js publishing fields"
```

---

### Task 2: Model Updates

**Files:**
- Modify: `api/src/models/profile.py:79` (after wp_default_status)
- Modify: `api/src/models/post.py:77` (after wp_publish_status)

- [ ] **Step 1: Write failing test**

Create `api/tests/phase_nextjs/test_models.py`:

```python
from __future__ import annotations

import pytest
from sqlalchemy.ext.asyncio import AsyncSession

from src.models.profile import WebsiteProfile
from src.models.post import Post


@pytest.mark.asyncio
async def test_profile_has_nextjs_fields(session: AsyncSession):
    profile = WebsiteProfile(
        name="Test",
        website_url="https://test.com",
        nextjs_webhook_url="https://test.com/api/jena-webhook",
        nextjs_webhook_secret="encrypted-secret",
        nextjs_frontmatter_map={"title": "title", "category": {"key": "category", "transform": "array"}},
    )
    session.add(profile)
    await session.commit()
    await session.refresh(profile)

    assert profile.nextjs_webhook_url == "https://test.com/api/jena-webhook"
    assert profile.nextjs_webhook_secret == "encrypted-secret"
    assert profile.nextjs_frontmatter_map["title"] == "title"


@pytest.mark.asyncio
async def test_post_has_nextjs_fields(session: AsyncSession):
    post = Post(
        slug="test-post",
        topic="Test",
        nextjs_publish_status="published",
    )
    session.add(post)
    await session.commit()
    await session.refresh(post)

    assert post.nextjs_publish_status == "published"
    assert post.nextjs_published_at is None
```

- [ ] **Step 2: Run test to verify it fails**

```bash
cd api && pytest tests/phase_nextjs/test_models.py -v
```
Expected: FAIL — fields not on model

- [ ] **Step 3: Add fields to Profile model**

In `api/src/models/profile.py`, after the `wp_default_status` field (line 79), add:

```python
    # Next.js webhook integration
    nextjs_webhook_url: Mapped[str | None] = mapped_column(Text)
    nextjs_webhook_secret: Mapped[str | None] = mapped_column(Text)
    nextjs_frontmatter_map: Mapped[dict | None] = mapped_column(JSON)
```

Ensure `JSON` is imported from `sqlalchemy` at the top of the file (alongside `Text`, `String`, `Integer`).

- [ ] **Step 4: Add fields to Post model**

In `api/src/models/post.py`, after the `wp_publish_status` field (line 77), add:

```python
    # Next.js publishing
    nextjs_publish_status: Mapped[str | None] = mapped_column(String(20))
    nextjs_published_at: Mapped[datetime | None] = mapped_column(
        DateTime(timezone=True)
    )
```

Ensure `DateTime` is imported from `sqlalchemy` (should already be present).

- [ ] **Step 5: Run test to verify it passes**

```bash
cd api && pytest tests/phase_nextjs/test_models.py -v
```
Expected: PASS (2 tests)

- [ ] **Step 6: Commit**

```bash
git add api/src/models/profile.py api/src/models/post.py api/tests/phase_nextjs/test_models.py
git commit -m "feat: add nextjs publishing fields to Profile and Post models"
```

---

### Task 3: Schema Updates

**Files:**
- Modify: `api/src/models/schemas.py`

- [ ] **Step 1: Write failing test**

Create `api/tests/phase_nextjs/test_schemas.py`:

```python
from __future__ import annotations

from src.models.schemas import ProfileCreate, ProfileUpdate, ProfileRead, PostRead


def test_profile_create_accepts_nextjs_fields():
    profile = ProfileCreate(
        name="Test",
        website_url="https://test.com",
        nextjs_webhook_url="https://test.com/api/jena-webhook",
        nextjs_webhook_secret="my-secret",
        nextjs_frontmatter_map={"title": "title"},
    )
    assert profile.nextjs_webhook_url == "https://test.com/api/jena-webhook"
    assert profile.nextjs_webhook_secret == "my-secret"


def test_profile_update_accepts_nextjs_fields():
    update = ProfileUpdate(nextjs_webhook_url="https://new.com/api/jena-webhook")
    assert update.nextjs_webhook_url == "https://new.com/api/jena-webhook"


def test_profile_read_excludes_webhook_secret():
    """ProfileRead should NOT expose the webhook secret."""
    read = ProfileRead(
        id="00000000-0000-0000-0000-000000000000",
        name="Test",
        website_url="https://test.com",
        nextjs_webhook_url="https://test.com/api/jena-webhook",
        created_at="2026-01-01T00:00:00Z",
        updated_at="2026-01-01T00:00:00Z",
    )
    data = read.model_dump()
    assert "nextjs_webhook_secret" not in data
    assert data["nextjs_webhook_url"] == "https://test.com/api/jena-webhook"


def test_post_read_includes_nextjs_status():
    post = PostRead(
        id="00000000-0000-0000-0000-000000000000",
        slug="test",
        topic="Test",
        nextjs_publish_status="published",
        created_at="2026-01-01T00:00:00Z",
        updated_at="2026-01-01T00:00:00Z",
    )
    assert post.nextjs_publish_status == "published"
```

- [ ] **Step 2: Run test to verify it fails**

```bash
cd api && pytest tests/phase_nextjs/test_schemas.py -v
```
Expected: FAIL — fields not on schemas

- [ ] **Step 3: Add nextjs fields to schemas**

In `api/src/models/schemas.py`:

Add to `ProfileCreate` (after `wp_default_status`):
```python
    nextjs_webhook_url: str | None = None
    nextjs_webhook_secret: str | None = None
    nextjs_frontmatter_map: dict | None = None
```

Add to `ProfileUpdate` (after `wp_default_status`):
```python
    nextjs_webhook_url: str | None = None
    nextjs_webhook_secret: str | None = None
    nextjs_frontmatter_map: dict | None = None
```

Add to `ProfileRead` (after `wp_default_status`, **exclude secret**):
```python
    nextjs_webhook_url: str | None = None
    nextjs_frontmatter_map: dict | None = None
```

Note: `nextjs_webhook_secret` is intentionally excluded from `ProfileRead` — write-only, never returned in API responses.

Add to `PostRead` (after `wp_publish_status`):
```python
    nextjs_publish_status: str | None = None
    nextjs_published_at: datetime | None = None
```

- [ ] **Step 4: Run test to verify it passes**

```bash
cd api && pytest tests/phase_nextjs/test_schemas.py -v
```
Expected: PASS (4 tests)

- [ ] **Step 5: Commit**

```bash
git add api/src/models/schemas.py api/tests/phase_nextjs/test_schemas.py
git commit -m "feat: add nextjs fields to Profile and Post Pydantic schemas"
```

---

### Task 4: HMAC Signing Utility

**Files:**
- Create: `api/src/services/hmac_signing.py`
- Test: `api/tests/phase_nextjs/test_hmac_signing.py`

- [ ] **Step 1: Write the failing test**

Create `api/tests/phase_nextjs/test_hmac_signing.py`:

```python
from __future__ import annotations

import json
import time

from src.services.hmac_signing import sign_payload, verify_signature


def test_sign_and_verify_roundtrip():
    secret = "test-secret-key-12345"
    payload = json.dumps({"event": "post.published", "slug": "test"})

    signature = sign_payload(payload, secret)

    assert verify_signature(payload, signature, secret)


def test_invalid_signature_rejected():
    secret = "test-secret-key-12345"
    payload = json.dumps({"event": "post.published", "slug": "test"})

    assert not verify_signature(payload, "invalid-signature", secret)


def test_tampered_payload_rejected():
    secret = "test-secret-key-12345"
    payload = json.dumps({"event": "post.published", "slug": "test"})
    signature = sign_payload(payload, secret)

    tampered = json.dumps({"event": "post.published", "slug": "hacked"})
    assert not verify_signature(tampered, signature, secret)


def test_wrong_secret_rejected():
    payload = json.dumps({"event": "post.published", "slug": "test"})
    signature = sign_payload(payload, "correct-secret")

    assert not verify_signature(payload, signature, "wrong-secret")
```

- [ ] **Step 2: Run test to verify it fails**

```bash
cd api && pytest tests/phase_nextjs/test_hmac_signing.py -v
```
Expected: FAIL — module not found

- [ ] **Step 3: Write HMAC signing utility**

Create `api/src/services/hmac_signing.py`:

```python
from __future__ import annotations

import hashlib
import hmac


def sign_payload(payload: str, secret: str) -> str:
    """Generate HMAC-SHA256 signature for a payload."""
    return hmac.new(
        secret.encode(),
        payload.encode(),
        hashlib.sha256,
    ).hexdigest()


def verify_signature(payload: str, signature: str, secret: str) -> bool:
    """Verify HMAC-SHA256 signature using constant-time comparison."""
    expected = sign_payload(payload, secret)
    return hmac.compare_digest(expected, signature)
```

- [ ] **Step 4: Run test to verify it passes**

```bash
cd api && pytest tests/phase_nextjs/test_hmac_signing.py -v
```
Expected: PASS (4 tests)

- [ ] **Step 5: Commit**

```bash
git add api/src/services/hmac_signing.py api/tests/phase_nextjs/test_hmac_signing.py
git commit -m "feat: HMAC-SHA256 signing utility for Next.js webhook delivery"
```

---

### Task 5: Frontmatter Mapping Service

**Files:**
- Create: `api/src/services/frontmatter_mapping.py`
- Test: `api/tests/phase_nextjs/test_frontmatter_mapping.py`

- [ ] **Step 1: Write the failing test**

Create `api/tests/phase_nextjs/test_frontmatter_mapping.py`:

```python
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
    # CDN URL transform passes through the URL as-is
    assert result["image"] == "https://cdn.jena.ai/images/abc/hero.webp"
```

- [ ] **Step 2: Run test to verify it fails**

```bash
cd api && pytest tests/phase_nextjs/test_frontmatter_mapping.py -v
```
Expected: FAIL — module not found

- [ ] **Step 3: Write frontmatter mapping service**

Create `api/src/services/frontmatter_mapping.py`:

```python
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
            # Simple field mapping: "title" -> "title"
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
            # "jena-cdn-url" transform is a passthrough — URL is already correct

            result[key] = value

    return result
```

- [ ] **Step 4: Run test to verify it passes**

```bash
cd api && pytest tests/phase_nextjs/test_frontmatter_mapping.py -v
```
Expected: PASS (6 tests)

- [ ] **Step 5: Commit**

```bash
git add api/src/services/frontmatter_mapping.py api/tests/phase_nextjs/test_frontmatter_mapping.py
git commit -m "feat: frontmatter mapping service with transform support"
```

---

### Task 6: Next.js Publish Service

**Files:**
- Create: `api/src/services/nextjs_publish.py`
- Test: `api/tests/phase_nextjs/test_nextjs_publish.py`

- [ ] **Step 1: Write the failing test**

Create `api/tests/phase_nextjs/test_nextjs_publish.py`:

```python
from __future__ import annotations

import json
from unittest.mock import AsyncMock, MagicMock, patch

import pytest
from sqlalchemy.ext.asyncio import AsyncSession

from src.models.post import Post
from src.models.profile import WebsiteProfile
from src.services.crypto import encrypt


@pytest.mark.asyncio
async def test_publish_to_nextjs_sends_signed_webhook(session: AsyncSession):
    """Test that publish_to_nextjs sends a properly signed webhook."""
    # Create profile with nextjs config
    secret = "test-webhook-secret"
    profile = WebsiteProfile(
        name="Test",
        website_url="https://test.com",
        nextjs_webhook_url="https://test.com/api/jena-webhook",
        nextjs_webhook_secret=encrypt(secret),
        nextjs_frontmatter_map={"title": "title", "description": "description"},
    )
    session.add(profile)
    await session.flush()

    # Create completed post
    post = Post(
        slug="test-post",
        topic="Test Topic",
        profile_id=profile.id,
        output_format="nextjs",
        ready_content='---\ntitle: "Test Post"\ndescription: "A test"\ndate: "2026-04-09"\n---\n\nContent here.',
        image_manifest={"images": []},
    )
    session.add(post)
    await session.commit()

    # Mock httpx and redis
    mock_response = AsyncMock()
    mock_response.status_code = 200
    mock_response.json.return_value = {"received": True}

    with patch("src.services.nextjs_publish.httpx.AsyncClient") as MockClient:
        mock_client = AsyncMock()
        mock_client.post.return_value = mock_response
        mock_client.__aenter__ = AsyncMock(return_value=mock_client)
        mock_client.__aexit__ = AsyncMock(return_value=False)
        MockClient.return_value = mock_client

        mock_redis = AsyncMock()
        mock_session_factory = MagicMock()
        mock_session_factory.return_value.__aenter__ = AsyncMock(return_value=session)
        mock_session_factory.return_value.__aexit__ = AsyncMock(return_value=False)

        ctx = {"session_factory": mock_session_factory, "redis": mock_redis}

        from src.services.nextjs_publish import publish_to_nextjs

        await publish_to_nextjs(ctx, str(post.id))

        # Verify webhook was called
        mock_client.post.assert_called_once()
        call_args = mock_client.post.call_args

        # Check URL
        assert call_args[0][0] == "https://test.com/api/jena-webhook"

        # Check signature header present
        headers = call_args[1].get("headers", {})
        assert "X-Jena-Signature" in headers

        # Check payload structure
        payload = json.loads(call_args[1]["content"])
        assert payload["event"] == "post.published"
        assert payload["slug"] == "test-post"
        assert "content" in payload
        assert "timestamp" in payload

    # Check post status updated
    await session.refresh(post)
    assert post.nextjs_publish_status == "published"
    assert post.nextjs_published_at is not None


@pytest.mark.asyncio
async def test_publish_to_nextjs_handles_failure(session: AsyncSession):
    """Test that failed webhook delivery sets status to failed."""
    secret = "test-webhook-secret"
    profile = WebsiteProfile(
        name="Test",
        website_url="https://test.com",
        nextjs_webhook_url="https://test.com/api/jena-webhook",
        nextjs_webhook_secret=encrypt(secret),
        nextjs_frontmatter_map={"title": "title"},
    )
    session.add(profile)
    await session.flush()

    post = Post(
        slug="fail-post",
        topic="Fail Test",
        profile_id=profile.id,
        output_format="nextjs",
        ready_content='---\ntitle: "Fail"\n---\n\nContent.',
        image_manifest={"images": []},
    )
    session.add(post)
    await session.commit()

    mock_response = AsyncMock()
    mock_response.status_code = 500
    mock_response.text = "Internal Server Error"

    with patch("src.services.nextjs_publish.httpx.AsyncClient") as MockClient:
        mock_client = AsyncMock()
        mock_client.post.return_value = mock_response
        mock_client.__aenter__ = AsyncMock(return_value=mock_client)
        mock_client.__aexit__ = AsyncMock(return_value=False)
        MockClient.return_value = mock_client

        mock_redis = AsyncMock()
        mock_session_factory = MagicMock()
        mock_session_factory.return_value.__aenter__ = AsyncMock(return_value=session)
        mock_session_factory.return_value.__aexit__ = AsyncMock(return_value=False)

        ctx = {"session_factory": mock_session_factory, "redis": mock_redis}

        from src.services.nextjs_publish import publish_to_nextjs

        await publish_to_nextjs(ctx, str(post.id))

    await session.refresh(post)
    assert post.nextjs_publish_status == "failed"
```

- [ ] **Step 2: Run test to verify it fails**

```bash
cd api && pytest tests/phase_nextjs/test_nextjs_publish.py -v
```
Expected: FAIL — module not found

- [ ] **Step 3: Write the publish service**

Create `api/src/services/nextjs_publish.py`:

```python
from __future__ import annotations

import json
import logging
import uuid
from datetime import UTC, datetime

import httpx

from src.models.post import Post
from src.models.profile import WebsiteProfile
from src.services.crypto import decrypt
from src.services.frontmatter_mapping import apply_frontmatter_mapping
from src.services.hmac_signing import sign_payload

logger = logging.getLogger(__name__)


async def publish_to_nextjs(ctx: dict, post_id: str) -> None:
    """Publish a completed post to a Next.js blog via webhook.

    This is an ARQ job function registered on the worker.
    """
    session_factory = ctx["session_factory"]
    redis = ctx["redis"]

    async with session_factory() as session:
        post = await session.get(Post, uuid.UUID(post_id))
        if not post:
            logger.error("Post %s not found for Next.js publish", post_id)
            return

        profile = (
            await session.get(WebsiteProfile, post.profile_id)
            if post.profile_id
            else None
        )
        if not profile:
            await _fail(session, redis, post, "No profile linked to post")
            return

        if not profile.nextjs_webhook_url or not profile.nextjs_webhook_secret:
            await _fail(session, redis, post, "Next.js webhook not configured")
            return

        try:
            secret = decrypt(profile.nextjs_webhook_secret)
        except Exception:
            await _fail(session, redis, post, "Failed to decrypt webhook secret")
            return

        # Mark as publishing
        post.nextjs_publish_status = "publishing"
        await session.commit()

        # Build payload
        content = post.ready_content or post.final_md_content or ""
        manifest = post.image_manifest or {"images": []}

        # Apply frontmatter mapping if configured
        if profile.nextjs_frontmatter_map:
            content = _apply_mapping_to_content(
                content, profile.nextjs_frontmatter_map
            )

        # Build image list with CDN URLs
        images = []
        for img in manifest.get("images", []):
            if not img.get("url"):
                continue
            images.append(
                {
                    "filename": img.get("filename", ""),
                    "url": img["url"],
                    "download_url": img["url"],  # Same URL for now; signed URLs come with R2
                    "alt": img.get("alt_text", ""),
                    "placement": img.get("placement", "inline"),
                }
            )

        payload = json.dumps(
            {
                "event": "post.published",
                "post_id": str(post.id),
                "delivery_id": str(uuid.uuid4()),
                "slug": post.slug,
                "content": content,
                "images": images,
                "timestamp": datetime.now(UTC).isoformat(),
            }
        )

        signature = sign_payload(payload, secret)

        # Send webhook
        try:
            async with httpx.AsyncClient(timeout=30.0) as client:
                response = await client.post(
                    profile.nextjs_webhook_url,
                    content=payload,
                    headers={
                        "Content-Type": "application/json",
                        "X-Jena-Signature": signature,
                    },
                )

            if response.status_code == 200:
                post.nextjs_publish_status = "published"
                post.nextjs_published_at = datetime.now(UTC)
                await session.commit()
                logger.info(
                    "Published post %s to Next.js at %s",
                    post_id,
                    profile.nextjs_webhook_url,
                )
            else:
                await _fail(
                    session,
                    redis,
                    post,
                    f"Webhook returned {response.status_code}: {response.text[:200]}",
                )
        except httpx.RequestError as exc:
            await _fail(session, redis, post, f"Webhook request failed: {exc}")


def _apply_mapping_to_content(
    content: str, mapping: dict
) -> str:
    """Apply frontmatter mapping to the markdown content's YAML frontmatter."""
    import yaml

    if not content.startswith("---"):
        return content

    parts = content.split("---", 2)
    if len(parts) < 3:
        return content

    frontmatter = yaml.safe_load(parts[1]) or {}
    mapped = apply_frontmatter_mapping(frontmatter, mapping)

    new_frontmatter = yaml.dump(mapped, default_flow_style=False, allow_unicode=True)
    return f"---\n{new_frontmatter}---{parts[2]}"


async def _fail(session, redis, post: Post, message: str) -> None:
    """Mark post as failed and log the error."""
    logger.error("Next.js publish failed for post %s: %s", post.id, message)
    post.nextjs_publish_status = "failed"
    await session.commit()
```

- [ ] **Step 4: Run test to verify it passes**

```bash
cd api && pytest tests/phase_nextjs/test_nextjs_publish.py -v
```
Expected: PASS (2 tests)

- [ ] **Step 5: Commit**

```bash
git add api/src/services/nextjs_publish.py api/tests/phase_nextjs/test_nextjs_publish.py
git commit -m "feat: Next.js publish service with HMAC-signed webhook delivery"
```

---

### Task 7: API Endpoints

**Files:**
- Create: `api/src/api/nextjs.py`
- Test: `api/tests/phase_nextjs/test_nextjs_api.py`

- [ ] **Step 1: Write the failing test**

Create `api/tests/phase_nextjs/test_nextjs_api.py`:

```python
from __future__ import annotations

import pytest
from httpx import AsyncClient

from src.models.profile import WebsiteProfile
from src.services.crypto import encrypt


@pytest.mark.asyncio
async def test_test_nextjs_connection(client: AsyncClient, session):
    """Test the /nextjs/test endpoint."""
    profile = WebsiteProfile(
        name="Test",
        website_url="https://test.com",
        nextjs_webhook_url="https://httpbin.org/post",
        nextjs_webhook_secret=encrypt("test-secret"),
    )
    session.add(profile)
    await session.commit()

    response = await client.post(f"/api/profiles/{profile.id}/nextjs/test")
    assert response.status_code == 200
    data = response.json()
    assert "connected" in data


@pytest.mark.asyncio
async def test_test_nextjs_connection_no_config(client: AsyncClient, session):
    """Test returns error when webhook not configured."""
    profile = WebsiteProfile(
        name="Test",
        website_url="https://test.com",
    )
    session.add(profile)
    await session.commit()

    response = await client.post(f"/api/profiles/{profile.id}/nextjs/test")
    assert response.status_code == 200
    data = response.json()
    assert data["connected"] is False
    assert "error" in data
```

- [ ] **Step 2: Run test to verify it fails**

```bash
cd api && pytest tests/phase_nextjs/test_nextjs_api.py -v
```
Expected: FAIL — endpoint not found

- [ ] **Step 3: Write API endpoints**

Create `api/src/api/nextjs.py`:

```python
from __future__ import annotations

import json
import logging
import uuid
from datetime import UTC, datetime

from fastapi import APIRouter, Depends, HTTPException
from sqlalchemy.ext.asyncio import AsyncSession

from src.api.auth import get_current_user
from src.database import get_session
from src.models.auth import AuthUser
from src.models.post import Post
from src.models.profile import WebsiteProfile
from src.services.crypto import decrypt
from src.services.hmac_signing import sign_payload

logger = logging.getLogger(__name__)

router = APIRouter(prefix="/api/profiles", tags=["nextjs"])


async def _get_user_profile(
    profile_id: uuid.UUID,
    user: AuthUser,
    session: AsyncSession,
) -> WebsiteProfile:
    profile = await session.get(WebsiteProfile, profile_id)
    if not profile or profile.user_id != user.id:
        raise HTTPException(status_code=404, detail="Profile not found")
    return profile


@router.post("/{profile_id}/nextjs/test")
async def test_nextjs_connection(
    profile_id: uuid.UUID,
    user: AuthUser = Depends(get_current_user),
    session: AsyncSession = Depends(get_session),
):
    """Send a test webhook to verify the Next.js connection."""
    profile = await _get_user_profile(profile_id, user, session)

    if not profile.nextjs_webhook_url or not profile.nextjs_webhook_secret:
        return {"connected": False, "error": "Webhook URL or secret not configured"}

    try:
        secret = decrypt(profile.nextjs_webhook_secret)
    except Exception:
        return {"connected": False, "error": "Failed to decrypt webhook secret"}

    import httpx

    payload = json.dumps(
        {
            "event": "test",
            "timestamp": datetime.now(UTC).isoformat(),
        }
    )
    signature = sign_payload(payload, secret)

    try:
        async with httpx.AsyncClient(timeout=10.0) as client:
            response = await client.post(
                profile.nextjs_webhook_url,
                content=payload,
                headers={
                    "Content-Type": "application/json",
                    "X-Jena-Signature": signature,
                },
            )
        if response.status_code == 200:
            return {"connected": True}
        return {
            "connected": False,
            "error": f"Webhook returned {response.status_code}",
        }
    except httpx.RequestError as exc:
        return {"connected": False, "error": str(exc)}
```

- [ ] **Step 4: Register router in main.py**

In `api/src/main.py`, add import and registration:

Add to imports (after `wordpress_router`):
```python
from src.api.nextjs import router as nextjs_router
```

Add to router registration (after `app.include_router(wordpress_router)`):
```python
app.include_router(nextjs_router)
```

- [ ] **Step 5: Run test to verify it passes**

```bash
cd api && pytest tests/phase_nextjs/test_nextjs_api.py -v
```
Expected: PASS (2 tests)

- [ ] **Step 6: Commit**

```bash
git add api/src/api/nextjs.py api/src/main.py api/tests/phase_nextjs/test_nextjs_api.py
git commit -m "feat: Next.js test connection and publish API endpoints"
```

---

### Task 8: Worker Auto-Publish Trigger

**Files:**
- Modify: `api/src/worker.py` (in `_post_completion_hook`)

- [ ] **Step 1: Write the failing test**

Create `api/tests/phase_nextjs/test_worker_trigger.py`:

```python
from __future__ import annotations

from unittest.mock import AsyncMock, patch

import pytest
from sqlalchemy.ext.asyncio import AsyncSession

from src.models.post import Post
from src.models.profile import WebsiteProfile
from src.services.crypto import encrypt


@pytest.mark.asyncio
async def test_auto_publishes_nextjs_on_completion(session: AsyncSession):
    """When a post completes with output_format='nextjs' and profile has webhook configured,
    the worker should set nextjs_publish_status to 'pending'."""
    profile = WebsiteProfile(
        name="Test",
        website_url="https://test.com",
        nextjs_webhook_url="https://test.com/api/jena-webhook",
        nextjs_webhook_secret=encrypt("secret"),
    )
    session.add(profile)
    await session.flush()

    post = Post(
        slug="auto-publish-test",
        topic="Auto Publish",
        profile_id=profile.id,
        output_format="nextjs",
    )
    session.add(post)
    await session.commit()

    # The post completion hook should detect nextjs output_format
    # and set pending status
    assert post.output_format == "nextjs"
    assert profile.nextjs_webhook_url is not None
    assert profile.nextjs_webhook_secret is not None
```

- [ ] **Step 2: Add Next.js auto-publish trigger to worker**

In `api/src/worker.py`, in the `_post_completion_hook` function, after the WordPress auto-publish block (around line 445), add:

```python
    # Auto-publish to Next.js if configured
    if post.output_format == "nextjs" and post.profile_id:
        profile = await session.get(WebsiteProfile, post.profile_id)
        nextjs_configured = (
            profile
            and profile.nextjs_webhook_url
            and profile.nextjs_webhook_secret
        )
        if nextjs_configured:
            post.nextjs_publish_status = "pending"
            await session.commit()
```

Also add the job enqueue in the caller (`_run_pipeline`), mirroring the WordPress pattern. After the `should_publish_wp` enqueue block, add:

```python
            if post.nextjs_publish_status == "pending":
                await redis.enqueue_job("publish_to_nextjs", post_id)
```

Register the job in the worker's `functions` list (where `publish_to_wordpress` is registered):

```python
from src.services.nextjs_publish import publish_to_nextjs
```

And add `publish_to_nextjs` to the ARQ `functions` list.

- [ ] **Step 3: Run test to verify it passes**

```bash
cd api && pytest tests/phase_nextjs/test_worker_trigger.py -v
```
Expected: PASS

- [ ] **Step 4: Commit**

```bash
git add api/src/worker.py api/tests/phase_nextjs/test_worker_trigger.py
git commit -m "feat: auto-publish to Next.js on pipeline completion"
```

---

### Task 9: Profile Credential Encryption

**Files:**
- Modify: `api/src/api/profiles.py`

- [ ] **Step 1: Write failing test**

Create `api/tests/phase_nextjs/test_profile_encryption.py`:

```python
from __future__ import annotations

import pytest
from httpx import AsyncClient

from src.models.profile import WebsiteProfile
from src.services.crypto import decrypt


@pytest.mark.asyncio
async def test_nextjs_webhook_secret_encrypted_on_create(
    client: AsyncClient, session
):
    """Webhook secret should be encrypted when profile is created."""
    response = await client.post(
        "/api/profiles",
        json={
            "name": "Encrypt Test",
            "website_url": "https://test.com",
            "nextjs_webhook_url": "https://test.com/api/jena-webhook",
            "nextjs_webhook_secret": "plaintext-secret",
        },
    )
    assert response.status_code == 200
    profile_id = response.json()["id"]

    # Read directly from DB — should be encrypted, not plaintext
    profile = await session.get(WebsiteProfile, profile_id)
    assert profile.nextjs_webhook_secret != "plaintext-secret"
    # But should decrypt back to the original
    assert decrypt(profile.nextjs_webhook_secret) == "plaintext-secret"


@pytest.mark.asyncio
async def test_nextjs_webhook_secret_encrypted_on_update(
    client: AsyncClient, session
):
    """Webhook secret should be encrypted when profile is updated."""
    profile = WebsiteProfile(name="Update Test", website_url="https://test.com")
    session.add(profile)
    await session.commit()

    response = await client.patch(
        f"/api/profiles/{profile.id}",
        json={"nextjs_webhook_secret": "new-secret"},
    )
    assert response.status_code == 200

    await session.refresh(profile)
    assert profile.nextjs_webhook_secret != "new-secret"
    assert decrypt(profile.nextjs_webhook_secret) == "new-secret"
```

- [ ] **Step 2: Run test to verify it fails**

```bash
cd api && pytest tests/phase_nextjs/test_profile_encryption.py -v
```
Expected: FAIL — secret stored as plaintext

- [ ] **Step 3: Add encryption to profiles.py**

In `api/src/api/profiles.py`, in `create_profile` (after the `wp_app_password` encryption block, around line 57), add:

```python
    if dump.get("nextjs_webhook_secret"):
        from src.services.crypto import encrypt

        dump["nextjs_webhook_secret"] = encrypt(dump["nextjs_webhook_secret"])
```

In `update_profile` (after the `wp_app_password` encryption block, around line 97), add:

```python
    if "nextjs_webhook_secret" in updates and updates["nextjs_webhook_secret"]:
        from src.services.crypto import encrypt

        updates["nextjs_webhook_secret"] = encrypt(updates["nextjs_webhook_secret"])
```

- [ ] **Step 4: Run test to verify it passes**

```bash
cd api && pytest tests/phase_nextjs/test_profile_encryption.py -v
```
Expected: PASS (2 tests)

- [ ] **Step 5: Commit**

```bash
git add api/src/api/profiles.py api/tests/phase_nextjs/test_profile_encryption.py
git commit -m "feat: encrypt nextjs_webhook_secret on profile create/update"
```

---

### Task 10: Dashboard — Profile Next.js Config Section

**Files:**
- Modify: `web/src/app/profiles/[id]/page.tsx`
- Modify: `web/src/lib/api.ts`

- [ ] **Step 1: Add Next.js API methods to api.ts**

In `web/src/lib/api.ts`, add to the profiles namespace (or create a `nextjs` namespace):

```typescript
  nextjs: {
    async testConnection(profileId: string) {
      const res = await fetch(`${API}/profiles/${profileId}/nextjs/test`, {
        method: "POST",
        credentials: "include",
      });
      return res.json() as Promise<{ connected: boolean; error?: string }>;
    },
  },
```

- [ ] **Step 2: Add Next.js config section to profile edit page**

In `web/src/app/profiles/[id]/page.tsx`, add a new section in the form when `output_format === "nextjs"`. This section should include:

- Text input for `nextjs_webhook_url` (labeled "Webhook URL")
- Password input for `nextjs_webhook_secret` (labeled "Webhook Secret")
- JSON editor or textarea for `nextjs_frontmatter_map` (labeled "Frontmatter Mapping")
- "Test Connection" button that calls `api.nextjs.testConnection(profileId)` and shows success/error

The exact React code depends on the existing form structure in the file. Read the current file and follow its patterns for form fields, state management, and save logic.

- [ ] **Step 3: Test in browser**

1. Start dev servers: `docker-compose up db redis` then `cd api && uv run uvicorn src.main:app --reload` and `cd web && pnpm dev`
2. Navigate to a profile page
3. Change output format to "nextjs"
4. Verify the Next.js config section appears
5. Enter a webhook URL and test connection

- [ ] **Step 4: Commit**

```bash
git add web/src/app/profiles/[id]/page.tsx web/src/lib/api.ts
git commit -m "feat: dashboard UI for Next.js webhook configuration on profile page"
```

---

### Task 11: Dashboard — Post Publish Status

**Files:**
- Modify: `web/src/app/posts/[id]/page.tsx` (or wherever post detail lives)

- [ ] **Step 1: Add Next.js publish status to post detail**

In the post detail page, add a status badge that shows when `post.nextjs_publish_status` is present:

- `pending` — yellow badge
- `publishing` — blue badge with spinner
- `published` — green badge with timestamp (`nextjs_published_at`)
- `failed` — red badge with retry button

The retry button should call `POST /api/posts/{id}/publish/nextjs` (add this endpoint to `api/src/api/nextjs.py` if not already present).

Follow the existing pattern for `wp_publish_status` display in the same page.

- [ ] **Step 2: Test in browser**

Verify the status badge appears on a post with `output_format === "nextjs"`.

- [ ] **Step 3: Commit**

```bash
git add web/src/app/posts/
git commit -m "feat: Next.js publish status badge and retry button on post detail page"
```

---

### Task 12: Run Full Test Suite

- [ ] **Step 1: Run all backend tests**

```bash
cd api && pytest -v
```
Expected: ALL PASS (existing + new nextjs tests)

- [ ] **Step 2: Run all frontend tests**

```bash
cd web && pnpm test
```
Expected: ALL PASS

- [ ] **Step 3: Final commit if any fixes needed**

```bash
git add -A && git status
```
Only commit if there are changes from test fixes.
