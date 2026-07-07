"""Issue containment and disposition signature

Issues R2: the blocking predicate becomes `undispositioned`, never `open`.
- containment (step|op|wo|advisory) + containment_step_id: what an issue holds
- raised_step_id (renamed from step_execution_id) + raised_by_id: where/who found it
- disposition signature: dispositioned_by_id (renamed from
  disposition_approved_by_id) + dispositioned_at
- disposition_rationale (renamed from disposition_notes)
- actual (renamed from is_condition) — the should-be/is capture pair
- IssueStatus collapses to open|closed; disposition state is derived
- DispositionType moves to the MIL-STD-1520 set (return_to_vendor →
  return_to_supplier; repair and no_defect added)
- step_execution.on_hold rows revert to in_progress: holds are now derived
  from undispositioned issues, never stored on the step

Revision ID: a7c41d92e803
Revises: ccf93c36170a
Create Date: 2026-06-12 00:00:00.000000

"""
from typing import Sequence, Union

import sqlalchemy as sa
from alembic import op

# revision identifiers, used by Alembic.
revision: str = "a7c41d92e803"
down_revision: Union[str, None] = "ccf93c36170a"
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    # 1. Issue table: new containment/signature columns + renames
    with op.batch_alter_table("issue") as batch_op:
        batch_op.add_column(
            sa.Column("containment", sa.String(20), nullable=False, server_default="advisory")
        )
        batch_op.add_column(sa.Column("containment_step_id", sa.Integer(), nullable=True))
        batch_op.add_column(sa.Column("raised_by_id", sa.Integer(), nullable=True))
        batch_op.add_column(sa.Column("dispositioned_at", sa.DateTime(timezone=True), nullable=True))
        batch_op.alter_column("step_execution_id", new_column_name="raised_step_id")
        batch_op.alter_column("is_condition", new_column_name="actual")
        batch_op.alter_column("disposition_notes", new_column_name="disposition_rationale")
        batch_op.alter_column("disposition_approved_by_id", new_column_name="dispositioned_by_id")
        batch_op.create_foreign_key(
            "fk_issue_containment_step",
            "step_execution",
            ["containment_step_id"],
            ["id"],
            ondelete="SET NULL",
        )
        batch_op.create_foreign_key(
            "fk_issue_raised_by", "user", ["raised_by_id"], ["id"], ondelete="SET NULL"
        )

    # The index on the renamed column survives the batch rebuild under its old
    # name; rename it to match the column.
    op.execute("DROP INDEX IF EXISTS ix_issue_step_execution_id")
    op.create_index("ix_issue_raised_step_id", "issue", ["raised_step_id"])

    # 2. Data migration
    # Disposition enum: vendor → supplier (MIL-STD-1520 set)
    op.execute(
        "UPDATE issue SET disposition_type = 'return_to_supplier' "
        "WHERE disposition_type = 'return_to_vendor'"
    )
    # Issues previously approved get a best-effort signature timestamp so the
    # derived `dispositioned` gate stays true for them.
    op.execute(
        "UPDATE issue SET dispositioned_at = updated_at "
        "WHERE status = 'disposition_approved' AND disposition_type IS NOT NULL "
        "AND dispositioned_at IS NULL"
    )
    # Execution-raised NCs held their step under the old model; preserve that
    # as step containment (dispositioned/closed ones don't block anyway).
    op.execute(
        "UPDATE issue SET containment = 'step' "
        "WHERE issue_type = 'non_conformance' AND raised_step_id IS NOT NULL"
    )
    # Status collapses to open|closed.
    op.execute(
        "UPDATE issue SET status = 'open' "
        "WHERE status IN ('investigating', 'disposition_pending', 'disposition_approved')"
    )

    # 3. Step holds are derived now — stored ON_HOLD rows revert to in_progress;
    # their undispositioned issues keep blocking via containment.
    op.execute("UPDATE step_execution SET status = 'in_progress' WHERE status = 'on_hold'")


def downgrade() -> None:
    # Best-effort status reconstruction: signed dispositions map back to
    # disposition_approved; everything else stays open.
    op.execute(
        "UPDATE issue SET status = 'disposition_approved' "
        "WHERE status = 'open' AND disposition_type IS NOT NULL AND dispositioned_at IS NOT NULL"
    )
    op.execute(
        "UPDATE issue SET disposition_type = 'return_to_vendor' "
        "WHERE disposition_type = 'return_to_supplier'"
    )
    op.execute(
        "UPDATE issue SET disposition_type = 'other' "
        "WHERE disposition_type IN ('repair', 'no_defect')"
    )

    op.drop_index("ix_issue_raised_step_id", table_name="issue")

    with op.batch_alter_table("issue") as batch_op:
        batch_op.drop_constraint("fk_issue_raised_by", type_="foreignkey")
        batch_op.drop_constraint("fk_issue_containment_step", type_="foreignkey")
        batch_op.alter_column("dispositioned_by_id", new_column_name="disposition_approved_by_id")
        batch_op.alter_column("disposition_rationale", new_column_name="disposition_notes")
        batch_op.alter_column("actual", new_column_name="is_condition")
        batch_op.alter_column("raised_step_id", new_column_name="step_execution_id")
        batch_op.drop_column("dispositioned_at")
        batch_op.drop_column("raised_by_id")
        batch_op.drop_column("containment_step_id")
        batch_op.drop_column("containment")

    op.create_index("ix_issue_step_execution_id", "issue", ["step_execution_id"])
