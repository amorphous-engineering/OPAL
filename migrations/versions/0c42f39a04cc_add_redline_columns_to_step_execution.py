"""Add redline columns to step_execution

Revision ID: 0c42f39a04cc
Revises: a310ab9da1d8
Create Date: 2026-05-17 13:05:13.701782

"""

from typing import Sequence, Union

import sqlalchemy as sa
from alembic import op

# revision identifiers, used by Alembic.
revision: str = "0c42f39a04cc"
down_revision: Union[str, None] = "a310ab9da1d8"
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    with op.batch_alter_table("step_execution", schema=None) as batch_op:
        batch_op.add_column(
            sa.Column(
                "ad_hoc_issue_id",
                sa.Integer(),
                nullable=True,
                comment="Issue (NC) that authorized this redline",
            )
        )
        batch_op.add_column(
            sa.Column(
                "ad_hoc_host_order",
                sa.Integer(),
                nullable=True,
                comment="Snapshot step_number of the host op being gated",
            )
        )
        batch_op.add_column(
            sa.Column(
                "title",
                sa.String(length=255),
                nullable=True,
                comment="Used by ad-hoc rows; snapshot rows load from version",
            )
        )
        batch_op.add_column(
            sa.Column("instructions", sa.Text(), nullable=True, comment="Markdown"))
        batch_op.add_column(
            sa.Column(
                "required_data_schema",
                sa.JSON(),
                nullable=True,
                comment="Same shape as procedure_step.required_data_schema",
            )
        )
        batch_op.add_column(
            sa.Column(
                "requires_signoff",
                sa.Boolean(),
                nullable=False,
                server_default=sa.false(),
                comment="Ad-hoc sign-off flag",
            )
        )
        batch_op.create_index(
            "ix_step_execution_ad_hoc_issue_id", ["ad_hoc_issue_id"], unique=False
        )
        batch_op.create_foreign_key(
            "fk_step_execution_ad_hoc_issue_id",
            "issue",
            ["ad_hoc_issue_id"],
            ["id"],
            ondelete="SET NULL",
        )


def downgrade() -> None:
    with op.batch_alter_table("step_execution", schema=None) as batch_op:
        batch_op.drop_constraint("fk_step_execution_ad_hoc_issue_id", type_="foreignkey")
        batch_op.drop_index("ix_step_execution_ad_hoc_issue_id")
        batch_op.drop_column("requires_signoff")
        batch_op.drop_column("required_data_schema")
        batch_op.drop_column("instructions")
        batch_op.drop_column("title")
        batch_op.drop_column("ad_hoc_host_order")
        batch_op.drop_column("ad_hoc_issue_id")
