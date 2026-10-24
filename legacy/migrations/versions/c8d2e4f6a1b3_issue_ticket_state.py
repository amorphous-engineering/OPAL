"""issue ticket state stamps

Revision ID: c8d2e4f6a1b3
Revises: b7e41c0d9a52
Create Date: 2026-10-23 09:00:00.000000

Who and when for starting work, requesting review and closing. The ticket
state itself is derived (Issue.ticket_state). Closed issues get closed_at from
updated_at; the closer is unknown.
"""

from collections.abc import Sequence

import sqlalchemy as sa
from alembic import op

revision: str = "c8d2e4f6a1b3"
down_revision: str | None = "b7e41c0d9a52"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None


def upgrade() -> None:
    with op.batch_alter_table("issue") as batch:
        for stamp in ("work_started", "review_requested", "closed"):
            batch.add_column(sa.Column(f"{stamp}_at", sa.DateTime(timezone=True), nullable=True))
            batch.add_column(sa.Column(f"{stamp}_by_id", sa.Integer(), nullable=True))
            batch.create_foreign_key(
                f"fk_issue_{stamp}_by_id_user",
                "user",
                [f"{stamp}_by_id"],
                ["id"],
                ondelete="SET NULL",
            )
    issue = sa.table(
        "issue",
        sa.column("status", sa.String),
        sa.column("closed_at", sa.DateTime(timezone=True)),
        sa.column("updated_at", sa.DateTime(timezone=True)),
    )
    op.execute(
        issue.update().where(issue.c.status == "closed").values(closed_at=issue.c.updated_at)
    )


def downgrade() -> None:
    with op.batch_alter_table("issue") as batch:
        for stamp in ("work_started", "review_requested", "closed"):
            batch.drop_constraint(f"fk_issue_{stamp}_by_id_user", type_="foreignkey")
            batch.drop_column(f"{stamp}_by_id")
            batch.drop_column(f"{stamp}_at")
