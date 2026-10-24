"""Part identity lifecycle (draft/active)

Revision ID: ccf93c36170a
Revises: f1e2d3c4b5a6
Create Date: 2026-06-10 12:00:00.000000

"""
import re
from typing import Sequence, Union

from alembic import op
import sqlalchemy as sa


# revision identifiers, used by Alembic.
revision: str = 'ccf93c36170a'
down_revision: Union[str, None] = 'f1e2d3c4b5a6'
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    with op.batch_alter_table('part', schema=None) as batch_op:
        batch_op.add_column(sa.Column(
            'lifecycle_state', sa.String(length=20), nullable=False,
            server_default='draft',
            comment='draft (identity mutable) or active (identity locked)',
        ))
        batch_op.add_column(sa.Column('activated_at', sa.DateTime(timezone=True), nullable=True))
        batch_op.add_column(sa.Column('activated_by_id', sa.Integer(), nullable=True))
        batch_op.add_column(sa.Column(
            'activation_cause', sa.String(length=255), nullable=True,
            comment="What locked this part's identity (a part should explain why it locked)",
        ))
        batch_op.create_index(batch_op.f('ix_part_lifecycle_state'), ['lifecycle_state'], unique=False)
        batch_op.create_foreign_key(
            'fk_part_activated_by_id_user', 'user', ['activated_by_id'], ['id'],
            ondelete='SET NULL',
        )

    conn = op.get_bind()

    # Existing parts (including soft-deleted) have numbers in the wild —
    # backfill them as active; pretending otherwise would be the system
    # lying about its own history.
    conn.execute(sa.text(
        "UPDATE part SET lifecycle_state='active', activated_at=CURRENT_TIMESTAMP, "
        "activation_cause='migration backfill (pre-lifecycle)'"
    ))

    # Seed per-tier PN counters from the max trailing digit-run of existing
    # part numbers (including soft-deleted — their numbers stay consumed).
    # Replaces count-based generation, which reissued numbers after deletes.
    max_seq: dict[int, int] = {}
    rows = conn.execute(sa.text(
        "SELECT tier, internal_pn FROM part WHERE internal_pn IS NOT NULL"
    ))
    for tier, pn in rows:
        match = re.search(r'(\d+)\s*$', pn)
        if match:
            max_seq[tier] = max(max_seq.get(tier, 0), int(match.group(1)))
    for tier, last_value in max_seq.items():
        conn.execute(
            sa.text(
                "INSERT INTO designator_sequence "
                "(designator_type, last_value, created_at, updated_at) "
                "VALUES (:key, :val, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)"
            ),
            {"key": f"PN-{tier}", "val": last_value},
        )


def downgrade() -> None:
    conn = op.get_bind()
    conn.execute(sa.text("DELETE FROM designator_sequence WHERE designator_type LIKE 'PN-%'"))

    with op.batch_alter_table('part', schema=None) as batch_op:
        batch_op.drop_constraint('fk_part_activated_by_id_user', type_='foreignkey')
        batch_op.drop_index(batch_op.f('ix_part_lifecycle_state'))
        batch_op.drop_column('activation_cause')
        batch_op.drop_column('activated_by_id')
        batch_op.drop_column('activated_at')
        batch_op.drop_column('lifecycle_state')
