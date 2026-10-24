"""sign-off slots and note files

Revision ID: b7e41c0d9a52
Revises: a4c8e1d97b32
Create Date: 2026-10-23 12:00:00.000000

A step's sign-offs become an ordered list of slots: ``procedure_step.signoffs``
(template definition), ``step_execution.signoffs`` (ad-hoc redline rows), and
one ``step_signoff`` row per signature. ``attachment.step_note_id`` links files
to execution notes.

The backfill turns the legacy completed_by/at and signed_off_by/at columns into
step_signoff rows so existing work orders read the same under the new model.
"""

from collections.abc import Sequence
from datetime import UTC, datetime
from typing import Any

import sqlalchemy as sa
from alembic import op

# revision identifiers, used by Alembic.
revision: str = "b7e41c0d9a52"
down_revision: str | None = "a4c8e1d97b32"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None


def _effective(step: dict[str, Any], has_children: bool) -> list[dict[str, Any]]:
    """Frozen copy of opal.core.signoffs.effective_signoffs (a migration must not
    follow later changes to application code)."""
    role = step.get("required_role")
    requires = bool(step.get("requires_signoff"))
    explicit = step.get("signoffs")
    if explicit is not None:
        slots = [{"label": s.get("label") or "", "role": s.get("role") or None} for s in explicit]
        if slots or has_children:
            return slots
        requires = False
    if has_children:
        return [{"label": "Sign-off", "role": role}] if requires else []
    slots = [{"label": "Primary buyoff", "role": role}]
    if requires:
        slots.append({"label": "Secondary buyoff", "role": None})
    return slots


def upgrade() -> None:
    with op.batch_alter_table("procedure_step", schema=None) as batch_op:
        batch_op.add_column(
            sa.Column(
                "signoffs",
                sa.JSON(),
                nullable=True,
                comment="[{label, role}] sign-off definitions; NULL = derive from requires_signoff/role",
            )
        )
    with op.batch_alter_table("step_execution", schema=None) as batch_op:
        batch_op.add_column(
            sa.Column(
                "signoffs",
                sa.JSON(),
                nullable=True,
                comment="Ad-hoc rows: [{label, role}] sign-off definitions; snapshot rows read the version",
            )
        )

    op.create_table(
        "step_signoff",
        sa.Column("id", sa.Integer(), nullable=False),
        sa.Column("created_at", sa.DateTime(timezone=True), nullable=False),
        sa.Column("updated_at", sa.DateTime(timezone=True), nullable=False),
        sa.Column("step_execution_id", sa.Integer(), nullable=False),
        sa.Column("slot", sa.Integer(), nullable=False),
        sa.Column("label", sa.String(length=100), nullable=False),
        sa.Column("role", sa.String(length=50), nullable=True),
        sa.Column("signed_by_id", sa.Integer(), nullable=True),
        sa.Column("signed_at", sa.DateTime(timezone=True), nullable=False),
        sa.ForeignKeyConstraint(["step_execution_id"], ["step_execution.id"], ondelete="CASCADE"),
        sa.ForeignKeyConstraint(["signed_by_id"], ["user.id"], ondelete="SET NULL"),
        sa.PrimaryKeyConstraint("id"),
        sa.UniqueConstraint("step_execution_id", "slot", name="uq_step_signoff_slot"),
    )
    op.create_index(
        op.f("ix_step_signoff_step_execution_id"), "step_signoff", ["step_execution_id"]
    )

    with op.batch_alter_table("attachment", schema=None) as batch_op:
        batch_op.add_column(
            sa.Column(
                "step_note_id",
                sa.Integer(),
                nullable=True,
                comment="Execution note this file is attached to (also carries step_execution_id)",
            )
        )
        batch_op.create_index(batch_op.f("ix_attachment_step_note_id"), ["step_note_id"])
        batch_op.create_foreign_key(
            "fk_attachment_step_note_id", "step_note", ["step_note_id"], ["id"], ondelete="CASCADE"
        )

    _backfill()


