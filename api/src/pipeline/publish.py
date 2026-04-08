"""Post-pipeline WordPress publishing hook."""

from __future__ import annotations

import logging
import mimetypes
import re
import uuid
from pathlib import Path

from sqlalchemy.ext.asyncio import AsyncSession

from src.api.events import publish_event
from src.config import settings
from src.models.post import Post
from src.models.profile import WebsiteProfile
from src.pipeline.helpers import append_execution_log
from src.services.crypto import decrypt
from src.services.wordpress import WordPressClient, WordPressError
from src.services.wp_html import markdown_to_wp_html

logger = logging.getLogger(__name__)


def _extract_frontmatter(content: str) -> tuple[dict[str, str], str]:
    """Extract YAML frontmatter as simple key-value pairs. Returns (meta, body)."""
    match = re.match(r"^---\s*\n(.*?)\n---\s*\n(.*)$", content, re.DOTALL)
    if not match:
        return {}, content
    meta: dict[str, str] = {}
    for line in match.group(1).split("\n"):
        if ":" in line:
            key, _, val = line.partition(":")
            meta[key.strip()] = val.strip().strip('"').strip("'")
    return meta, match.group(2)


def _find_image_refs(html: str) -> list[str]:
    """Find all image src references in HTML content."""
    return re.findall(r'<img[^>]+src="([^"]+)"', html)


async def publish_to_wordpress(ctx, post_id: str) -> None:
    """Publish a completed post to WordPress.

    This is an ARQ job function registered on the worker.
    """
    session_factory = ctx["session_factory"]
    redis = ctx["redis"]

    async with session_factory() as session:
        post = await session.get(Post, uuid.UUID(post_id))
        if not post:
            logger.error(f"Post {post_id} not found for WP publish")
            return

        profile = (
            await session.get(WebsiteProfile, post.profile_id)
            if post.profile_id
            else None
        )
        if not profile:
            await _fail(session, redis, post, "No profile linked to post")
            return

        if not profile.wp_url or not profile.wp_username or not profile.wp_app_password:
            await _fail(session, redis, post, "WordPress credentials not configured")
            return

        try:
            password = decrypt(profile.wp_app_password)
        except Exception:
            await _fail(session, redis, post, "Failed to decrypt WP app password")
            return

        # Mark as publishing
        post.wp_publish_status = "publishing"
        await session.commit()
        await publish_event(
            redis, post_id, "publish_start", {"message": "Publishing to WordPress..."}
        )

        try:
            async with WordPressClient(
                profile.wp_url, profile.wp_username, password
            ) as client:
                content = post.ready_content or post.final_md_content or ""
                frontmatter, body = _extract_frontmatter(content)

                title = frontmatter.get("title", post.topic)
                description = frontmatter.get("description", "")

                # Convert markdown to Gutenberg HTML
                wp_html = markdown_to_wp_html(content)

                # Upload images from media directory
                media_dir = Path(settings.media_dir) / post_id
                image_map: dict[str, str] = {}
                featured_media_id: int | None = None

                # Build a lookup from filename to manifest entry for alt text & featured
                manifest = post.image_manifest or {}
                manifest_images = manifest.get("images", [])
                manifest_by_file: dict[str, dict] = {}
                featured_filename: str | None = None
                for img_info in manifest_images:
                    url = img_info.get("url", "")
                    fname = url.rsplit("/", 1)[-1] if "/" in url else url
                    manifest_by_file[fname] = img_info
                    is_feat = (
                        img_info.get("placement") == "featured"
                        or img_info.get("type") == "featured"
                    )
                    if is_feat:
                        featured_filename = fname

                if media_dir.is_dir():
                    for img_file in sorted(media_dir.iterdir()):
                        if not img_file.is_file():
                            continue
                        mime, _ = mimetypes.guess_type(img_file.name)
                        if not mime or not mime.startswith("image/"):
                            continue

                        img_info = manifest_by_file.get(img_file.name, {})
                        alt = img_info.get("alt_text", title)

                        img_bytes = img_file.read_bytes()
                        media = await client.upload_media(
                            img_bytes, img_file.name, mime, alt_text=alt
                        )
                        wp_media_url = media.get("source_url", "")
                        local_url = f"/media/{post_id}/{img_file.name}"
                        image_map[local_url] = wp_media_url

                        # Use manifest-identified featured image, or fall back to first
                        if featured_filename and img_file.name == featured_filename:
                            featured_media_id = media.get("id")
                        elif featured_media_id is None and not featured_filename:
                            featured_media_id = media.get("id")

                # Replace local image URLs with WP URLs
                for local, remote in image_map.items():
                    wp_html = wp_html.replace(local, remote)

                # Build categories list
                categories = [post.wp_category_id] if post.wp_category_id else None
                author = post.wp_author_id
                status = profile.wp_default_status or "publish"

                if post.wp_post_id:
                    # Update existing WP post
                    wp_post = await client.update_post(
                        post.wp_post_id,
                        title=title,
                        content=wp_html,
                        status=status,
                        categories=categories or [],
                        author=author,
                        featured_media=featured_media_id,
                        excerpt=description,
                    )
                else:
                    # Create new WP post
                    wp_post = await client.create_post(
                        title=title,
                        content=wp_html,
                        status=status,
                        categories=categories,
                        author=author,
                        featured_media=featured_media_id,
                        excerpt=description,
                    )

                post.wp_post_id = wp_post.get("id")
                post.wp_post_url = wp_post.get("link", "")
                post.wp_publish_status = "published"
                await session.commit()

                await append_execution_log(
                    session,
                    post_id,
                    "",
                    "info",
                    "publish_complete",
                    f"Published to WordPress: {post.wp_post_url}",
                )
                await publish_event(
                    redis,
                    post_id,
                    "publish_complete",
                    {"wp_post_url": post.wp_post_url, "wp_post_id": post.wp_post_id},
                )
                logger.info(
                    f"Post {post_id} published to WordPress: {post.wp_post_url}"
                )

        except WordPressError as e:
            await _fail(session, redis, post, str(e))
        except Exception as e:
            logger.exception(f"WP publish failed for post {post_id}")
            await _fail(session, redis, post, str(e))


async def _fail(session: AsyncSession, redis, post: Post, error: str) -> None:
    """Mark publish as failed and notify."""
    post.wp_publish_status = "failed"
    await session.commit()

    post_id = str(post.id)
    await append_execution_log(
        session,
        post_id,
        "",
        "error",
        "publish_error",
        f"WordPress publish failed: {error}",
    )
    await publish_event(
        redis,
        post_id,
        "publish_error",
        {"error": error, "message": f"Publish failed: {error}"},
    )
    logger.error(f"WP publish failed for post {post_id}: {error}")
