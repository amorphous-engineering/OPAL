"""add notification table

Revision ID: f3a9d2c8b501
Revises: d2c3b4a5e6f7
Create Date: 2026-08-16 09:00:00.000000

One row per recipient per event. Read and dismissal state are per-person, so
they live on the row rather than on a shared event record.
"""

from collections.abc import Sequence

import sqlalchemy as sa
from alembic import op

# revision identifiers, used by Alembic.
revision: str = "f3a9d2c8b501"
down_revision: str | None = "d2c3b4a5e6f7"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None


def upgrade() -> None:
    op.create_table(
        "notification",
        sa.Column("id", sa.Integer(), nullable=False),
        sa.Column("created_at", sa.DateTime(timezone=True), nullable=False),
        sa.Column("updated_at", sa.DateTime(timezone=True), nullable=False),
        sa.Column("user_id", sa.Integer(), nullable=False, comment="Recipient"),
        sa.Column(
            "actor_id",
            sa.Integer(),
            nullable=True,
            comment="Who caused it; NULL when the system did",
        ),
        sa.Column("kind", sa.String(length=40), nullable=False),
        sa.Column("priority", sa.String(length=16), nullable=False),
        sa.Column("title", sa.String(length=255), nullable=False),
        sa.Column("body", sa.Text(), nullable=True),
        sa.Column(
            "href",
            sa.String(length=500),
            nullable=False,
            comment="Where the reader goes to see the live record",
        ),
        sa.Column(
            "subject_type",
            sa.String(length=40),
            nullable=False,
            comment="e.g. issue, procedure_instance",
        ),
        sa.Column("subject_id", sa.Integer(), nullable=False),
        sa.Column("read_at", sa.DateTime(timezone=True), nullable=True),
        sa.Column("dismissed_at", sa.DateTime(timezone=True), nullable=True),
        sa.ForeignKeyConstraint(["user_id"], ["user.id"], ondelete="CASCADE"),
        sa.ForeignKeyConstraint(["actor_id"], ["user.id"], ondelete="SET NULL"),
        sa.PrimaryKeyConstraint("id"),
    )
    op.create_index(op.f("ix_notification_user_id"), "notification", ["user_id"], unique=False)
    op.create_index(op.f("ix_notification_kind"), "notification", ["kind"], unique=False)
    op.create_index(
        "ix_notification_user_created", "notification", ["user_id", "created_at"], unique=False
    )


def downgrade() -> None:
    op.drop_index("ix_notification_user_created", table_name="notification")
    op.drop_index(op.f("ix_notification_kind"), table_name="notification")
    op.drop_index(op.f("ix_notification_user_id"), table_name="notification")
    op.drop_table("notification")
