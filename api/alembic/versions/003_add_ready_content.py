"""Add ready_content column to posts.

Revision ID: 003
Revises: 002
"""

from alembic import op
import sqlalchemy as sa

revision = "003"
down_revision = "002"


def upgrade() -> None:
    op.add_column("posts", sa.Column("ready_content", sa.Text(), nullable=True))


def downgrade() -> None:
    op.drop_column("posts", "ready_content")
