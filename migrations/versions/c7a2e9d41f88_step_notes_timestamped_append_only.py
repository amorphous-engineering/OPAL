"""Step notes: timestamped, authored, append-only

Replaces the single free-text step_execution.notes blob with step_note rows
(one fact, one home — the column is dropped, not kept alongside). Each
existing non-empty blob backfills as ONE note: author unknown (NULL),
created_at = the step's completed_at when present, else the migration moment.

Revision ID: c7a2e9d41f88
Revises: 894e35219894
Create Date: 2026-07-05 00:00:00.000000

"""
from datetime import UTC, datetime
from typing import Sequence, Union

import sqlalchemy as sa
from alembic import op

# revision identifiers, used by Alembic.
revision: str = "c7a2e9d41f88"
down_revision: Union[str, None] = "894e35219894"
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    op.create_table(
        "step_note",
        sa.Column("id", sa.Integer(), autoincrement=True, nullable=False),
        sa.Column("step_execution_id", sa.Integer(), nullable=False),
        sa.Column("author_id", sa.Integer(), nullable=True),
        sa.Column("body", sa.Text(), nullable=False),
        sa.Column("created_at", sa.DateTime(timezone=True), nullable=False),
        sa.Column("updated_at", sa.DateTime(timezone=True), nullable=False),
        sa.ForeignKeyConstraint(["step_execution_id"], ["step_execution.id"], ondelete="CASCADE"),
        sa.ForeignKeyConstraint(["author_id"], ["user.id"], ondelete="SET NULL"),
        sa.PrimaryKeyConstraint("id"),
    )
    op.create_index(
        op.f("ix_step_note_step_execution_id"), "step_note", ["step_execution_id"], unique=False
    )

    # Backfill: each non-empty blob becomes one note. Match the SQLite
    # DateTime storage format used by SQLAlchemy so mixed literals compare.
    now = datetime.now(UTC).strftime("%Y-%m-%d %H:%M:%S.%f")
    op.execute(
        sa.text(
            "INSERT INTO step_note "
            "(step_execution_id, author_id, body, created_at, updated_at) "
            "SELECT id, NULL, notes, COALESCE(completed_at, :now), "
            "COALESCE(completed_at, :now) "
            "FROM step_execution WHERE notes IS NOT NULL AND TRIM(notes) != ''"
        ).bindparams(now=now)
    )

    with op.batch_alter_table("step_execution", schema=None) as batch_op:
        batch_op.drop_column("notes")


def downgrade() -> None:
    with op.batch_alter_table("step_execution", schema=None) as batch_op:
        batch_op.add_column(
            sa.Column("notes", sa.Text(), nullable=True, comment="Free-text operator notes")
        )

    # Best-effort: concatenate each step's notes back into the blob
    # (group_concat follows rowid order, which matches append order).
    op.execute(
        "UPDATE step_execution SET notes = ("
        "SELECT group_concat(body, char(10)) FROM step_note "
        "WHERE step_note.step_execution_id = step_execution.id"
        ") WHERE EXISTS ("
        "SELECT 1 FROM step_note WHERE step_note.step_execution_id = step_execution.id)"
    )

    op.drop_index(op.f("ix_step_note_step_execution_id"), table_name="step_note")
    op.drop_table("step_note")
