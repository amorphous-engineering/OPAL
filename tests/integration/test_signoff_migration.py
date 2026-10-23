"""Backfill test for migration b7e41c0d9a52 (sign-off slots).

Runs the real alembic chain against a throwaway file DB: upgrade to the revision
just before, plant legacy executions (completed / awaiting / signed-off leaf
steps, a signed-off OP, a skipped and a pending step), upgrade to head and assert
each became the right step_signoff rows; then downgrade once.
"""

import json
import sqlite3
from pathlib import Path

from alembic import command
from sqlalchemy import create_engine, event

from opal.db.base import _get_alembic_config

PREV_REV = "a4c8e1d97b32"
STAMP = "2026-01-02 03:04:05.000000"
SIGNED = "2026-01-02 04:00:00.000000"


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


def _insert(conn: sqlite3.Connection, table: str, **values: object) -> None:
    """Insert a row, filling any other NOT NULL column generically."""
    row: dict[str, object] = {}
    for _cid, name, ctype, notnull, dflt, pk in conn.execute(
        f"PRAGMA table_info({table})"
    ).fetchall():
        if pk or name in values or not notnull or dflt is not None:
            continue
        upper = (ctype or "").upper()
        if "INT" in upper or "BOOL" in upper or "NUM" in upper:
            row[name] = 0
        elif "DATE" in upper or "TIME" in upper:
            row[name] = STAMP
        else:
            row[name] = "x"
    row.update(values)
    cols = ", ".join(row)
    marks = ", ".join("?" for _ in row)
    conn.execute(f"INSERT INTO {table} ({cols}) VALUES ({marks})", list(row.values()))


def test_signoff_backfill_and_downgrade(tmp_path):
    db = tmp_path / "mig.db"
    _alembic(db, "upgrade", PREV_REV)

    content = {
        "steps": [
            {"order": 1, "requires_signoff": True, "required_role": "QE"},  # OP, has children
            {"order": 2, "requires_signoff": True, "required_role": "Tech"},
            {"order": 3, "requires_signoff": False},
            {"order": 4, "requires_signoff": True},
            {"order": 5, "requires_signoff": False},
            {"order": 6, "requires_signoff": False},
        ]
    }
    conn = sqlite3.connect(db)
    _insert(
        conn,
        "procedure_version",
        id=1,
        procedure_id=1,
        version_number=1,
        content=json.dumps(content),
        created_at=STAMP,
        updated_at=STAMP,
    )
    _insert(
        conn,
        "procedure_instance",
        id=1,
        procedure_id=1,
        version_id=1,
        status="in_work",
        created_at=STAMP,
        updated_at=STAMP,
    )
    common = {
        "instance_id": 1,
        "step_number_str": "1",
        "created_at": STAMP,
        "updated_at": STAMP,
        "completed_at": STAMP,
    }

    def step(n: int, status: str, **extra: object) -> None:
        _insert(
            conn,
            "step_execution",
            id=n,
            step_number=n,
            status=status,
            level=extra.pop("level", 1),
            **{**common, **extra},
        )

    # An OP signed off by user 7 (its slot 0).
    step(1, "signed_off", level=0, completed_by_id=5, signed_off_by_id=7, signed_off_at=SIGNED)
    # Leaf needing sign-off, signed off: slot 0 = completer, slot 1 = signer.
    step(
        2,
        "signed_off",
        parent_step_order=1,
        completed_by_id=5,
        signed_off_by_id=6,
        signed_off_at=SIGNED,
    )
    # Plain completed leaf: slot 0 only.
    step(3, "completed", parent_step_order=1, completed_by_id=5)
    # Awaiting sign-off: slot 0 signed, slot 1 open.
    step(4, "awaiting_signoff", parent_step_order=1, completed_by_id=5)
    # Pending and skipped rows get nothing.
    step(5, "pending", parent_step_order=1, completed_at=None)
    step(6, "skipped", parent_step_order=1, completed_by_id=5)
    # Ad-hoc redline row with its own flag.
    step(
        7,
        "signed_off",
        completed_by_id=5,
        signed_off_by_id=6,
        requires_signoff=1,
        ad_hoc_issue_id=9,
    )
    conn.commit()
    conn.close()

    _alembic(db, "upgrade", "head")

    conn = sqlite3.connect(db)
    rows = conn.execute(
        "SELECT step_execution_id, slot, label, role, signed_by_id, signed_at "
        "FROM step_signoff ORDER BY step_execution_id, slot"
    ).fetchall()
    assert [(r[0], r[1], r[2], r[3], r[4]) for r in rows] == [
        (1, 0, "Sign-off", "QE", 7),
        (2, 0, "Primary buyoff", "Tech", 5),
        (2, 1, "Secondary buyoff", None, 6),
        (3, 0, "Primary buyoff", None, 5),
        (4, 0, "Primary buyoff", None, 5),
        (7, 0, "Primary buyoff", None, 5),
        (7, 1, "Secondary buyoff", None, 6),
    ]
    assert rows[0][5].startswith("2026-01-02 04:00")  # OP: signed_off_at
    assert rows[1][5].startswith("2026-01-02 03:04")  # leaf slot 0: completed_at
    assert rows[2][5].startswith("2026-01-02 04:00")  # leaf slot 1: signed_off_at

    for table in ("procedure_step", "step_execution"):
        cols = [r[1] for r in conn.execute(f"PRAGMA table_info({table})").fetchall()]
        assert "signoffs" in cols
    assert "step_note_id" in [r[1] for r in conn.execute("PRAGMA table_info(attachment)")]
    conn.close()

    _alembic(db, "downgrade", PREV_REV)
    conn = sqlite3.connect(db)
    tables = {r[0] for r in conn.execute("SELECT name FROM sqlite_master WHERE type='table'")}
    assert "step_signoff" not in tables
    cols = [r[1] for r in conn.execute("PRAGMA table_info(step_execution)").fetchall()]
    assert "signoffs" not in cols
    # Legacy columns were never touched.
    signer = conn.execute("SELECT signed_off_by_id FROM step_execution WHERE id = 2").fetchone()
    assert signer[0] == 6
    conn.close()
