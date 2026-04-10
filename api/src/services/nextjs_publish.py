from __future__ import annotations

import base64
import json
import logging
import uuid
from datetime import UTC, datetime
from pathlib import Path

import httpx

from src.api.events import publish_event
from src.config import settings
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
            await _fail(session, redis, post, "No profile linked to this post. Assign a profile first.")
            return

        if not profile.nextjs_webhook_url or not profile.nextjs_webhook_secret:
            await _fail(
                session, redis, post,
                "Next.js webhook not configured. Go to Profiles, select this post's profile, and add a Webhook URL and Secret in the Next.js Integration section.",
            )
            return

        try:
            secret = decrypt(profile.nextjs_webhook_secret)
        except Exception:
            await _fail(session, redis, post, "Failed to decrypt webhook secret")
            return

        # Mark as publishing
        post.nextjs_publish_status = "publishing"
        await session.commit()
        await publish_event(
            redis, str(post.id), "publish_start", {"target": "nextjs"}
        )

        # Build payload
        content = post.ready_content or post.final_md_content or ""
        manifest = post.image_manifest or {"images": []}

        # Apply frontmatter mapping if configured
        if profile.nextjs_frontmatter_map:
            content = _apply_mapping_to_content(
                content, profile.nextjs_frontmatter_map
            )

        # Read image files and encode as base64
        # Images stay at /media/{post_id}/filename.webp — committed to public/media/ in the repo
        images = []
        media_dir = Path(settings.media_dir) / post_id

        for img in manifest.get("images", []):
            url = img.get("url", "")
            if not url:
                continue

            # Derive actual filename from URL (e.g., /media/{id}/featured.webp -> featured.webp)
            actual_filename = url.rsplit("/", 1)[-1] if "/" in url else ""
            if not actual_filename:
                continue

            img_path = media_dir / actual_filename
            img_data = None

            if img_path.is_file():
                img_data = base64.b64encode(img_path.read_bytes()).decode()
            else:
                logger.warning("Image file not found: %s", img_path)

            images.append(
                {
                    "filename": actual_filename,
                    "public_path": url,
                    "alt": img.get("alt_text", ""),
                    "placement": img.get("placement", "inline"),
                    "data": img_data,
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
            async with httpx.AsyncClient(timeout=60.0) as client:
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
                await publish_event(
                    redis, post_id, "publish_complete", {"target": "nextjs"}
                )
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


def _apply_mapping_to_content(content: str, mapping: dict) -> str:
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
    """Mark post as failed, send SSE event, and log the error."""
    logger.error("Next.js publish failed for post %s: %s", post.id, message)
    post.nextjs_publish_status = "failed"
    await session.commit()

    post_id = str(post.id)
    await publish_event(
        redis,
        post_id,
        "publish_error",
        {"error": message, "target": "nextjs"},
    )
