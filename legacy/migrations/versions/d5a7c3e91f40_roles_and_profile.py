"""roles, user profile fields and avatars

Revision ID: d5a7c3e91f40
Revises: c8d2e4f6a1b3
Create Date: 2026-10-23 15:00:00.000000

Adds ``role`` (qualifications) and ``user_role`` (grants), and the profile and
avatar columns on ``user``.

Backfill: every distinct role name already used by a template step
(``signoffs`` JSON, ``required_role``), an ad-hoc execution row
(``step_execution.signoffs``) or a published version snapshot becomes a role,
and every active user is granted every one of them, so nothing that could be
signed before the upgrade becomes unsignable. Admins prune afterwards.
"""

from collections.abc import Iterable, Sequence
from datetime import UTC, datetime
from typing import Any

import sqlalchemy as sa
from alembic import op

# revision identifiers, used by Alembic.
revision: str = "d5a7c3e91f40"
down_revision: str | None = "c8d2e4f6a1b3"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None


def upgrade() -> None:
    op.create_table(
        "role",
        sa.Column("id", sa.Integer(), nullable=False),
        sa.Column("created_at", sa.DateTime(timezone=True), nullable=False),
        sa.Column("updated_at", sa.DateTime(timezone=True), nullable=False),
        sa.Column("deleted_at", sa.DateTime(timezone=True), nullable=True),
        sa.Column(
            "name",
            sa.String(length=50, collation="NOCASE"),
            nullable=False,
            comment="Unique case-insensitively; the canonical casing is what sign-offs show",
        ),
        sa.Column("description", sa.Text(), nullable=True),
        sa.PrimaryKeyConstraint("id"),
        sa.UniqueConstraint("name"),
    )
    op.create_table(
        "user_role",
        sa.Column("id", sa.Integer(), nullable=False),
        sa.Column("user_id", sa.Integer(), nullable=False),
        sa.Column("role_id", sa.Integer(), nullable=False),
        sa.Column("granted_by_id", sa.Integer(), nullable=True),
        sa.Column("granted_at", sa.DateTime(timezone=True), nullable=False),
        sa.ForeignKeyConstraint(["user_id"], ["user.id"], ondelete="CASCADE"),
        sa.ForeignKeyConstraint(["role_id"], ["role.id"], ondelete="CASCADE"),
        sa.ForeignKeyConstraint(["granted_by_id"], ["user.id"], ondelete="SET NULL"),
        sa.PrimaryKeyConstraint("id"),
        sa.UniqueConstraint("user_id", "role_id", name="uq_user_role"),
    )
    op.create_index(op.f("ix_user_role_user_id"), "user_role", ["user_id"])
    op.create_index(op.f("ix_user_role_role_id"), "user_role", ["role_id"])

    with op.batch_alter_table("user", schema=None) as batch_op:
        batch_op.add_column(sa.Column("job_title", sa.String(length=120), nullable=True))
        batch_op.add_column(sa.Column("phone", sa.String(length=40), nullable=True))
        batch_op.add_column(sa.Column("workcenter_id", sa.Integer(), nullable=True))
        batch_op.add_column(
            sa.Column(
                "avatar_filename",
                sa.String(length=255),
                nullable=True,
                comment="File under <upload_dir>/avatars",
            )
        )
        batch_op.add_column(sa.Column("avatar_mime", sa.String(length=50), nullable=True))
        batch_op.add_column(
            sa.Column(
                "avatar_source",
                sa.String(length=10),
                nullable=True,
                comment="upload | oidc | removed (removed: do not refill from the IdP) | NULL",
            )
        )
        batch_op.add_column(
            sa.Column("avatar_updated_at", sa.DateTime(timezone=True), nullable=True)
        )
        batch_op.create_foreign_key(
            "fk_user_workcenter_id", "workcenter", ["workcenter_id"], ["id"], ondelete="SET NULL"
        )

    _backfill()


def _slot_roles(signoffs: Any) -> Iterable[Any]:
    if isinstance(signoffs, list):
        for slot in signoffs:
            if isinstance(slot, dict):
                yield slot.get("role")


def _step_roles(step: Any) -> Iterable[Any]:
    if isinstance(step, dict):
        yield step.get("required_role")
        yield from _slot_roles(step.get("signoffs"))


def _backfill() -> None:
    bind = op.get_bind()
    procedure_step = sa.table(
        "procedure_step", sa.column("signoffs", sa.JSON), sa.column("required_role", sa.String)
    )
    step_execution = sa.table("step_execution", sa.column("signoffs", sa.JSON))
    version = sa.table("procedure_version", sa.column("content", sa.JSON))
    role = sa.table(
        "role",
        sa.column("id", sa.Integer),
        sa.column("name", sa.String),
        sa.column("created_at", sa.DateTime(timezone=True)),
        sa.column("updated_at", sa.DateTime(timezone=True)),
    )
    user = sa.table("user", sa.column("id", sa.Integer), sa.column("is_active", sa.Boolean))
    user_role = sa.table(
        "user_role",
        sa.column("user_id", sa.Integer),
        sa.column("role_id", sa.Integer),
        sa.column("granted_at", sa.DateTime(timezone=True)),
    )

    raw: list[Any] = []
    for signoffs, required in bind.execute(
        sa.select(procedure_step.c.signoffs, procedure_step.c.required_role)
    ):
        raw.append(required)
        raw.extend(_slot_roles(signoffs))
    for (signoffs,) in bind.execute(sa.select(step_execution.c.signoffs)):
        raw.extend(_slot_roles(signoffs))
    for (content,) in bind.execute(sa.select(version.c.content)):
        steps = content.get("steps", []) if isinstance(content, dict) else []
        for step in steps:
            raw.extend(_step_roles(step))

    # One role per distinct name, case-insensitively; first spelling seen wins.
    names: dict[str, str] = {}
    for value in raw:
        if not isinstance(value, str):
            continue
        name = value.strip()[:50]
        if name:
            names.setdefault(name.lower(), name)
    if not names:
        return

    now = datetime.now(UTC)
    op.bulk_insert(
        role, [{"name": n, "created_at": now, "updated_at": now} for n in names.values()]
    )
    role_ids = [r for (r,) in bind.execute(sa.select(role.c.id))]
    user_ids = [u for (u,) in bind.execute(sa.select(user.c.id).where(user.c.is_active.is_(True)))]
    if user_ids:
        op.bulk_insert(
            user_role,
            [{"user_id": u, "role_id": r, "granted_at": now} for u in user_ids for r in role_ids],
        )


def downgrade() -> None:
    with op.batch_alter_table("user", schema=None) as batch_op:
        batch_op.drop_constraint("fk_user_workcenter_id", type_="foreignkey")
        batch_op.drop_column("avatar_updated_at")
        batch_op.drop_column("avatar_source")
        batch_op.drop_column("avatar_mime")
        batch_op.drop_column("avatar_filename")
        batch_op.drop_column("workcenter_id")
        batch_op.drop_column("phone")
        batch_op.drop_column("job_title")
    op.drop_index(op.f("ix_user_role_role_id"), table_name="user_role")
    op.drop_index(op.f("ix_user_role_user_id"), table_name="user_role")
    op.drop_table("user_role")
    op.drop_table("role")
