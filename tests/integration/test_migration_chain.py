"""Full alembic migration-chain smoke test from a foreign_keys=ON app engine.

Guards against the failure class from issue #43: SQLite batch migrations
recreate tables via copy/DROP/RENAME, and

- with PRAGMA foreign_keys=ON on the migration connection, the DROP fires
  ON DELETE CASCADE on every referencing table, silently emptying children
  (the historical `opal serve`/`opal init` path before the PR #42 fix);
- the recreate always drops the table's triggers, leaving FTS search
  indexes stale until something rebuilds them.

The unit suite builds its schema with create_all and structurally cannot
catch either failure. This test upgrades a real file DB through the full
chain one revision at a time via the production migration path
(`_run_alembic_upgrade`, which must run migrations on a plain FK-off
engine), while the *app* engine — used for seeding and row counts — has
foreign_keys=ON exactly like `get_engine()`. After every revision it seeds
one row into any still-empty table (where feasible) and asserts that no
previously seeded table lost rows; at head it asserts the complete FTS
schema is present and backfilled.

If anyone reattaches the foreign_keys pragma to the migration connection
(in `_run_alembic_upgrade` or migrations/env.py), the cascade fires again
and this test fails at the exact offending revision.
"""

from collections.abc import Iterator
from pathlib import Path
from typing import Any

import pytest
from alembic.script import ScriptDirectory
from sqlalchemy import create_engine, event
from sqlalchemy.engine import Connection, Engine

from opal.db.base import _get_alembic_config, _run_alembic_upgrade, init_database
from opal.db.fts import ENTITY_SPECS, missing_fts_objects

# FTS index tables and their FTS5 shadow tables (part_fts_data, ...) are
# maintained by triggers/SQLite, not seeded or counted like entity tables.
_FTS_TABLE_PREFIXES = tuple(spec.fts_table for spec in ENTITY_SPECS)


def _is_fts_table(name: str) -> bool:
    return name in _FTS_TABLE_PREFIXES or name.startswith(
        tuple(f"{t}_" for t in _FTS_TABLE_PREFIXES)
    )


def _user_tables(conn: Connection) -> list[str]:
    rows = conn.exec_driver_sql(
        "SELECT name FROM sqlite_master WHERE type='table' "
        "AND name NOT LIKE 'sqlite_%' AND name != 'alembic_version'"
    ).fetchall()
    return [r[0] for r in rows if not _is_fts_table(r[0])]


def _count(conn: Connection, table: str) -> int:
    return conn.exec_driver_sql(f'SELECT count(*) FROM "{table}"').scalar_one()


def _value_for(decltype: str) -> Any:
    """A plausible constant for a NOT NULL column of the given declared type."""
    d = (decltype or "").upper()
    if "INT" in d or "BOOL" in d:
        return 1
    if any(k in d for k in ("REAL", "FLOA", "DOUB")):
        return 1.0
    if "DATE" in d or "TIME" in d:
        return "2026-01-01 00:00:00.000000"
    if "JSON" in d:
        return "{}"
    if "BLOB" in d:
        return b""
    return "MIGSMOKE"


def _try_seed(conn: Connection, table: str) -> bool:
    """Insert one minimal row, satisfying NOT NULL and FK constraints.

    Returns False when the table cannot be seeded yet (e.g. a NOT NULL FK
    whose parent is still empty) — callers simply retry after the next
    revision. Best-effort by design: unseedable tables are skipped, not
    failed, since the assertions only need rows to exist in parents and
    CASCADE children.
    """
    columns = conn.exec_driver_sql(f'PRAGMA table_info("{table}")').fetchall()
    fks: dict[str, tuple[str, str]] = {}
    for fk in conn.exec_driver_sql(f'PRAGMA foreign_key_list("{table}")').fetchall():
        # (id, seq, table, from, to, on_update, on_delete, match)
        fks[fk[3]] = (fk[2], fk[4] or "id")

    names: list[str] = []
    values: list[Any] = []
    for _cid, name, decltype, notnull, default, pk in columns:
        if pk and "INT" in (decltype or "").upper():
            continue  # rowid alias, autoincrements
        if not (notnull or pk) or default is not None:
            continue
        if name in fks:
            parent, parent_col = fks[name]
            if parent == table:
                return False  # self-referential NOT NULL FK: unseedable
            row = conn.exec_driver_sql(f'SELECT "{parent_col}" FROM "{parent}" LIMIT 1').fetchone()
            if row is None:
                return False  # parent still empty; retry after next revision
            values.append(row[0])
        else:
            values.append(_value_for(decltype))
        names.append(name)

    try:
        if names:
            cols = ", ".join(f'"{n}"' for n in names)
            marks = ", ".join("?" for _ in names)
            conn.exec_driver_sql(f'INSERT INTO "{table}" ({cols}) VALUES ({marks})', tuple(values))
        else:
            conn.exec_driver_sql(f'INSERT INTO "{table}" DEFAULT VALUES')
    except Exception:
        return False  # CHECK/unique constraint we can't satisfy generically
    return True


