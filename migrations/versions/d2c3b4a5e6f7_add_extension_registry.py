"""add extension registry table

Revision ID: d2c3b4a5e6f7
Revises: e7a1c93f2b48
Create Date: 2026-08-15 12:00:00.000000

Holds the instance's decision about each extension discovered on disk —
enabled or not, where it came from, and the manifest as accepted. Rows are
reconciled against the filesystem on every settings read, so this table is
never the source of truth for what exists, only for what was chosen.
"""

from collections.abc import Sequence

import sqlalchemy as sa
from alembic import op

# revision identifiers, used by Alembic.
revision: str = "d2c3b4a5e6f7"
down_revision: str | None = "e7a1c93f2b48"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None


def upgrade() -> None:
    op.create_table(
        "extension",
        sa.Column("id", sa.String(length=64), nullable=False),
        sa.Column("created_at", sa.DateTime(timezone=True), nullable=False),
        sa.Column("updated_at", sa.DateTime(timezone=True), nullable=False),
        sa.Column("name", sa.String(length=120), nullable=False),
        sa.Column("version", sa.String(length=32), nullable=False),
        sa.Column("summary", sa.Text(), nullable=True),
        sa.Column(
            "origin",
            sa.String(length=16),
            nullable=False,
            comment="bundled = ships with OPAL, installed = uploaded",
        ),
        sa.Column("enabled", sa.Boolean(), nullable=False),
        sa.Column("installed_at", sa.DateTime(timezone=True), nullable=False),
        sa.Column(
            "checksum",
            sa.String(length=64),
            nullable=True,
            comment="SHA-256 of the uploaded archive; NULL for bundled",
        ),
        sa.Column(
            "manifest",
            sa.JSON(),
            nullable=False,
            comment="Manifest as accepted at install time",
        ),
        sa.PrimaryKeyConstraint("id"),
    )


def downgrade() -> None:
    op.drop_table("extension")
