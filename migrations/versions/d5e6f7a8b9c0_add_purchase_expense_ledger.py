"""add purchase expense ledger

Revision ID: d5e6f7a8b9c0
Revises: c4d5e6f7a8b9
Create Date: 2026-06-09 18:00:00.000000

"""
from typing import Sequence, Union

from alembic import op
import sqlalchemy as sa


# revision identifiers, used by Alembic.
revision: str = 'd5e6f7a8b9c0'
down_revision: Union[str, None] = 'c4d5e6f7a8b9'
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    op.create_table(
        'purchase_expense',
        sa.Column('id', sa.Integer(), autoincrement=True, nullable=False),
        sa.Column('purchase_id', sa.Integer(), nullable=False),
        sa.Column('purchase_line_id', sa.Integer(), nullable=True),
        sa.Column('part_id', sa.Integer(), nullable=True),
        sa.Column('quantity', sa.Numeric(precision=15, scale=4), nullable=False),
        sa.Column('unit_cost', sa.Numeric(precision=15, scale=4), nullable=True),
        sa.Column('total_cost', sa.Numeric(precision=15, scale=4), nullable=True),
        sa.Column('tier', sa.Integer(), nullable=True),
        sa.Column('received_at', sa.DateTime(timezone=True), nullable=False),
        sa.Column('notes', sa.Text(), nullable=True),
        sa.Column('created_at', sa.DateTime(timezone=True), nullable=False),
        sa.Column('updated_at', sa.DateTime(timezone=True), nullable=False),
        sa.ForeignKeyConstraint(['purchase_id'], ['purchase.id'], ondelete='CASCADE'),
        sa.ForeignKeyConstraint(['purchase_line_id'], ['purchase_line.id'], ondelete='SET NULL'),
        sa.ForeignKeyConstraint(['part_id'], ['part.id'], ondelete='SET NULL'),
        sa.PrimaryKeyConstraint('id'),
    )
    op.create_index(
        op.f('ix_purchase_expense_purchase_id'), 'purchase_expense', ['purchase_id']
    )


def downgrade() -> None:
    op.drop_index(op.f('ix_purchase_expense_purchase_id'), table_name='purchase_expense')
    op.drop_table('purchase_expense')
