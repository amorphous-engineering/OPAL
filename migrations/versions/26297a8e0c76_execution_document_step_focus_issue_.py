"""Execution document: step focus (cursor presence), step images, capture attribution, strict_sequence

Revision ID: 26297a8e0c76
Revises: 52973e130a6f
Create Date: 2026-06-12 12:00:00.000000

"""
from typing import Sequence, Union

from alembic import op
import sqlalchemy as sa


# revision identifiers, used by Alembic.
revision: str = '26297a8e0c76'
down_revision: Union[str, None] = '52973e130a6f'
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    # Cursor presence — one row per (instance, user), upserted as the cursor
    # moves. Ephemeral presence, not history: moving records no event.
    op.create_table(
        'step_focus',
        sa.Column('id', sa.Integer(), autoincrement=True, nullable=False),
        sa.Column('instance_id', sa.Integer(), nullable=False),
        sa.Column('step_execution_id', sa.Integer(), nullable=False),
        sa.Column('user_id', sa.Integer(), nullable=False),
        sa.Column('focused_at', sa.DateTime(timezone=True), nullable=False),
        sa.Column('created_at', sa.DateTime(timezone=True), nullable=False),
        sa.Column('updated_at', sa.DateTime(timezone=True), nullable=False),
        sa.ForeignKeyConstraint(['instance_id'], ['procedure_instance.id'], ondelete='CASCADE'),
        sa.ForeignKeyConstraint(['step_execution_id'], ['step_execution.id'], ondelete='CASCADE'),
        sa.ForeignKeyConstraint(['user_id'], ['user.id'], ondelete='CASCADE'),
        sa.PrimaryKeyConstraint('id'),
        sa.UniqueConstraint('instance_id', 'user_id', name='uq_step_focus_user'),
    )
    op.create_index(op.f('ix_step_focus_instance_id'), 'step_focus', ['instance_id'], unique=False)
    op.create_index(
        op.f('ix_step_focus_step_execution_id'), 'step_focus', ['step_execution_id'], unique=False
    )
    op.create_index(op.f('ix_step_focus_user_id'), 'step_focus', ['user_id'], unique=False)

    # Soft telemetry: first cursor focus per step; never rendered as state.
    with op.batch_alter_table('step_execution', schema=None) as batch_op:
        batch_op.add_column(sa.Column(
            'first_focused_at', sa.DateTime(timezone=True), nullable=True,
            comment='Soft telemetry: first cursor focus; never rendered as state',
        ))


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


    with op.batch_alter_table('step_execution', schema=None) as batch_op:
        batch_op.drop_column('first_focused_at')

    op.drop_index(op.f('ix_step_focus_user_id'), table_name='step_focus')
    op.drop_index(op.f('ix_step_focus_step_execution_id'), table_name='step_focus')
    op.drop_index(op.f('ix_step_focus_instance_id'), table_name='step_focus')
    op.drop_table('step_focus')