@pytest.fixture(autouse=True)
def fast_sqlite() -> Iterator[None]:
    """Disable fsync for every engine, including the internal migration engine.

    Durability is irrelevant under tmp_path; with default PRAGMA synchronous
    the 40+-revision chain is fsync-bound (minutes instead of seconds on slow
    disks). Class-level listener because `_run_alembic_upgrade` creates its
    own plain engine internally.
    """

    @event.listens_for(Engine, "connect")
    def _no_fsync(dbapi_conn: Any, _record: Any) -> None:
        cursor = dbapi_conn.cursor()
        cursor.execute("PRAGMA synchronous=OFF")
        cursor.close()

    yield
    event.remove(Engine, "connect", _no_fsync)


@pytest.fixture
def fk_on_engine(tmp_path: Path) -> Engine:
    """File-backed app engine with foreign_keys=ON, like get_engine()."""
    engine = create_engine(f"sqlite:///{tmp_path / 'chain.db'}")

    @event.listens_for(engine, "connect")
    def _pragma(dbapi_conn: Any, _record: Any) -> None:
        cursor = dbapi_conn.cursor()
        cursor.execute("PRAGMA foreign_keys=ON")
        cursor.close()

    return engine


def test_full_chain_from_fk_on_engine_preserves_rows_and_fts(fk_on_engine: Engine) -> None:
    script = ScriptDirectory.from_config(_get_alembic_config(fk_on_engine))
    revisions = [rev.revision for rev in script.walk_revisions("base", "heads")]
    revisions.reverse()  # oldest first
    assert len(revisions) > 40  # sanity: the whole chain, not a stub

    expected: dict[str, int] = {}
    for revision in revisions:
        # Production migration path: must internally run on a plain FK-off
        # engine (alembic's documented batch-mode requirement).
        _run_alembic_upgrade(fk_on_engine, revision)

        with fk_on_engine.begin() as conn:
            tables = _user_tables(conn)
            # No previously seeded table may lose rows: a loss here means the
            # batch recreate at `revision` cascade-deleted referencing rows.
            lost = {
                t: (n, _count(conn, t))
                for t, n in expected.items()
                if t in tables and _count(conn, t) < n
            }
            assert not lost, f"rows lost upgrading to {revision}: {lost}"

            # Seed still-empty tables so later recreates have children to lose.
            for t in tables:
                if _count(conn, t) == 0:
                    _try_seed(conn, t)
            expected = {t: _count(conn, t) for t in tables}

    # The startup entry point (no-op upgrade + FTS integrity check) must
    # leave a complete, backfilled FTS schema even though intermediate batch
    # recreates dropped sync triggers along the way.
    init_database(fk_on_engine)
    with fk_on_engine.begin() as conn:
        assert missing_fts_objects(conn) == []
        # Backfilled, not just present: the seeded part row must be indexed.
        # (External-content FTS5 requires MATCH; bare scans read the content
        # table, whose columns don't exist under the FTS names.)
        hits = conn.exec_driver_sql(
            "SELECT count(*) FROM part_fts WHERE part_fts MATCH '\"migsmoke\"'"
        ).scalar_one()
        assert hits >= 1
