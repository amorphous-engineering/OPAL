"""add webauthn_challenge (single-use handshake store)

Revision ID: c1a2b3d4e5f6
Revises: b4b681fa39d7
Create Date: 2026-07-22 15:30:00.000000

"""

from collections.abc import Sequence

import sqlalchemy as sa
from alembic import op

# revision identifiers, used by Alembic.
revision: str = "c1a2b3d4e5f6"
down_revision: str | None = "b4b681fa39d7"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None


def upgrade() -> None:
    op.create_table(
        "webauthn_challenge",
        sa.Column("id", sa.Integer(), nullable=False),
        sa.Column("created_at", sa.DateTime(timezone=True), nullable=False),
        sa.Column("updated_at", sa.DateTime(timezone=True), nullable=False),
        sa.Column("nonce", sa.String(length=64), nullable=False),
        sa.Column("kind", sa.String(length=16), nullable=False),
        sa.Column("rp_id", sa.String(length=255), nullable=False),
        sa.Column("user_id", sa.Integer(), nullable=True),
        sa.Column("state_json", sa.Text(), nullable=False),
        sa.Column("expires_at", sa.DateTime(timezone=True), nullable=False),
        sa.ForeignKeyConstraint(["user_id"], ["user.id"], ondelete="CASCADE"),
        sa.PrimaryKeyConstraint("id"),
    )
    op.create_index(
        op.f("ix_webauthn_challenge_nonce"), "webauthn_challenge", ["nonce"], unique=True
    )
    op.create_index(
        op.f("ix_webauthn_challenge_user_id"), "webauthn_challenge", ["user_id"], unique=False
    )


def downgrade() -> None:
    op.drop_index(op.f("ix_webauthn_challenge_user_id"), table_name="webauthn_challenge")
    op.drop_index(op.f("ix_webauthn_challenge_nonce"), table_name="webauthn_challenge")
    op.drop_table("webauthn_challenge")
