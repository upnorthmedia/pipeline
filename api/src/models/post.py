from __future__ import annotations

import uuid
from datetime import datetime
from typing import TYPE_CHECKING

from sqlalchemy import DateTime, ForeignKey, Integer, String, Text, UniqueConstraint
from sqlalchemy.dialects.postgresql import JSONB, UUID
from sqlalchemy.orm import Mapped, mapped_column, relationship

from src.models.base import Base, TimestampMixin, UUIDMixin

if TYPE_CHECKING:
    from src.models.profile import WebsiteProfile


class Post(UUIDMixin, TimestampMixin, Base):
    __tablename__ = "posts"
    __table_args__ = (
        UniqueConstraint("profile_id", "slug", name="uq_posts_profile_slug"),
    )

    profile_id: Mapped[uuid.UUID | None] = mapped_column(
        UUID(as_uuid=True),
        ForeignKey("website_profiles.id"),
    )
    slug: Mapped[str] = mapped_column(String(255), nullable=False)
    topic: Mapped[str] = mapped_column(Text, nullable=False)
    target_audience: Mapped[str | None] = mapped_column(Text)
    niche: Mapped[str | None] = mapped_column(Text)
    intent: Mapped[str | None] = mapped_column(Text)
    word_count: Mapped[int] = mapped_column(
        Integer, server_default="2000", default=2000
    )
    tone: Mapped[str] = mapped_column(
        Text,
        server_default="Conversational and friendly",
        default="Conversational and friendly",
    )
    output_format: Mapped[str] = mapped_column(
        String(20), server_default="both", default="both"
    )
    website_url: Mapped[str | None] = mapped_column(Text)
    related_keywords: Mapped[dict] = mapped_column(
        JSONB, server_default="[]", default=list
    )
    competitor_urls: Mapped[dict] = mapped_column(
        JSONB, server_default="[]", default=list
    )
    image_style: Mapped[str | None] = mapped_column(Text)
    image_brand_colors: Mapped[dict] = mapped_column(
        JSONB, server_default="[]", default=list
    )
    image_exclude: Mapped[dict] = mapped_column(
        JSONB, server_default="[]", default=list
    )
    brand_voice: Mapped[str | None] = mapped_column(Text)
    avoid: Mapped[str | None] = mapped_column(Text)
    required_mentions: Mapped[str | None] = mapped_column(Text)

    # Stage content
    research_content: Mapped[str | None] = mapped_column(Text)
    outline_content: Mapped[str | None] = mapped_column(Text)
    draft_content: Mapped[str | None] = mapped_column(Text)
    final_md_content: Mapped[str | None] = mapped_column(Text)
    final_html_content: Mapped[str | None] = mapped_column(Text)
    image_manifest: Mapped[dict | None] = mapped_column(JSONB)
    ready_content: Mapped[str | None] = mapped_column(Text)

    # Execution logs
    stage_logs: Mapped[dict] = mapped_column(JSONB, server_default="{}", default=dict)
    execution_logs: Mapped[list] = mapped_column(
        JSONB, server_default="[]", default=list
    )

    # Pipeline state
    current_stage: Mapped[str] = mapped_column(
        String(20), server_default="pending", default="pending"
    )
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
    stage_status: Mapped[dict] = mapped_column(JSONB, server_default="{}", default=dict)
    priority: Mapped[int] = mapped_column(Integer, server_default="0", default=0)

    # Timestamps
    completed_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True))

    # Relationships
    profile: Mapped[WebsiteProfile | None] = relationship(
        "WebsiteProfile", back_populates="posts"
    )
