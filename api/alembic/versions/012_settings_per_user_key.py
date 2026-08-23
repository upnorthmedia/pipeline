"""Give the settings table a per-user key.

`settings.key` was the whole primary key while `user_id` was only an index, so
two users could never hold different values for the same key. Per-user
per-stage model configuration needs exactly that, so the key becomes a
surrogate `id` plus a unique constraint over `(key, user_id)`.

The constraint is `NULLS NOT DISTINCT` because `user_id` is nullable and a
global row (the encrypted `api_keys` row) has none: without it Postgres would
treat every global row as distinct and allow an unbounded set of them per key.

Revision ID: 012
Revises: 011
"""

from __future__ import annotations

import sqlalchemy as sa
from alembic import op
from sqlalchemy.dialects.postgresql import UUID

revision = "012"
down_revision = "011"
branch_labels = None
depends_on = None


def upgrade() -> None:
    op.add_column(
        "settings",
        sa.Column(
            "id",
            UUID(as_uuid=True),
            nullable=False,
            server_default=sa.text("gen_random_uuid()"),
        ),
    )
    op.drop_constraint("settings_pkey", "settings", type_="primary")
    op.create_primary_key("settings_pkey", "settings", ["id"])
    # Alembic's create_unique_constraint has no NULLS NOT DISTINCT option.
    op.execute(
        "ALTER TABLE settings ADD CONSTRAINT uq_settings_key_user_id "
        "UNIQUE NULLS NOT DISTINCT (key, user_id)"
    )


def downgrade() -> None:
    # Lossy by construction: a key held by more than one user cannot fit back
    # under a primary key of `key` alone, so this fails rather than choosing a
    # row to discard.
    op.drop_constraint("uq_settings_key_user_id", "settings", type_="unique")
    op.drop_constraint("settings_pkey", "settings", type_="primary")
    op.create_primary_key("settings_pkey", "settings", ["key"])
    op.drop_column("settings", "id")
