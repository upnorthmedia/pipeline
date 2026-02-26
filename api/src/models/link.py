from __future__ import annotations

import uuid
from datetime import UTC, datetime
from typing import TYPE_CHECKING

from sqlalchemy import DateTime, ForeignKey, String, Text, UniqueConstraint, func
from sqlalchemy.dialects.postgresql import JSONB, UUID
from sqlalchemy.orm import Mapped, mapped_column, relationship

from src.models.base import Base, UUIDMixin

if TYPE_CHECKING:
    from src.models.profile import WebsiteProfile


class InternalLink(UUIDMixin, Base):
    __tablename__ = "internal_links"
    __table_args__ = (
        UniqueConstraint("profile_id", "url", name="uq_internal_links_profile_url"),
    )

    profile_id: Mapped[uuid.UUID] = mapped_column(
        UUID(as_uuid=True),
        ForeignKey("website_profiles.id", ondelete="CASCADE"),
        nullable=False,
        index=True,
    )
    url: Mapped[str] = mapped_column(Text, nullable=False)
    title: Mapped[str | None] = mapped_column(Text)
    slug: Mapped[str | None] = mapped_column(String(255))
    source: Mapped[str] = mapped_column(
        String(20), server_default="sitemap", default="sitemap"
    )
    post_id: Mapped[uuid.UUID | None] = mapped_column(
        UUID(as_uuid=True),
        ForeignKey("posts.id"),
    )
    keywords: Mapped[dict] = mapped_column(JSONB, server_default="[]", default=list)
    created_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True),
        server_default=func.now(),
        default=lambda: datetime.now(UTC),
    )

    # Relationships
    profile: Mapped[WebsiteProfile] = relationship(
        "WebsiteProfile", back_populates="links"
    )
