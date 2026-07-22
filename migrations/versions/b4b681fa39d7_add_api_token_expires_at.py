"""add api_token.expires_at

Revision ID: b4b681fa39d7
Revises: d4e8b7a2c5f1
Create Date: 2026-07-22 15:01:18.259456

"""

from collections.abc import Sequence

import sqlalchemy as sa
from alembic import op

# revision identifiers, used by Alembic.
revision: str = "b4b681fa39d7"
down_revision: str | None = "d4e8b7a2c5f1"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None


def upgrade() -> None:
    # Optional per-token lifetime. NULL = never expires (prior behavior).
    with op.batch_alter_table("api_token", schema=None) as batch_op:
        batch_op.add_column(sa.Column("expires_at", sa.DateTime(timezone=True), nullable=True))


def downgrade() -> None:
    with op.batch_alter_table("api_token", schema=None) as batch_op:
        batch_op.drop_column("expires_at")
