"""attachment purchase link

Revision ID: a4c8e1d97b32
Revises: f3a9d2c8b501
Create Date: 2026-10-22 09:00:00.000000

Purchase orders carry their quotes, invoices and packing slips as attachments.
"""

from collections.abc import Sequence

import sqlalchemy as sa
from alembic import op

# revision identifiers, used by Alembic.
revision: str = "a4c8e1d97b32"
down_revision: str | None = "f3a9d2c8b501"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None


def upgrade() -> None:
    with op.batch_alter_table("attachment", schema=None) as batch_op:
        batch_op.add_column(
            sa.Column(
                "purchase_id",
                sa.Integer(),
                nullable=True,
                comment="Purchase order the file belongs to (quote, invoice, packing slip)",
            )
        )
        batch_op.create_index(batch_op.f("ix_attachment_purchase_id"), ["purchase_id"], unique=False)
        batch_op.create_foreign_key(
            "fk_attachment_purchase_id", "purchase", ["purchase_id"], ["id"], ondelete="CASCADE"
        )


def downgrade() -> None:
    with op.batch_alter_table("attachment", schema=None) as batch_op:
        batch_op.drop_constraint("fk_attachment_purchase_id", type_="foreignkey")
        batch_op.drop_index(batch_op.f("ix_attachment_purchase_id"))
        batch_op.drop_column("purchase_id")
