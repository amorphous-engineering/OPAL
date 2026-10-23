"""Backfill test for migration d5a7c3e91f40 (roles, profile fields, avatars).

Runs the real alembic chain against a throwaway file DB: upgrade to the revision
just before, plant role names in every place a sign-off can name one (template
step JSON and legacy column, an ad-hoc execution row, a published snapshot),
plus active and deactivated users; upgrade to head and assert each distinct name
(case-insensitively) became one role granted to every active user and only to
them; then downgrade and upgrade again.
"""

import json
import sqlite3
from pathlib import Path

from alembic import command
from sqlalchemy import create_engine, event

from opal.db.base import _get_alembic_config

PREV_REV = "c8d2e4f6a1b3"
STAMP = "2026-01-02 03:04:05.000000"


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
    cols = ", ".join(f'"{c}"' for c in row)
    marks = ", ".join("?" for _ in row)
    conn.execute(f'INSERT INTO "{table}" ({cols}) VALUES ({marks})', list(row.values()))


def _tables(conn: sqlite3.Connection) -> set[str]:
    return {r[0] for r in conn.execute("SELECT name FROM sqlite_master WHERE type='table'")}


def test_roles_backfill_grants_every_used_name_to_every_active_user(tmp_path):
    db = tmp_path / "mig.db"
    _alembic(db, "upgrade", PREV_REV)

    conn = sqlite3.connect(db)
    for uid, name, active in ((1, "Ada", 1), (2, "Bo", 1), (3, "Gone", 0)):
        _insert(
            conn,
            "user",
            id=uid,
            name=name,
            username=name.lower(),
            is_active=active,
            created_at=STAMP,
            updated_at=STAMP,
        )

    # Template steps: explicit slots, a legacy column, and a case variant.
    _insert(
        conn,
        "procedure_step",
        id=1,
        procedure_id=1,
        title="A",
        signoffs=json.dumps([{"label": "T", "role": "Technician"}, {"label": "Q", "role": None}]),
        created_at=STAMP,
        updated_at=STAMP,
    )
    _insert(
        conn,
        "procedure_step",
        id=2,
        procedure_id=1,
        title="B",
        required_role="technician",
        created_at=STAMP,
        updated_at=STAMP,
    )
    _insert(
        conn,
        "procedure_step",
        id=3,
        procedure_id=1,
        title="C",
        required_role="  QE  ",
        created_at=STAMP,
        updated_at=STAMP,
    )
    # An ad-hoc execution row.
    _insert(
        conn,
        "step_execution",
        id=1,
        instance_id=1,
        step_number=1,
        step_number_str="1",
        status="pending",
        signoffs=json.dumps([{"label": "Lead", "role": "Lead"}]),
        created_at=STAMP,
        updated_at=STAMP,
    )
    # A published snapshot, including a role no live template uses any more.
    content = {
        "steps": [
            {"order": 1, "required_role": "Inspector"},
            {"order": 2, "signoffs": [{"label": "x", "role": "QE"}, {"label": "y", "role": ""}]},
            {"order": 3, "required_role": ""},
        ]
    }
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
    conn.commit()
    conn.close()

    _alembic(db, "upgrade", "head")

    conn = sqlite3.connect(db)
    roles = dict(conn.execute("SELECT id, name FROM role").fetchall())
    assert sorted(roles.values()) == ["Inspector", "Lead", "QE", "Technician"]
    grants = conn.execute("SELECT user_id, role_id FROM user_role").fetchall()
    assert sorted(grants) == sorted((u, r) for u in (1, 2) for r in roles)  # not user 3
    for col in ("job_title", "phone", "workcenter_id", "avatar_filename", "avatar_source"):
        assert col in [r[1] for r in conn.execute("PRAGMA table_info(user)")]
    # Case-insensitive uniqueness holds at the database level.
    try:
        conn.execute(
            "INSERT INTO role (name, created_at, updated_at) VALUES ('TECHNICIAN', ?, ?)",
            (STAMP, STAMP),
        )
    except sqlite3.IntegrityError:
        pass
    else:
        raise AssertionError("role names must be unique case-insensitively")
    conn.close()

    _alembic(db, "downgrade", PREV_REV)
    conn = sqlite3.connect(db)
    assert not ({"role", "user_role"} & _tables(conn))
    assert "job_title" not in [r[1] for r in conn.execute("PRAGMA table_info(user)")]
    assert conn.execute("SELECT count(*) FROM user").fetchone()[0] == 3  # users survive
    conn.close()

    _alembic(db, "upgrade", "head")
    conn = sqlite3.connect(db)
    assert conn.execute("SELECT count(*) FROM role").fetchone()[0] == 4
    assert conn.execute("SELECT count(*) FROM user_role").fetchone()[0] == 8
    conn.close()


def test_roles_migration_on_a_database_with_no_roles(tmp_path):
    db = tmp_path / "empty.db"
    _alembic(db, "upgrade", PREV_REV)
    conn = sqlite3.connect(db)
    _insert(conn, "user", id=1, name="Ada", username="ada", created_at=STAMP, updated_at=STAMP)
    conn.commit()
    conn.close()

    _alembic(db, "upgrade", "head")
    conn = sqlite3.connect(db)
    assert conn.execute("SELECT count(*) FROM role").fetchone()[0] == 0
    assert conn.execute("SELECT count(*) FROM user_role").fetchone()[0] == 0
    conn.close()
