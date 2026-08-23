from datetime import UTC, datetime

from sqlalchemy import DateTime, ForeignKey, String, UniqueConstraint, func
from sqlalchemy.dialects.postgresql import JSONB
from sqlalchemy.orm import Mapped, mapped_column

from src.models.base import Base, UUIDMixin


class Setting(UUIDMixin, Base):
    __tablename__ = "settings"

    # A surrogate primary key, because `user_id` is nullable and Postgres
    # rejects NULL in a primary key. NULLS NOT DISTINCT makes a null `user_id`
    # mean exactly one global row per key (see Alembic revision 012).
    __table_args__ = (
        UniqueConstraint(
            "key",
            "user_id",
            name="uq_settings_key_user_id",
            postgresql_nulls_not_distinct=True,
        ),
    )

    key: Mapped[str] = mapped_column(String(255))
    user_id: Mapped[str | None] = mapped_column(
        String, ForeignKey("auth_users.id"), nullable=True, index=True
    )
    value: Mapped[dict] = mapped_column(JSONB, nullable=False)
    updated_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True),
        server_default=func.now(),
        default=lambda: datetime.now(UTC),
        onupdate=lambda: datetime.now(UTC),
    )
