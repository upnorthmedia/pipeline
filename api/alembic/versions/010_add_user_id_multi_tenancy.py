"""Add user_id to website_profiles and settings for multi-tenancy.

Revision ID: 010
Revises: 009
"""

import sqlalchemy as sa
from alembic import op

revision = "010"
down_revision = "009"
branch_labels = None
depends_on = None


def upgrade() -> None:
    # Add user_id to website_profiles (nullable first for existing data)
    op.add_column(
        "website_profiles",
        sa.Column("user_id", sa.String(), nullable=True),
    )
    op.create_index("ix_website_profiles_user_id", "website_profiles", ["user_id"])

    # Add user_id to settings
    op.add_column(
        "settings",
        sa.Column("user_id", sa.String(), nullable=True),
    )
    op.create_index("ix_settings_user_id", "settings", ["user_id"])

    # Note: FK constraints referencing auth_users are NOT added here because
    # BetterAuth creates those tables separately. Add FKs manually after
    # BetterAuth tables exist, or handle at the application level.


def downgrade() -> None:
    op.drop_index("ix_settings_user_id", table_name="settings")
    op.drop_column("settings", "user_id")
    op.drop_index("ix_website_profiles_user_id", table_name="website_profiles")
    op.drop_column("website_profiles", "user_id")
