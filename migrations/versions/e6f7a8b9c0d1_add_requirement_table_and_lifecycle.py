"""add requirement table and part_requirements FK

Revision ID: e6f7a8b9c0d1
Revises: b3f1c2a9d4e7
Create Date: 2026-06-09 17:30:00.000000

"""
from typing import Sequence, Union

from alembic import op
import sqlalchemy as sa


# revision identifiers, used by Alembic.
revision: str = 'e6f7a8b9c0d1'
down_revision: Union[str, None] = 'd5e6f7a8b9c0'
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    op.create_table(
        'requirement',
        sa.Column('id', sa.Integer(), autoincrement=True, nullable=False),
        sa.Column('req_number', sa.String(length=20), nullable=False),
        sa.Column('title', sa.String(length=255), nullable=False),
        sa.Column('statement', sa.Text(), nullable=False),
        sa.Column('rationale', sa.Text(), nullable=True),
        sa.Column('category', sa.String(length=50), nullable=True),
        sa.Column('parent_id', sa.Integer(), nullable=True),
        sa.Column('level', sa.Integer(), nullable=False),
        sa.Column('verification_method', sa.String(length=20), nullable=True),
        sa.Column('tbd', sa.Boolean(), nullable=False),
        sa.Column('tbr', sa.Boolean(), nullable=False),
        sa.Column('tbr_owner_id', sa.Integer(), nullable=True),
        sa.Column('tbr_due', sa.DateTime(timezone=True), nullable=True),
        sa.Column('lifecycle_state', sa.String(length=20), nullable=False),
        sa.Column('revision', sa.Integer(), nullable=False),
        sa.Column('baselined_at', sa.DateTime(timezone=True), nullable=True),
        sa.Column('baselined_by_id', sa.Integer(), nullable=True),
        sa.Column('supersedes_id', sa.Integer(), nullable=True),
        sa.Column('created_at', sa.DateTime(timezone=True), nullable=False),
        sa.Column('updated_at', sa.DateTime(timezone=True), nullable=False),
        sa.Column('deleted_at', sa.DateTime(timezone=True), nullable=True),
        sa.ForeignKeyConstraint(['parent_id'], ['requirement.id'], ondelete='SET NULL'),
        sa.ForeignKeyConstraint(['tbr_owner_id'], ['user.id'], ondelete='SET NULL'),
        sa.ForeignKeyConstraint(['baselined_by_id'], ['user.id'], ondelete='SET NULL'),
        sa.ForeignKeyConstraint(['supersedes_id'], ['requirement.id'], ondelete='SET NULL'),
        sa.PrimaryKeyConstraint('id'),
        sa.UniqueConstraint('req_number', 'revision', name='uq_requirement_number_revision'),
    )
    op.create_index(op.f('ix_requirement_req_number'), 'requirement', ['req_number'])
    op.create_index(op.f('ix_requirement_parent_id'), 'requirement', ['parent_id'])

    with op.batch_alter_table('part_requirements') as batch_op:
        batch_op.add_column(sa.Column('requirement_ref_id', sa.Integer(), nullable=True))
        batch_op.create_foreign_key(
            'fk_part_requirements_requirement_ref_id',
            'requirement',
            ['requirement_ref_id'],
            ['id'],
            ondelete='SET NULL',
        )
        batch_op.create_index(
            'ix_part_requirements_requirement_ref_id', ['requirement_ref_id']
        )


def downgrade() -> None:
    with op.batch_alter_table('part_requirements') as batch_op:
        batch_op.drop_index('ix_part_requirements_requirement_ref_id')
        batch_op.drop_constraint('fk_part_requirements_requirement_ref_id', type_='foreignkey')
        batch_op.drop_column('requirement_ref_id')

    op.drop_index(op.f('ix_requirement_parent_id'), table_name='requirement')
    op.drop_index(op.f('ix_requirement_req_number'), table_name='requirement')
    op.drop_table('requirement')
