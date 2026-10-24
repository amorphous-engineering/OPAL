"""step callouts

Revision ID: a7c1e0f4b2d9
Revises: e6b8d4f2a903
Create Date: 2026-10-24 09:00:00.000000

``procedure_step.caution`` (one text) becomes ``procedure_step.callouts``
(JSON list of ``{kind, text}``). Each non-empty caution is copied to one
caution callout. Downgrade copies the first caution callout back.
"""

from collections.abc import Sequence

import sqlalchemy as sa
from alembic import op

# revision identifiers, used by Alembic.
revision: str = "a7c1e0f4b2d9"
down_revision: str | None = "e6b8d4f2a903"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None

_step = sa.table(
    "procedure_step",
    sa.column("id", sa.Integer),
    sa.column("caution", sa.Text),
    sa.column("callouts", sa.JSON),
)


def upgrade() -> None:
    with op.batch_alter_table("procedure_step") as batch:
        batch.add_column(sa.Column("callouts", sa.JSON(), nullable=True))

    bind = op.get_bind()
    rows = bind.execute(sa.select(_step.c.id, _step.c.caution)).fetchall()
    for row_id, caution in rows:
        text = (caution or "").strip()
        if text:
            bind.execute(
                sa.update(_step)
                .where(_step.c.id == row_id)
                .values(callouts=[{"kind": "caution", "text": text}])
            )

    with op.batch_alter_table("procedure_step") as batch:
        batch.drop_column("caution")


def downgrade() -> None:
    with op.batch_alter_table("procedure_step") as batch:
        batch.add_column(sa.Column("caution", sa.Text(), nullable=True))

    bind = op.get_bind()
    rows = bind.execute(sa.select(_step.c.id, _step.c.callouts)).fetchall()
    for row_id, callouts in rows:
        first = next((c["text"] for c in callouts or [] if c.get("kind") == "caution"), None)
        if first:
            bind.execute(sa.update(_step).where(_step.c.id == row_id).values(caution=first))

    with op.batch_alter_table("procedure_step") as batch:
        batch.drop_column("callouts")
