"""add supplier_part vendor pns

Revision ID: c4d5e6f7a8b9
Revises: b3f1c2a9d4e7
Create Date: 2026-06-09 17:00:00.000000

"""

from typing import Sequence, Union

import sqlalchemy as sa
from alembic import op

# revision identifiers, used by Alembic.
revision: str = "c4d5e6f7a8b9"
down_revision: Union[str, None] = "b3f1c2a9d4e7"
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    op.create_table(
        "supplier_part",
        sa.Column("id", sa.Integer(), autoincrement=True, nullable=False),
        sa.Column("supplier_id", sa.Integer(), nullable=False),
        sa.Column("part_id", sa.Integer(), nullable=False),
        sa.Column("vendor_pn", sa.String(length=255), nullable=False),
        sa.Column("is_preferred", sa.Boolean(), nullable=False),
        sa.Column("notes", sa.Text(), nullable=True),
        sa.Column("created_at", sa.DateTime(timezone=True), nullable=False),
        sa.Column("updated_at", sa.DateTime(timezone=True), nullable=False),
        sa.ForeignKeyConstraint(["part_id"], ["part.id"], ondelete="CASCADE"),
        sa.ForeignKeyConstraint(["supplier_id"], ["supplier.id"], ondelete="CASCADE"),
        sa.PrimaryKeyConstraint("id"),
        sa.UniqueConstraint("supplier_id", "part_id", name="uq_supplier_part"),
    )
    op.create_index(op.f("ix_supplier_part_part_id"), "supplier_part", ["part_id"], unique=False)
    op.create_index(
        op.f("ix_supplier_part_supplier_id"), "supplier_part", ["supplier_id"], unique=False
    )


def downgrade() -> None:
    op.drop_index(op.f("ix_supplier_part_supplier_id"), table_name="supplier_part")
    op.drop_index(op.f("ix_supplier_part_part_id"), table_name="supplier_part")
    op.drop_table("supplier_part")
