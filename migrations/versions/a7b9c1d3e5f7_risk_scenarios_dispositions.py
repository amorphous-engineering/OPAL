"""Risk scenarios, dispositions, acceptance (issue #40)

Revision ID: a7b9c1d3e5f7
Revises: ccf93c36170a
Create Date: 2026-06-11 12:00:00.000000

Risk gains the four-part scenario (condition / departure / asset /
consequence), the CRM disposition set replacing freeform status, residual
scoring, the acceptance signature, watch fields, and the review stamp.
Responses move from the mitigation_plan prose blob and single
linked_issue_id to the risk_issue_link table (role: mitigation | research).
"""
from typing import Sequence, Union

from alembic import op
import sqlalchemy as sa


# revision identifiers, used by Alembic.
revision: str = 'a7b9c1d3e5f7'
down_revision: Union[str, None] = 'ccf93c36170a'
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None

#: status -> disposition. analyzing maps to research (investigating to reduce
#: uncertainty); the new states' entry requirements gate transitions, never
#: existing rows.
_STATUS_TO_DISPOSITION = {
    'identified': 'open',
    'analyzing': 'research',
    'mitigating': 'mitigate',
    'monitoring': 'watch',
    'closed': 'closed',
}


def upgrade() -> None:
    op.create_table(
        'risk_issue_link',
        sa.Column('id', sa.Integer(), autoincrement=True, nullable=False),
        sa.Column('risk_id', sa.Integer(), nullable=False),
        sa.Column('issue_id', sa.Integer(), nullable=False),
        sa.Column('role', sa.String(length=20), nullable=False, server_default='mitigation'),
        sa.Column('created_at', sa.DateTime(timezone=True), nullable=False),
        sa.Column('updated_at', sa.DateTime(timezone=True), nullable=False),
        sa.ForeignKeyConstraint(['risk_id'], ['risk.id'], ondelete='CASCADE'),
        sa.ForeignKeyConstraint(['issue_id'], ['issue.id'], ondelete='CASCADE'),
        sa.PrimaryKeyConstraint('id'),
        sa.UniqueConstraint('risk_id', 'issue_id', name='uq_risk_issue_link'),
    )
    op.create_index(op.f('ix_risk_issue_link_risk_id'), 'risk_issue_link', ['risk_id'])
    op.create_index(op.f('ix_risk_issue_link_issue_id'), 'risk_issue_link', ['issue_id'])

    with op.batch_alter_table('risk', schema=None) as batch_op:
        batch_op.add_column(sa.Column(
            'condition', sa.Text(), nullable=True,
            comment='Present-tense fact, independently checkable now',
        ))
        batch_op.add_column(sa.Column(
            'departure', sa.Text(), nullable=True,
            comment='Undesired future event — probability scores this',
        ))
        batch_op.add_column(sa.Column(
            'asset_part_id', sa.Integer(), nullable=True,
            comment='Exposed asset when it is hardware (else asset_text; exactly one set)',
        ))
        batch_op.add_column(sa.Column(
            'asset_text', sa.String(length=255), nullable=True,
            comment='Exposed asset when not hardware ("schedule", ...)',
        ))
        batch_op.add_column(sa.Column(
            'consequence', sa.Text(), nullable=True,
            comment='Credible measurable impact — impact scores this',
        ))
        batch_op.add_column(sa.Column(
            'disposition', sa.String(length=20), nullable=False, server_default='open',
        ))
        batch_op.add_column(sa.Column('owner_id', sa.Integer(), nullable=True))
        batch_op.add_column(sa.Column(
            'residual_probability', sa.Integer(), nullable=True,
            comment='1-5 scale, post-response target',
        ))
        batch_op.add_column(sa.Column(
            'residual_impact', sa.Integer(), nullable=True,
            comment='1-5 scale, post-response target',
        ))
        batch_op.add_column(sa.Column('accepted_by_id', sa.Integer(), nullable=True))
        batch_op.add_column(sa.Column('accepted_at', sa.DateTime(timezone=True), nullable=True))
        batch_op.add_column(sa.Column('acceptance_rationale', sa.Text(), nullable=True))
        batch_op.add_column(sa.Column('watch_observable', sa.String(length=255), nullable=True))
        batch_op.add_column(sa.Column('watch_threshold', sa.String(length=255), nullable=True))
        batch_op.add_column(sa.Column('watch_contingency', sa.Text(), nullable=True))
        batch_op.add_column(sa.Column(
            'last_reviewed_at', sa.DateTime(timezone=True), nullable=True,
        ))
        batch_op.add_column(sa.Column('last_reviewed_by_id', sa.Integer(), nullable=True))
        batch_op.add_column(sa.Column('realized_issue_id', sa.Integer(), nullable=True))
        batch_op.create_index(batch_op.f('ix_risk_disposition'), ['disposition'], unique=False)
        batch_op.create_index(batch_op.f('ix_risk_owner_id'), ['owner_id'], unique=False)
        batch_op.create_index(batch_op.f('ix_risk_asset_part_id'), ['asset_part_id'], unique=False)
        batch_op.create_index(
            batch_op.f('ix_risk_realized_issue_id'), ['realized_issue_id'], unique=False,
        )
        batch_op.create_foreign_key(
            'fk_risk_owner_id_user', 'user', ['owner_id'], ['id'], ondelete='SET NULL',
        )
        batch_op.create_foreign_key(
            'fk_risk_accepted_by_id_user', 'user', ['accepted_by_id'], ['id'], ondelete='SET NULL',
        )
        batch_op.create_foreign_key(
            'fk_risk_last_reviewed_by_id_user', 'user', ['last_reviewed_by_id'], ['id'],
            ondelete='SET NULL',
        )
        batch_op.create_foreign_key(
            'fk_risk_asset_part_id_part', 'part', ['asset_part_id'], ['id'], ondelete='SET NULL',
        )
        batch_op.create_foreign_key(
            'fk_risk_realized_issue_id_issue', 'issue', ['realized_issue_id'], ['id'],
            ondelete='SET NULL',
        )

    conn = op.get_bind()

    for status, disposition in _STATUS_TO_DISPOSITION.items():
        conn.execute(
            sa.text("UPDATE risk SET disposition = :disposition WHERE status = :status"),
            {"disposition": disposition, "status": status},
        )

    conn.execute(sa.text(
        "INSERT INTO risk_issue_link (risk_id, issue_id, role, created_at, updated_at) "
        "SELECT id, linked_issue_id, 'mitigation', CURRENT_TIMESTAMP, CURRENT_TIMESTAMP "
        "FROM risk WHERE linked_issue_id IS NOT NULL"
    ))

    # The prose plan is dead as a field, not as information: fold it into the
    # narrative under a marker so re-entering it as linked issues is a
    # read-and-transcribe job, not an archaeology one.
    conn.execute(sa.text(
        "UPDATE risk SET description = "
        "CASE WHEN description IS NULL OR trim(description) = '' "
        "THEN 'LEGACY MITIGATION PLAN:' || char(10) || mitigation_plan "
        "ELSE description || char(10) || char(10) || 'LEGACY MITIGATION PLAN:' "
        "|| char(10) || mitigation_plan END "
        "WHERE mitigation_plan IS NOT NULL AND trim(mitigation_plan) != ''"
    ))

    with op.batch_alter_table('risk', schema=None) as batch_op:
        batch_op.drop_index('ix_risk_linked_issue_id')
        batch_op.drop_column('status')
        batch_op.drop_column('mitigation_plan')
        batch_op.drop_column('linked_issue_id')


