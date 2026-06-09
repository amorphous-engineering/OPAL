"""Add FTS5 search index tables and sync triggers

Revision ID: b3f2c1d4a5e6
Revises: 8a5444d1e3e6
Create Date: 2026-06-09

"""

from alembic import op

# revision identifiers, used by Alembic.
revision = "b3f2c1d4a5e6"
down_revision = "8a5444d1e3e6"
branch_labels = None
depends_on = None


def upgrade() -> None:
    from opal.db.fts import create_fts_schema

    create_fts_schema(op.get_bind())


def downgrade() -> None:
    from opal.db.fts import drop_fts_schema

    drop_fts_schema(op.get_bind())
