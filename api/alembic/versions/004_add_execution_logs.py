"""Add execution_logs column to posts.

Revision ID: 004
Revises: 003
"""

import sqlalchemy as sa
from alembic import op
from sqlalchemy.dialects.postgresql import JSONB

revision = "004"
down_revision = "003"


def upgrade() -> None:
    op.add_column(
        "posts",
        sa.Column("execution_logs", JSONB, server_default="[]", nullable=False),
    )


def downgrade() -> None:
    op.drop_column("posts", "execution_logs")
