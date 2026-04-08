"""Add WordPress integration fields.

Revision ID: 008
Revises: 007
"""

import sqlalchemy as sa
from alembic import op

revision = "008"
down_revision = "007"


def upgrade() -> None:
    # Profile WP columns
    op.add_column("website_profiles", sa.Column("wp_url", sa.Text(), nullable=True))
    op.add_column(
        "website_profiles", sa.Column("wp_username", sa.Text(), nullable=True)
    )
    op.add_column(
        "website_profiles",
        sa.Column("wp_app_password", sa.Text(), nullable=True),
    )
    op.add_column(
        "website_profiles",
        sa.Column("wp_default_author_id", sa.Integer(), nullable=True),
    )
    op.add_column(
        "website_profiles",
        sa.Column("wp_default_category_id", sa.Integer(), nullable=True),
    )
    op.add_column(
        "website_profiles",
        sa.Column(
            "wp_default_status",
            sa.String(20),
            server_default="publish",
            nullable=True,
        ),
    )

    # Post WP columns
    op.add_column("posts", sa.Column("wp_category_id", sa.Integer(), nullable=True))
    op.add_column("posts", sa.Column("wp_author_id", sa.Integer(), nullable=True))
    op.add_column("posts", sa.Column("wp_post_id", sa.Integer(), nullable=True))
    op.add_column("posts", sa.Column("wp_post_url", sa.Text(), nullable=True))
    op.add_column(
        "posts",
        sa.Column("wp_publish_status", sa.String(20), nullable=True),
    )

    # Migrate "both" → "markdown"
    op.execute(
        "UPDATE website_profiles SET output_format = 'markdown'"
        " WHERE output_format = 'both'"
    )
    op.execute(
        "UPDATE posts SET output_format = 'markdown' WHERE output_format = 'both'"
    )


def downgrade() -> None:
    # Restore "both" default
    op.execute(
        "UPDATE posts SET output_format = 'both' WHERE output_format = 'markdown'"
    )
    op.execute(
        "UPDATE website_profiles SET output_format = 'both'"
        " WHERE output_format = 'markdown'"
    )

    op.drop_column("posts", "wp_publish_status")
    op.drop_column("posts", "wp_post_url")
    op.drop_column("posts", "wp_post_id")
    op.drop_column("posts", "wp_author_id")
    op.drop_column("posts", "wp_category_id")

    op.drop_column("website_profiles", "wp_default_status")
    op.drop_column("website_profiles", "wp_default_category_id")
    op.drop_column("website_profiles", "wp_default_author_id")
    op.drop_column("website_profiles", "wp_app_password")
    op.drop_column("website_profiles", "wp_username")
    op.drop_column("website_profiles", "wp_url")
