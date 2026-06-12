"""Execution document: step claims, issue step blocks, step images, capture attribution, strict_sequence

Revision ID: 26297a8e0c76
Revises: ccf93c36170a
Create Date: 2026-06-12 12:00:00.000000

"""
from typing import Sequence, Union

from alembic import op
import sqlalchemy as sa


# revision identifiers, used by Alembic.
revision: str = '26297a8e0c76'
down_revision: Union[str, None] = 'ccf93c36170a'
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    # Step claims — who is actively working which step. Active = released_at IS NULL.
    op.create_table(
        'step_claim',
        sa.Column('id', sa.Integer(), autoincrement=True, nullable=False),
        sa.Column('instance_id', sa.Integer(), nullable=False),
        sa.Column('step_execution_id', sa.Integer(), nullable=False),
        sa.Column('user_id', sa.Integer(), nullable=False),
        sa.Column('claimed_at', sa.DateTime(timezone=True), nullable=False),
        sa.Column('released_at', sa.DateTime(timezone=True), nullable=True),
        sa.Column(
            'release_reason', sa.String(length=20), nullable=True,
            comment='Set when released_at is set',
        ),
        sa.Column('created_at', sa.DateTime(timezone=True), nullable=False),
        sa.Column('updated_at', sa.DateTime(timezone=True), nullable=False),
        sa.ForeignKeyConstraint(['instance_id'], ['procedure_instance.id'], ondelete='CASCADE'),
        sa.ForeignKeyConstraint(['step_execution_id'], ['step_execution.id'], ondelete='CASCADE'),
        sa.ForeignKeyConstraint(['user_id'], ['user.id'], ondelete='CASCADE'),
        sa.PrimaryKeyConstraint('id'),
    )
    op.create_index(op.f('ix_step_claim_instance_id'), 'step_claim', ['instance_id'], unique=False)
    op.create_index(
        op.f('ix_step_claim_step_execution_id'), 'step_claim', ['step_execution_id'], unique=False
    )
    op.create_index(op.f('ix_step_claim_user_id'), 'step_claim', ['user_id'], unique=False)

    # Issue step blocks — hold points. The hold is derived from the issue's
    # disposition state; this table only records the binding.
    op.create_table(
        'issue_step_block',
        sa.Column('id', sa.Integer(), autoincrement=True, nullable=False),
        sa.Column('issue_id', sa.Integer(), nullable=False),
        sa.Column('step_execution_id', sa.Integer(), nullable=False),
        sa.Column('created_at', sa.DateTime(timezone=True), nullable=False),
        sa.Column('updated_at', sa.DateTime(timezone=True), nullable=False),
        sa.ForeignKeyConstraint(['issue_id'], ['issue.id'], ondelete='CASCADE'),
        sa.ForeignKeyConstraint(['step_execution_id'], ['step_execution.id'], ondelete='CASCADE'),
        sa.PrimaryKeyConstraint('id'),
        sa.UniqueConstraint('issue_id', 'step_execution_id', name='uq_issue_step_block'),
    )
    op.create_index(
        op.f('ix_issue_step_block_issue_id'), 'issue_step_block', ['issue_id'], unique=False
    )
    op.create_index(
        op.f('ix_issue_step_block_step_execution_id'),
        'issue_step_block',
        ['step_execution_id'],
        unique=False,
    )

    # Authored step reference images — procedure content, snapshotted at publish.
    op.create_table(
        'step_image',
        sa.Column('id', sa.Integer(), autoincrement=True, nullable=False),
        sa.Column('step_id', sa.Integer(), nullable=False),
        sa.Column('attachment_id', sa.Integer(), nullable=False),
        sa.Column('caption', sa.String(length=255), nullable=True),
        sa.Column('position', sa.Integer(), nullable=False),
        sa.Column('created_at', sa.DateTime(timezone=True), nullable=False),
        sa.Column('updated_at', sa.DateTime(timezone=True), nullable=False),
        sa.ForeignKeyConstraint(['step_id'], ['procedure_step.id'], ondelete='CASCADE'),
        sa.ForeignKeyConstraint(['attachment_id'], ['attachment.id'], ondelete='RESTRICT'),
        sa.PrimaryKeyConstraint('id'),
    )
    op.create_index(op.f('ix_step_image_step_id'), 'step_image', ['step_id'], unique=False)
    op.create_index(
        op.f('ix_step_image_attachment_id'), 'step_image', ['attachment_id'], unique=False
    )

    # Execution-capture attribution + note on attachments.
    with op.batch_alter_table('attachment', schema=None) as batch_op:
        batch_op.add_column(sa.Column(
            'note', sa.Text(), nullable=True,
            comment="Capturer's note on an execution capture",
        ))
        batch_op.add_column(sa.Column('uploaded_by_id', sa.Integer(), nullable=True))
        batch_op.create_index(
            batch_op.f('ix_attachment_uploaded_by_id'), ['uploaded_by_id'], unique=False
        )
        batch_op.create_foreign_key(
            'fk_attachment_uploaded_by_id_user', 'user', ['uploaded_by_id'], ['id'],
            ondelete='SET NULL',
        )

    # Opt-in in-order sub-step execution on an OP.
    with op.batch_alter_table('procedure_step', schema=None) as batch_op:
        batch_op.add_column(sa.Column(
            'strict_sequence', sa.Boolean(), nullable=False, server_default=sa.false(),
            comment='OP-level: sub-steps must start in order (N requires N-1 terminal)',
        ))


def downgrade() -> None:
    with op.batch_alter_table('procedure_step', schema=None) as batch_op:
        batch_op.drop_column('strict_sequence')

    with op.batch_alter_table('attachment', schema=None) as batch_op:
        batch_op.drop_constraint('fk_attachment_uploaded_by_id_user', type_='foreignkey')
        batch_op.drop_index(batch_op.f('ix_attachment_uploaded_by_id'))
        batch_op.drop_column('uploaded_by_id')
        batch_op.drop_column('note')

    op.drop_index(op.f('ix_step_image_attachment_id'), table_name='step_image')
    op.drop_index(op.f('ix_step_image_step_id'), table_name='step_image')
    op.drop_table('step_image')

    op.drop_index(op.f('ix_issue_step_block_step_execution_id'), table_name='issue_step_block')
    op.drop_index(op.f('ix_issue_step_block_issue_id'), table_name='issue_step_block')
    op.drop_table('issue_step_block')

    op.drop_index(op.f('ix_step_claim_user_id'), table_name='step_claim')
    op.drop_index(op.f('ix_step_claim_step_execution_id'), table_name='step_claim')
    op.drop_index(op.f('ix_step_claim_instance_id'), table_name='step_claim')
    op.drop_table('step_claim')
