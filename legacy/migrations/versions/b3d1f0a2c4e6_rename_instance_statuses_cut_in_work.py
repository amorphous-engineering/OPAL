"""Rename instance statuses: pending -> cut, in_progress -> in_work

Work orders are "cut" from a master procedure; untouched instances are
CUT, started instances are IN WORK. Step statuses are unchanged.

Revision ID: b3d1f0a2c4e6
Revises: 26297a8e0c76
Create Date: 2026-06-12 12:00:00.000000

"""
from typing import Sequence, Union

import sqlalchemy as sa
from alembic import op

# revision identifiers, used by Alembic.
revision: str = 'b3d1f0a2c4e6'
down_revision: Union[str, None] = '26297a8e0c76'
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None

_instance = sa.table('procedure_instance', sa.column('status', sa.String))


def upgrade() -> None:
    op.execute(_instance.update().where(_instance.c.status == 'pending').values(status='cut'))
    op.execute(
        _instance.update().where(_instance.c.status == 'in_progress').values(status='in_work')
    )


def downgrade() -> None:
    op.execute(_instance.update().where(_instance.c.status == 'cut').values(status='pending'))
    op.execute(
        _instance.update().where(_instance.c.status == 'in_work').values(status='in_progress')
    )
