"""Drop procedure_instance.target_entity

The hand-typed TARGET ENTITY inputs were cut from the WO form per rehearsal
feedback (2026-07-06); nothing writes the column and nothing reads it —
genealogy links executions through InventoryConsumption/InventoryProduction
foreign keys, not this JSON blob. Data loss on upgrade is accepted: the only
values ever written came from the removed form fields.

Revision ID: d4e8b7a2c5f1
Revises: c7a2e9d41f88
Create Date: 2026-07-06 00:00:00.000000

"""
from typing import Sequence, Union

import sqlalchemy as sa
from alembic import op

# revision identifiers, used by Alembic.
revision: str = "d4e8b7a2c5f1"
down_revision: Union[str, None] = "c7a2e9d41f88"
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    with op.batch_alter_table("procedure_instance", schema=None) as batch_op:
        batch_op.drop_column("target_entity")


def downgrade() -> None:
    with op.batch_alter_table("procedure_instance", schema=None) as batch_op:
        batch_op.add_column(sa.Column("target_entity", sa.JSON(), nullable=True))
