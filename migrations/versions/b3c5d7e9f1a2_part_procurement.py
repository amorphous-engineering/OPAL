"""Part procurement declaration (Amendment 6)

Revision ID: b3c5d7e9f1a2
Revises: a7b9c1d3e5f7
Create Date: 2026-06-12 19:00:00.000000

Part gains procurement: make | buy | both. The declaration governs which
part-page sections expect content (BOM for make, suppliers/POs for buy);
data always renders regardless. Backfill uses the creation heuristic:
an external PN means the part was bought, otherwise it is made here.

Known asymmetry: Onshape-synced parts store the CAD part number in
external_pn, so the backfill marks pre-existing synced parts buy while
the sync code creates new ones as make (deliberately — a CAD reference
is not a vendor PN). Re-declare affected parts via the edit form.
"""
from typing import Sequence, Union

import sqlalchemy as sa
from alembic import op

# revision identifiers, used by Alembic.
revision: str = 'b3c5d7e9f1a2'
down_revision: Union[str, None] = 'a7b9c1d3e5f7'
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    with op.batch_alter_table('part') as batch_op:
        batch_op.add_column(
            sa.Column('procurement', sa.String(length=10), nullable=False, server_default='make')
        )
        batch_op.create_index('ix_part_procurement', ['procurement'])

    part = sa.table(
        'part',
        sa.column('procurement', sa.String),
        sa.column('external_pn', sa.String),
    )
    op.execute(
        part.update()
        .where(sa.and_(part.c.external_pn.is_not(None), part.c.external_pn != ''))
        .values(procurement='buy')
    )


def downgrade() -> None:
    with op.batch_alter_table('part') as batch_op:
        batch_op.drop_index('ix_part_procurement')
        batch_op.drop_column('procurement')