def downgrade() -> None:
    conn = op.get_bind()

    with op.batch_alter_table('risk', schema=None) as batch_op:
        batch_op.add_column(sa.Column(
            'status', sa.String(length=20), nullable=False, server_default='identified',
        ))
        batch_op.add_column(sa.Column('mitigation_plan', sa.Text(), nullable=True))
        batch_op.add_column(sa.Column('linked_issue_id', sa.Integer(), nullable=True))
        batch_op.create_index('ix_risk_linked_issue_id', ['linked_issue_id'], unique=False)
        batch_op.create_foreign_key(
            'fk_risk_linked_issue_id_issue', 'issue', ['linked_issue_id'], ['id'],
            ondelete='SET NULL',
        )

    disposition_to_status = {
        'open': 'identified',
        'research': 'analyzing',
        'mitigate': 'mitigating',
        'watch': 'monitoring',
        'accepted': 'monitoring',
        'closed': 'closed',
        'realized': 'closed',
    }
    for disposition, status in disposition_to_status.items():
        conn.execute(
            sa.text("UPDATE risk SET status = :status WHERE disposition = :disposition"),
            {"status": status, "disposition": disposition},
        )

    # Restore the single linked issue from the oldest mitigation link.
    conn.execute(sa.text(
        "UPDATE risk SET linked_issue_id = ("
        "SELECT issue_id FROM risk_issue_link "
        "WHERE risk_issue_link.risk_id = risk.id ORDER BY id LIMIT 1)"
    ))

    # Recover the legacy plan text folded into description on upgrade.
    rows = conn.execute(sa.text(
        "SELECT id, description FROM risk WHERE description LIKE '%LEGACY MITIGATION PLAN:%'"
    )).fetchall()
    for risk_id, description in rows:
        narrative, _, plan = description.partition('LEGACY MITIGATION PLAN:\n')
        conn.execute(
            sa.text("UPDATE risk SET description = :description, mitigation_plan = :plan "
                    "WHERE id = :id"),
            {"description": narrative.strip() or None, "plan": plan.strip(), "id": risk_id},
        )

    with op.batch_alter_table('risk', schema=None) as batch_op:
        batch_op.drop_constraint('fk_risk_owner_id_user', type_='foreignkey')
        batch_op.drop_constraint('fk_risk_accepted_by_id_user', type_='foreignkey')
        batch_op.drop_constraint('fk_risk_last_reviewed_by_id_user', type_='foreignkey')
        batch_op.drop_constraint('fk_risk_asset_part_id_part', type_='foreignkey')
        batch_op.drop_constraint('fk_risk_realized_issue_id_issue', type_='foreignkey')
        batch_op.drop_index(batch_op.f('ix_risk_realized_issue_id'))
        batch_op.drop_index(batch_op.f('ix_risk_asset_part_id'))
        batch_op.drop_index(batch_op.f('ix_risk_owner_id'))
        batch_op.drop_index(batch_op.f('ix_risk_disposition'))
        for column in (
            'realized_issue_id', 'last_reviewed_by_id', 'last_reviewed_at',
            'watch_contingency', 'watch_threshold', 'watch_observable',
            'acceptance_rationale', 'accepted_at', 'accepted_by_id',
            'residual_impact', 'residual_probability', 'owner_id', 'disposition',
            'consequence', 'asset_text', 'asset_part_id', 'departure', 'condition',
        ):
            batch_op.drop_column(column)

    op.drop_index(op.f('ix_risk_issue_link_issue_id'), table_name='risk_issue_link')
    op.drop_index(op.f('ix_risk_issue_link_risk_id'), table_name='risk_issue_link')
    op.drop_table('risk_issue_link')
