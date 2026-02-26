"""initial schema

Revision ID: 001
Revises:
Create Date: 2026-02-26

"""

from collections.abc import Sequence

import sqlalchemy as sa
from alembic import op
from sqlalchemy.dialects import postgresql

revision: str = "001"
down_revision: str | None = None
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None


def upgrade() -> None:
    # Website profiles
    op.create_table(
        "website_profiles",
        sa.Column(
            "id",
            postgresql.UUID(as_uuid=True),
            primary_key=True,
            server_default=sa.text("gen_random_uuid()"),
        ),
        sa.Column("name", sa.String(255), nullable=False),
        sa.Column("website_url", sa.Text, nullable=False),
        sa.Column("sitemap_urls", postgresql.JSONB, server_default="[]"),
        sa.Column("niche", sa.Text),
        sa.Column("target_audience", sa.Text),
        sa.Column("tone", sa.Text, server_default="Conversational and friendly"),
        sa.Column("brand_voice", sa.Text),
        sa.Column("word_count", sa.Integer, server_default="2000"),
        sa.Column("output_format", sa.String(20), server_default="both"),
        sa.Column("image_style", sa.Text),
        sa.Column("image_brand_colors", postgresql.JSONB, server_default="[]"),
        sa.Column("image_exclude", postgresql.JSONB, server_default="[]"),
        sa.Column("avoid", sa.Text),
        sa.Column("required_mentions", sa.Text),
        sa.Column("related_keywords", postgresql.JSONB, server_default="[]"),
        sa.Column(
            "default_stage_settings",
            postgresql.JSONB,
            server_default='{"research":"review","outline":"review","write":"review","edit":"review","images":"review"}',
        ),
        sa.Column("last_crawled_at", sa.DateTime(timezone=True)),
        sa.Column("crawl_status", sa.String(20), server_default="pending"),
        sa.Column(
            "created_at", sa.DateTime(timezone=True), server_default=sa.func.now()
        ),
        sa.Column(
            "updated_at", sa.DateTime(timezone=True), server_default=sa.func.now()
        ),
    )

    # Posts
    op.create_table(
        "posts",
        sa.Column(
            "id",
            postgresql.UUID(as_uuid=True),
            primary_key=True,
            server_default=sa.text("gen_random_uuid()"),
        ),
        sa.Column(
            "profile_id",
            postgresql.UUID(as_uuid=True),
            sa.ForeignKey("website_profiles.id"),
        ),
        sa.Column("slug", sa.String(255), nullable=False),
        sa.Column("topic", sa.Text, nullable=False),
        sa.Column("target_audience", sa.Text),
        sa.Column("niche", sa.Text),
        sa.Column("intent", sa.Text),
        sa.Column("word_count", sa.Integer, server_default="2000"),
        sa.Column("tone", sa.Text, server_default="Conversational and friendly"),
        sa.Column("output_format", sa.String(20), server_default="both"),
        sa.Column("website_url", sa.Text),
        sa.Column("related_keywords", postgresql.JSONB, server_default="[]"),
        sa.Column("competitor_urls", postgresql.JSONB, server_default="[]"),
        sa.Column("image_style", sa.Text),
        sa.Column("image_brand_colors", postgresql.JSONB, server_default="[]"),
        sa.Column("image_exclude", postgresql.JSONB, server_default="[]"),
        sa.Column("brand_voice", sa.Text),
        sa.Column("avoid", sa.Text),
        sa.Column("required_mentions", sa.Text),
        # Stage content
        sa.Column("research_content", sa.Text),
        sa.Column("outline_content", sa.Text),
        sa.Column("draft_content", sa.Text),
        sa.Column("final_md_content", sa.Text),
        sa.Column("final_html_content", sa.Text),
        sa.Column("image_manifest", postgresql.JSONB),
        # Execution logs
        sa.Column("stage_logs", postgresql.JSONB, server_default="{}"),
        # Pipeline state
        sa.Column("current_stage", sa.String(20), server_default="pending"),
        sa.Column(
            "stage_settings",
            postgresql.JSONB,
            server_default='{"research":"review","outline":"review","write":"review","edit":"review","images":"review"}',
        ),
        sa.Column("stage_status", postgresql.JSONB, server_default="{}"),
        sa.Column("thread_id", sa.String(255)),
        sa.Column("priority", sa.Integer, server_default="0"),
        # Timestamps
        sa.Column(
            "created_at", sa.DateTime(timezone=True), server_default=sa.func.now()
        ),
        sa.Column(
            "updated_at", sa.DateTime(timezone=True), server_default=sa.func.now()
        ),
        sa.Column("completed_at", sa.DateTime(timezone=True)),
        sa.UniqueConstraint("profile_id", "slug", name="uq_posts_profile_slug"),
    )

    # Internal links
    op.create_table(
        "internal_links",
        sa.Column(
            "id",
            postgresql.UUID(as_uuid=True),
            primary_key=True,
            server_default=sa.text("gen_random_uuid()"),
        ),
        sa.Column(
            "profile_id",
            postgresql.UUID(as_uuid=True),
            sa.ForeignKey("website_profiles.id", ondelete="CASCADE"),
            nullable=False,
        ),
        sa.Column("url", sa.Text, nullable=False),
        sa.Column("title", sa.Text),
        sa.Column("slug", sa.String(255)),
        sa.Column("source", sa.String(20), server_default="sitemap"),
        sa.Column("post_id", postgresql.UUID(as_uuid=True), sa.ForeignKey("posts.id")),
        sa.Column("keywords", postgresql.JSONB, server_default="[]"),
        sa.Column(
            "created_at", sa.DateTime(timezone=True), server_default=sa.func.now()
        ),
        sa.UniqueConstraint("profile_id", "url", name="uq_internal_links_profile_url"),
    )
    op.create_index("idx_internal_links_profile", "internal_links", ["profile_id"])

    # Settings
    op.create_table(
        "settings",
        sa.Column("key", sa.String(255), primary_key=True),
        sa.Column("value", postgresql.JSONB, nullable=False),
        sa.Column(
            "updated_at", sa.DateTime(timezone=True), server_default=sa.func.now()
        ),
    )


def downgrade() -> None:
    op.drop_table("settings")
    op.drop_index("idx_internal_links_profile")
    op.drop_table("internal_links")
    op.drop_table("posts")
    op.drop_table("website_profiles")
