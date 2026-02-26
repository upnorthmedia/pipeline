from __future__ import annotations

from datetime import datetime
from typing import TYPE_CHECKING

import sqlalchemy as sa
from sqlalchemy import DateTime, Integer, String, Text
from sqlalchemy.dialects.postgresql import JSONB
from sqlalchemy.orm import Mapped, mapped_column, relationship

from src.models.base import Base, TimestampMixin, UUIDMixin

if TYPE_CHECKING:
    from src.models.link import InternalLink
    from src.models.post import Post


class WebsiteProfile(UUIDMixin, TimestampMixin, Base):
    __tablename__ = "website_profiles"

    name: Mapped[str] = mapped_column(String(255), nullable=False)
    website_url: Mapped[str] = mapped_column(Text, nullable=False)
    sitemap_urls: Mapped[dict] = mapped_column(JSONB, server_default="[]", default=list)

    # Defaults that prefill new posts
    niche: Mapped[str | None] = mapped_column(Text)
    target_audience: Mapped[str | None] = mapped_column(Text)
    tone: Mapped[str] = mapped_column(
        Text,
        server_default="Conversational and friendly",
        default="Conversational and friendly",
    )
    brand_voice: Mapped[str | None] = mapped_column(Text)
    word_count: Mapped[int] = mapped_column(
        Integer, server_default="2000", default=2000
    )
    output_format: Mapped[str] = mapped_column(
        String(20), server_default="both", default="both"
    )
    image_style: Mapped[str | None] = mapped_column(Text)
    image_brand_colors: Mapped[dict] = mapped_column(
        JSONB, server_default="[]", default=list
    )
    image_exclude: Mapped[dict] = mapped_column(
        JSONB, server_default="[]", default=list
    )
    avoid: Mapped[str | None] = mapped_column(Text)
    required_mentions: Mapped[str | None] = mapped_column(Text)
    related_keywords: Mapped[dict] = mapped_column(
        JSONB, server_default="[]", default=list
    )

    # Pipeline defaults
    default_stage_settings: Mapped[dict] = mapped_column(
        JSONB,
        server_default='{"research":"review","outline":"review","write":"review","edit":"review","images":"review"}',
        default=lambda: {
            "research": "review",
            "outline": "review",
            "write": "review",
            "edit": "review",
            "images": "review",
        },
    )

    # Sitemap crawl status
    last_crawled_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True))
    crawl_status: Mapped[str] = mapped_column(
        String(20), server_default="pending", default="pending"
    )
    recrawl_interval: Mapped[str | None] = mapped_column(
        String(20), server_default=sa.null(), default=None
    )  # "weekly" | "monthly" | None (disabled)

    # Relationships
    links: Mapped[list[InternalLink]] = relationship(
        "InternalLink", back_populates="profile", cascade="all, delete-orphan"
    )
    posts: Mapped[list[Post]] = relationship("Post", back_populates="profile")
