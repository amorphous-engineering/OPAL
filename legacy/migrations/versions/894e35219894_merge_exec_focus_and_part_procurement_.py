"""merge exec focus and part procurement heads

Revision ID: 894e35219894
Revises: b3d1f0a2c4e6, b3c5d7e9f1a2
Create Date: 2026-06-12 14:33:14.188460

"""
from typing import Sequence, Union

from alembic import op
import sqlalchemy as sa


# revision identifiers, used by Alembic.
revision: str = '894e35219894'
down_revision: Union[str, None] = ('b3d1f0a2c4e6', 'b3c5d7e9f1a2')
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    pass


def downgrade() -> None:
    pass
