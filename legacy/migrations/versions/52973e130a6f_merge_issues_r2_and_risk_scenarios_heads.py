"""merge issues r2 and risk scenarios heads

Revision ID: 52973e130a6f
Revises: a7b9c1d3e5f7, a7c41d92e803
Create Date: 2026-06-12 12:27:17.477587

"""

from collections.abc import Sequence

# revision identifiers, used by Alembic.
revision: str = "52973e130a6f"
down_revision: str | Sequence[str] | None = ("a7b9c1d3e5f7", "a7c41d92e803")
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None


def upgrade() -> None:
    pass


def downgrade() -> None:
    pass
