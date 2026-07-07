"""Startup guard: refuse to migrate a database stamped with an unknown revision.

A database whose alembic_version head was written by a different branch must
produce a short actionable error before any migration runs — never a raw
alembic ResolutionError traceback, and never a silent cross-branch upgrade.
"""

from pathlib import Path

import pytest
from sqlalchemy import Column, MetaData, String, Table, create_engine, event
from sqlalchemy.engine import Engine

from opal.db.base import UnknownDatabaseRevisionError, init_database


@pytest.fixture(autouse=True, scope="module")
def fast_sqlite():
    """Disable fsync for the file-backed databases these tests create.

    Same rationale as tests/integration/test_lifecycle.py: schema creation on
    a fresh SQLite file is fsync-bound and durability is irrelevant under
    tmp_path.
    """

    @event.listens_for(Engine, "connect")
    def _no_fsync(dbapi_conn, _record):
        cursor = dbapi_conn.cursor()
        cursor.execute("PRAGMA synchronous=OFF")
        cursor.close()

    yield
    event.remove(Engine, "connect", _no_fsync)


# Not (and never to be) a real revision in migrations/versions/. Note the
# revision quoted in issue #50, a7b9c1d3e5f7, has since merged into devel and
# is therefore useless as a bogus id.
BOGUS_REVISION = "deadbeef0bad"


def _make_engine(db_path: Path) -> Engine:
    return create_engine(f"sqlite:///{db_path}", connect_args={"check_same_thread": False})


def _stamp_revision(engine: Engine, revision: str) -> None:
    """Create an alembic_version table stamped with the given revision."""
    metadata = MetaData()
    version_table = Table(
        "alembic_version",
        metadata,
        Column("version_num", String(32), primary_key=True),
    )
    metadata.create_all(engine)
    with engine.begin() as conn:
        conn.execute(version_table.insert().values(version_num=revision))


def test_unknown_revision_raises_clean_error(tmp_path: Path) -> None:
    """A DB stamped with a revision this checkout lacks is refused, untouched."""
    db_path = tmp_path / "opal.db"
    engine = _make_engine(db_path)
    try:
        _stamp_revision(engine, BOGUS_REVISION)

        with pytest.raises(UnknownDatabaseRevisionError) as excinfo:
            init_database(engine)

        message = str(excinfo.value)
        # The error names the database path, the offending revision, and remedies.
        assert str(db_path) in message
        assert BOGUS_REVISION in message
        assert "migrations/versions/" in message
        assert "rebase onto devel" in message
        assert "OPAL_DATA_DIR=$(mktemp -d)" in message
    finally:
        engine.dispose()


def test_unknown_revision_error_names_database_url_env(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    """When OPAL_DATABASE_URL selected the DB, the error says so."""
    db_path = tmp_path / "opal.db"
    engine = _make_engine(db_path)
    try:
        monkeypatch.setenv("OPAL_DATABASE_URL", str(engine.url))
        _stamp_revision(engine, BOGUS_REVISION)

        with pytest.raises(UnknownDatabaseRevisionError) as excinfo:
            init_database(engine)

        assert "selected by OPAL_DATABASE_URL" in str(excinfo.value)
    finally:
        engine.dispose()


def test_known_revision_passes_guard(tmp_path: Path) -> None:
    """A DB stamped at this checkout's head migrates (no-op) without error."""
    db_path = tmp_path / "opal.db"
    engine = _make_engine(db_path)
    try:
        # First call: fresh DB — create_all + stamp head.
        init_database(engine)
        # Second call: existing DB — guard reads the stamped head, finds it in
        # the script directory, and alembic upgrade runs (a no-op at head).
        init_database(engine)
    finally:
        engine.dispose()


def test_unstamped_database_passes_guard(tmp_path: Path) -> None:
    """An alembic_version table with no rows does not trip the guard."""
    db_path = tmp_path / "opal.db"
    engine = _make_engine(db_path)
    try:
        metadata = MetaData()
        Table(
            "alembic_version",
            metadata,
            Column("version_num", String(32), primary_key=True),
        )
        metadata.create_all(engine)

        from opal.db.base import _ensure_stamped_revisions_known, _get_alembic_config

        cfg = _get_alembic_config(engine)
        _ensure_stamped_revisions_known(engine, cfg)  # must not raise
    finally:
        engine.dispose()
