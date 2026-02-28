"""Delete stale auto-generated internal links.

Revision ID: 007
Revises: 006
"""

from alembic import op

revision = "007"
down_revision = "006"


def upgrade() -> None:
    op.execute("DELETE FROM internal_links WHERE source = 'generated'")


def downgrade() -> None:
    pass  # Data migration — cannot restore
