"""Add article_type and additional_info columns to posts.

Revision ID: 009
Revises: 008
"""

import sqlalchemy as sa
from alembic import op

revision = "009"
down_revision = "008"


def upgrade() -> None:
    op.add_column("posts", sa.Column("article_type", sa.Text(), nullable=True))
    op.add_column("posts", sa.Column("additional_info", sa.Text(), nullable=True))


def downgrade() -> None:
    op.drop_column("posts", "additional_info")
    op.drop_column("posts", "article_type")
