"""Fix InternalLink.post_id FK to SET NULL on delete.

Revision ID: 006
Revises: 005
"""

from alembic import op

revision = "006"
down_revision = "005"


def upgrade() -> None:
    op.drop_constraint(
        "internal_links_post_id_fkey", "internal_links", type_="foreignkey"
    )
    op.create_foreign_key(
        "internal_links_post_id_fkey",
        "internal_links",
        "posts",
        ["post_id"],
        ["id"],
        ondelete="SET NULL",
    )


def downgrade() -> None:
    op.drop_constraint(
        "internal_links_post_id_fkey", "internal_links", type_="foreignkey"
    )
    op.create_foreign_key(
        "internal_links_post_id_fkey",
        "internal_links",
        "posts",
        ["post_id"],
        ["id"],
    )
