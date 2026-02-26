"""add recrawl_interval to website_profiles

Revision ID: 002
Revises: 001
Create Date: 2026-02-26

"""

from collections.abc import Sequence

import sqlalchemy as sa
from alembic import op

revision: str = "002"
down_revision: str | None = "001"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None


def upgrade() -> None:
    op.add_column(
        "website_profiles",
        sa.Column("recrawl_interval", sa.String(20), nullable=True),
    )


def downgrade() -> None:
    op.drop_column("website_profiles", "recrawl_interval")
