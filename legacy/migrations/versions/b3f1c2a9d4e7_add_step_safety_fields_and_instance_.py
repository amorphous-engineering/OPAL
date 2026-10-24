"""add step safety fields and instance target entity

Revision ID: b3f1c2a9d4e7
Revises: 8a5444d1e3e6
Create Date: 2026-06-09 16:30:00.000000

"""
from typing import Sequence, Union

from alembic import op
import sqlalchemy as sa


# revision identifiers, used by Alembic.
revision: str = 'b3f1c2a9d4e7'
down_revision: Union[str, None] = '8a5444d1e3e6'
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    op.add_column('procedure_step', sa.Column('required_role', sa.String(length=50), nullable=True))
    op.add_column('procedure_step', sa.Column('caution', sa.Text(), nullable=True))
    op.add_column('procedure_instance', sa.Column('target_entity', sa.JSON(), nullable=True))


def downgrade() -> None:
    op.drop_column('procedure_instance', 'target_entity')
    op.drop_column('procedure_step', 'caution')
    op.drop_column('procedure_step', 'required_role')
