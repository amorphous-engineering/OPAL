"""replace exe auth with oidc

Drops the exe-proxy identity column and adds the OpenID Connect identity link.
Identity is (oidc_issuer, oidc_subject); the subject alone carries the unique
constraint because one OPAL instance federates with one issuer.

The old ``auth_mode`` app_setting row is removed: the mode switch is gone,
replaced by independent ``password_login_enabled`` / ``oidc_enabled`` flags.
An instance that was running in exe mode falls back to password login, which
is the only recoverable default — its users must be re-linked through OIDC or
given passwords.

Revision ID: e7a1c93f2b48
Revises: c1a2b3d4e5f6
Create Date: 2026-08-16

"""

from collections.abc import Sequence

import sqlalchemy as sa
from alembic import op

revision: str = "e7a1c93f2b48"
down_revision: str | None = "c1a2b3d4e5f6"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None


def upgrade() -> None:
    with op.batch_alter_table("user", schema=None) as batch_op:
        batch_op.add_column(sa.Column("oidc_subject", sa.String(length=255), nullable=True))
        batch_op.add_column(sa.Column("oidc_issuer", sa.String(length=255), nullable=True))
        batch_op.create_unique_constraint("uq_user_oidc_subject", ["oidc_subject"])
        batch_op.create_index("ix_user_oidc_subject", ["oidc_subject"], unique=False)
        batch_op.drop_constraint("uq_user_exe_user_id", type_="unique")
        batch_op.drop_column("exe_user_id")

    op.execute(sa.text("DELETE FROM app_setting WHERE key IN ('auth_mode', 'exe_proxy_secret')"))


def downgrade() -> None:
    with op.batch_alter_table("user", schema=None) as batch_op:
        batch_op.add_column(sa.Column("exe_user_id", sa.String(length=255), nullable=True))
        batch_op.create_unique_constraint("uq_user_exe_user_id", ["exe_user_id"])
        batch_op.drop_index("ix_user_oidc_subject")
        batch_op.drop_constraint("uq_user_oidc_subject", type_="unique")
        batch_op.drop_column("oidc_issuer")
        batch_op.drop_column("oidc_subject")