def _backfill() -> None:
    bind = op.get_bind()
    step_exec = sa.table(
        "step_execution",
        sa.column("id", sa.Integer),
        sa.column("instance_id", sa.Integer),
        sa.column("step_number", sa.Integer),
        sa.column("parent_step_order", sa.Integer),
        sa.column("status", sa.String),
        sa.column("completed_at", sa.DateTime),
        sa.column("completed_by_id", sa.Integer),
        sa.column("signed_off_at", sa.DateTime),
        sa.column("signed_off_by_id", sa.Integer),
        sa.column("ad_hoc_issue_id", sa.Integer),
        sa.column("requires_signoff", sa.Boolean),
        sa.column("created_at", sa.DateTime),
        sa.column("updated_at", sa.DateTime),
    )
    instance = sa.table(
        "procedure_instance", sa.column("id", sa.Integer), sa.column("version_id", sa.Integer)
    )
    version = sa.table(
        "procedure_version", sa.column("id", sa.Integer), sa.column("content", sa.JSON)
    )
    signoff = sa.table(
        "step_signoff",
        sa.column("created_at", sa.DateTime(timezone=True)),
        sa.column("updated_at", sa.DateTime(timezone=True)),
        sa.column("step_execution_id", sa.Integer),
        sa.column("slot", sa.Integer),
        sa.column("label", sa.String),
        sa.column("role", sa.String),
        sa.column("signed_by_id", sa.Integer),
        sa.column("signed_at", sa.DateTime(timezone=True)),
    )

    contents: dict[int, dict[int, dict[str, Any]]] = {}
    for vid, content in bind.execute(sa.select(version.c.id, version.c.content)):
        steps = content.get("steps", []) if isinstance(content, dict) else []
        contents[vid] = {s["order"]: s for s in steps if "order" in s}
    version_of = dict(bind.execute(sa.select(instance.c.id, instance.c.version_id)).all())

    rows = bind.execute(sa.select(step_exec)).all()
    has_parent = {
        (r.instance_id, r.parent_step_order) for r in rows if r.parent_step_order is not None
    }

    now = datetime.now(UTC)
    records: list[dict[str, Any]] = []
    for r in rows:
        if r.status not in ("completed", "awaiting_signoff", "signed_off"):
            continue
        has_children = (r.instance_id, r.step_number) in has_parent
        if has_children and r.status == "awaiting_signoff":
            continue  # an OP waiting for its first signature has signed nothing yet
        if r.ad_hoc_issue_id is not None:
            step: dict[str, Any] = {"requires_signoff": bool(r.requires_signoff)}
        else:
            step = dict(contents.get(version_of.get(r.instance_id), {}).get(r.step_number, {}))
            if r.requires_signoff:
                step["requires_signoff"] = True
        slots = _effective(step, has_children)
        if not slots:
            continue

        fallback = r.completed_at or r.updated_at or r.created_at or now
        if has_children:
            # An OP's signed-off state is its slot 0.
            first = (r.signed_off_by_id or r.completed_by_id, r.signed_off_at or fallback)
            later = first
        else:
            # A leaf's slot 0 is the old COMPLETE; later slots are the old SIGN OFF.
            first = (r.completed_by_id, r.completed_at or fallback)
            later = (r.signed_off_by_id or r.completed_by_id, r.signed_off_at or fallback)

        # awaiting_signoff: only slot 0 is signed; otherwise the step is terminal
        # and every slot reads as signed.
        count = 1 if r.status == "awaiting_signoff" else len(slots)
        for n in range(count):
            by, at = first if n == 0 else later
            records.append(
                {
                    "created_at": now,
                    "updated_at": now,
                    "step_execution_id": r.id,
                    "slot": n,
                    "label": slots[n]["label"] or "Sign-off",
                    "role": slots[n]["role"],
                    "signed_by_id": by,
                    "signed_at": at,
                }
            )
    if records:
        op.bulk_insert(signoff, records)


def downgrade() -> None:
    with op.batch_alter_table("attachment", schema=None) as batch_op:
        batch_op.drop_constraint("fk_attachment_step_note_id", type_="foreignkey")
        batch_op.drop_index(batch_op.f("ix_attachment_step_note_id"))
        batch_op.drop_column("step_note_id")

    op.drop_index(op.f("ix_step_signoff_step_execution_id"), table_name="step_signoff")
    op.drop_table("step_signoff")

    with op.batch_alter_table("step_execution", schema=None) as batch_op:
        batch_op.drop_column("signoffs")
    with op.batch_alter_table("procedure_step", schema=None) as batch_op:
        batch_op.drop_column("signoffs")
