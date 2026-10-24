"""system roles and permission gates

Revision ID: e6b8d4f2a903
Revises: d5a7c3e91f40
Create Date: 2026-10-23 18:00:00.000000

``role`` gains ``key`` (unique, nullable) and ``is_system``; ``role_gate`` maps
roles to the gates they pass (``issue.disposition``, ``issue.approve``).

Backfill: the four system roles (Engineer, Technician, Quality, Admin) are
created; a role of the same name (any casing, soft-deleted included) is
converted in place and keeps its id and grants. Default gates are mapped
(engineer -> issue.disposition, quality -> issue.approve) and Engineer and
Quality are granted to every active user so nobody loses the ability to
disposition or approve on upgrade; admins prune afterwards. The Admin role is
never granted: its membership is ``user.is_admin``.
"""

from collections.abc import Sequence
from datetime import UTC, datetime

import sqlalchemy as sa
from alembic import op

# revision identifiers, used by Alembic.
revision: str = "e6b8d4f2a903"
down_revision: str | None = "d5a7c3e91f40"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None

# key, name, description, default gates, granted to every active user
SYSTEM_ROLES = [
    (
        "engineer",
        "Engineer",
        "Dispositions issue tickets and verifies engineering-critical steps.",
        ["issue.disposition"],
        True,
    ),
    ("technician", "Technician", "Performs build and assembly steps.", [], False),
    (
        "quality",
        "Quality",
        "Approves issue resolutions and buys off quality-critical steps.",
        ["issue.approve"],
        True,
    ),
    ("admin", "Admin", "Administers the application and passes every gate.", [], False),
]


def _name_column() -> list[sa.Column]:
    """SQLite reflection loses the NOCASE collation; a table rebuild must keep it,
    or role names would silently become case-sensitive."""
    return [sa.Column("name", sa.String(length=50, collation="NOCASE"), nullable=False)]


def upgrade() -> None:
    with op.batch_alter_table("role", schema=None, reflect_args=_name_column()) as batch_op:
        batch_op.add_column(
            sa.Column(
                "key",
                sa.String(length=30),
                nullable=True,
                comment="Stable identifier of a system role (engineer, technician, quality, admin)",
            )
        )
        batch_op.add_column(
            sa.Column("is_system", sa.Boolean(), nullable=False, server_default="0")
        )
        batch_op.create_unique_constraint("uq_role_key", ["key"])
    op.create_table(
        "role_gate",
        sa.Column("id", sa.Integer(), nullable=False),
        sa.Column("role_id", sa.Integer(), nullable=False),
        sa.Column("gate", sa.String(length=50), nullable=False),
        sa.ForeignKeyConstraint(["role_id"], ["role.id"], ondelete="CASCADE"),
        sa.PrimaryKeyConstraint("id"),
        sa.UniqueConstraint("role_id", "gate", name="uq_role_gate"),
    )
    op.create_index(op.f("ix_role_gate_role_id"), "role_gate", ["role_id"])
    _backfill()


def _backfill() -> None:
    bind = op.get_bind()
    role = sa.table(
        "role",
        sa.column("id", sa.Integer),
        sa.column("name", sa.String),
        sa.column("description", sa.Text),
        sa.column("key", sa.String),
        sa.column("is_system", sa.Boolean),
        sa.column("deleted_at", sa.DateTime(timezone=True)),
        sa.column("created_at", sa.DateTime(timezone=True)),
        sa.column("updated_at", sa.DateTime(timezone=True)),
    )
    role_gate = sa.table(
        "role_gate", sa.column("role_id", sa.Integer), sa.column("gate", sa.String)
    )
    user = sa.table("user", sa.column("id", sa.Integer), sa.column("is_active", sa.Boolean))
    user_role = sa.table(
        "user_role",
        sa.column("user_id", sa.Integer),
        sa.column("role_id", sa.Integer),
        sa.column("granted_at", sa.DateTime(timezone=True)),
    )
    now = datetime.now(UTC)
    active = [u for (u,) in bind.execute(sa.select(user.c.id).where(user.c.is_active.is_(True)))]

    for key, name, description, gates, grant_all in SYSTEM_ROLES:
        # role.name is NOCASE, so this matches any casing.
        row = bind.execute(
            sa.select(role.c.id, role.c.description).where(role.c.name == name)
        ).first()
        if row is None:
            bind.execute(
                sa.insert(role).values(
                    name=name,
                    description=description,
                    key=key,
                    is_system=True,
                    created_at=now,
                    updated_at=now,
                )
            )
            role_id = bind.execute(sa.select(role.c.id).where(role.c.key == key)).scalar_one()
        else:
            role_id = row[0]
            bind.execute(
                sa.update(role)
                .where(role.c.id == role_id)
                .values(
                    name=name,
                    key=key,
                    is_system=True,
                    deleted_at=None,
                    description=row[1] if (row[1] or "").strip() else description,
                    updated_at=now,
                )
            )
        for gate in gates:
            bind.execute(sa.insert(role_gate).values(role_id=role_id, gate=gate))
        if key == "admin":
            # Membership is the is_admin flag; a stray grant would mean nothing.
            bind.execute(sa.delete(user_role).where(user_role.c.role_id == role_id))
        elif grant_all and active:
            held = {
                u
                for (u,) in bind.execute(
                    sa.select(user_role.c.user_id).where(user_role.c.role_id == role_id)
                )
            }
            rows = [
                {"user_id": u, "role_id": role_id, "granted_at": now}
                for u in active
                if u not in held
            ]
            if rows:
                op.bulk_insert(user_role, rows)


def downgrade() -> None:
    bind = op.get_bind()
    role = sa.table("role", sa.column("id", sa.Integer), sa.column("key", sa.String))
    # The Admin role only means something through the is_admin flag; the other
    # system roles stay behind as ordinary roles with their grants.
    bind.execute(sa.delete(role).where(role.c.key == "admin"))
    op.drop_index(op.f("ix_role_gate_role_id"), table_name="role_gate")
    op.drop_table("role_gate")
    with op.batch_alter_table("role", schema=None, reflect_args=_name_column()) as batch_op:
        batch_op.drop_constraint("uq_role_key", type_="unique")
        batch_op.drop_column("is_system")
        batch_op.drop_column("key")
