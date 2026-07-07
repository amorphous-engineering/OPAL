"""Backfill test for migration c7a2e9d41f88 (step notes).

Runs the real alembic chain against a throwaway file DB: upgrade to the
revision just before the step-note migration, plant legacy notes blobs on
step_execution rows, then upgrade to head and assert each non-empty blob
became exactly one step_note row (author NULL, created_at = completed_at
when present) and the old column is gone. FK enforcement is off in the raw
sqlite3 connection, so bare rows suffice.

In-process alembic with PRAGMA synchronous=OFF — the 49-revision chain is
fsync-bound as a subprocess (minutes vs seconds; see test_lifecycle).
"""

import sqlite3
from pathlib import Path

from alembic import command
from sqlalchemy import create_engine, event

from opal.db.base import _get_alembic_config

REPO_ROOT = Path(__file__).resolve().parents[2]
PREV_REV = "894e35219894"  # head before c7a2e9d41f88

COMPLETED_AT = "2026-01-02 03:04:05.000000"


def _alembic(db_path: Path, action: str, revision: str) -> None:
    engine = create_engine(f"sqlite:///{db_path}")

    @event.listens_for(engine, "connect")
    def _no_fsync(dbapi_conn, _record):
        cursor = dbapi_conn.cursor()
        cursor.execute("PRAGMA synchronous=OFF")
        cursor.close()

    try:
        cfg = _get_alembic_config(engine)
        with engine.begin() as conn:
            cfg.attributes["connection"] = conn
            getattr(command, action)(cfg, revision)
    finally:
        engine.dispose()


def _insert_step(conn: sqlite3.Connection, **overrides: object) -> None:
    """Insert a step_execution row, filling any NOT NULL column generically
    so the test does not break when unrelated columns appear."""
    row: dict[str, object] = {}
    for _cid, name, ctype, notnull, dflt, pk in conn.execute(
        "PRAGMA table_info(step_execution)"
    ).fetchall():
        if pk or name in overrides or not notnull or dflt is not None:
            continue
        upper = (ctype or "").upper()
        if "INT" in upper or "BOOL" in upper or "NUM" in upper:
            row[name] = 0
        elif "DATE" in upper or "TIME" in upper:
            row[name] = COMPLETED_AT
        else:
            row[name] = "x"
    row.update({k: v for k, v in overrides.items()})
    cols = ", ".join(row)
    marks = ", ".join("?" for _ in row)
    conn.execute(f"INSERT INTO step_execution ({cols}) VALUES ({marks})", list(row.values()))


def test_step_note_backfill_and_column_drop(tmp_path):
    db = tmp_path / "mig.db"
    _alembic(db, "upgrade", PREV_REV)

    conn = sqlite3.connect(db)
    common = {
        "instance_id": 1,
        "status": "completed",
        "step_number_str": "1",
        "level": 0,
        "created_at": COMPLETED_AT,
        "updated_at": COMPLETED_AT,
    }
    # Completed step with a blob: created_at must adopt completed_at.
    _insert_step(
        conn,
        **{**common, "step_number": 1, "notes": "legacy blob", "completed_at": COMPLETED_AT},
    )
    # Unfinished step with a blob: created_at falls back to the migration moment.
    _insert_step(
        conn,
        **{
            **common,
            "step_number": 2,
            "status": "pending",
            "notes": "pending note",
            "completed_at": None,
        },
    )
    # Whitespace-only and NULL blobs: no note rows.
    _insert_step(
        conn, **{**common, "step_number": 3, "notes": "   ", "completed_at": COMPLETED_AT}
    )
    _insert_step(
        conn, **{**common, "step_number": 4, "notes": None, "completed_at": COMPLETED_AT}
    )
    conn.commit()
    conn.close()

    _alembic(db, "upgrade", "head")

    conn = sqlite3.connect(db)
    rows = conn.execute(
        "SELECT se.step_number, n.author_id, n.body, n.created_at "
        "FROM step_note n JOIN step_execution se ON se.id = n.step_execution_id "
        "ORDER BY n.id"
    ).fetchall()
    assert [(r[0], r[1], r[2]) for r in rows] == [
        (1, None, "legacy blob"),
        (2, None, "pending note"),
    ]
    assert rows[0][3] == COMPLETED_AT  # completed step: note dated at completion
    assert rows[1][3] and rows[1][3] != COMPLETED_AT  # pending: the migration moment

    # One home: the blob column is gone.
    columns = [r[1] for r in conn.execute("PRAGMA table_info(step_execution)").fetchall()]
    assert "notes" not in columns
    conn.close()

    # Downgrade restores the blob (best-effort concatenation).
    _alembic(db, "downgrade", PREV_REV)
    conn = sqlite3.connect(db)
    notes = dict(
        conn.execute("SELECT step_number, notes FROM step_execution ORDER BY step_number")
    )
    assert notes[1] == "legacy blob"
    assert notes[2] == "pending note"
    assert notes[3] is None and notes[4] is None
    conn.close()
