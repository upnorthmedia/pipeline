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
