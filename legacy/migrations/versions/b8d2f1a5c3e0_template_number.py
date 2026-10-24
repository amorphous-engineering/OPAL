"""add template_number to master_procedure

Revision ID: b8d2f1a5c3e0
Revises: a7c1e0f4b2d9
Create Date: 2026-10-24 09:00:00.000000

Adds T-XXXX numbers to procedure templates. Existing rows, soft-deleted ones
included, are numbered in id order and the T designator sequence starts after
the highest number used.
"""

from collections.abc import Sequence
from datetime import UTC, datetime

import sqlalchemy as sa
from alembic import op

# revision identifiers, used by Alembic.
revision: str = "b8d2f1a5c3e0"
down_revision: str | None = "a7c1e0f4b2d9"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None


def upgrade() -> None:
    with op.batch_alter_table("master_procedure") as batch_op:
        batch_op.add_column(sa.Column("template_number", sa.String(length=20), nullable=True))

    conn = op.get_bind()
    procedure = sa.table(
        "master_procedure", sa.column("id", sa.Integer), sa.column("template_number", sa.String)
    )
    ids = [r[0] for r in conn.execute(sa.select(procedure.c.id).order_by(procedure.c.id))]
    for n, pid in enumerate(ids, start=1):
        conn.execute(
            procedure.update().where(procedure.c.id == pid).values(template_number=f"T-{n:04d}")
        )

    if ids:
        sequence = sa.table(
            "designator_sequence",
            sa.column("designator_type", sa.String),
            sa.column("last_value", sa.Integer),
            sa.column("created_at", sa.DateTime(timezone=True)),
            sa.column("updated_at", sa.DateTime(timezone=True)),
        )
        now = datetime.now(UTC)
        conn.execute(sequence.delete().where(sequence.c.designator_type == "T"))
        conn.execute(
            sequence.insert().values(
                designator_type="T", last_value=len(ids), created_at=now, updated_at=now
            )
        )

    with op.batch_alter_table("master_procedure") as batch_op:
        batch_op.alter_column(
            "template_number",
            existing_type=sa.String(length=20),
            nullable=False,
            existing_comment=None,
            comment="Human-readable number, e.g. T-0042. System-unique, never reused.",
        )
        batch_op.create_index(
            batch_op.f("ix_master_procedure_template_number"), ["template_number"], unique=True
        )


def downgrade() -> None:
    conn = op.get_bind()
    conn.execute(sa.text("DELETE FROM designator_sequence WHERE designator_type = 'T'"))
    with op.batch_alter_table("master_procedure") as batch_op:
        batch_op.drop_index(batch_op.f("ix_master_procedure_template_number"))
        batch_op.drop_column("template_number")
