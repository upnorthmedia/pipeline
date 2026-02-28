"""Remove thread_id column from posts (LangGraph checkpointing no longer needed).

Revision ID: 005
Revises: 004
"""

import sqlalchemy as sa
from alembic import op

revision = "005"
down_revision = "004"


def upgrade() -> None:
    op.drop_column("posts", "thread_id")


def downgrade() -> None:
    op.add_column(
        "posts",
        sa.Column("thread_id", sa.String(255), nullable=True),
    )
