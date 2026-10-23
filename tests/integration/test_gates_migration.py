"""Backfill test for migration e6b8d4f2a903 (system roles and permission gates).

Runs the real alembic chain against a throwaway file DB: upgrade to the roles
revision, plant a same-named custom role in other casing (with a grant and a
description), a soft-deleted one, an unrelated custom role and a stray grant on
a custom "admin" role, plus active and deactivated users; upgrade and assert the
four system roles exist (conversions keep id and grants), the default gates are
mapped, Engineer and Quality reach every active user, the Admin role holds no
grants; then downgrade and upgrade again.
"""

import sqlite3

from tests.integration.test_roles_migration import ROLES_REV, STAMP, _alembic, _insert, _tables

GATES_REV = "e6b8d4f2a903"


def _cols(conn: sqlite3.Connection, table: str) -> list[str]:
    return [r[1] for r in conn.execute(f"PRAGMA table_info({table})")]


def _plant(db) -> None:
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
    for rid, name, desc, deleted in (
        (1, "engineer", "Our engineers", None),  # converted, keeps grants and text
        (2, "QUALITY", None, STAMP),  # soft-deleted: converted and revived
        (3, "Welder", "Welds", None),  # untouched custom role
        (4, "admin", None, None),  # stray grants on it are dropped
    ):
        _insert(
            conn,
            "role",
            id=rid,
            name=name,
            description=desc,
            deleted_at=deleted,
            created_at=STAMP,
            updated_at=STAMP,
        )
    for uid, rid in ((1, 1), (3, 3), (1, 4)):
        _insert(conn, "user_role", user_id=uid, role_id=rid, granted_at=STAMP)
    conn.commit()
    conn.close()


def test_system_roles_backfill(tmp_path):
    db = tmp_path / "gates.db"
    _alembic(db, "upgrade", ROLES_REV)
    _plant(db)

    _alembic(db, "upgrade", GATES_REV)

    conn = sqlite3.connect(db)
    rows = {
        key: (rid, name, desc, system, deleted)
        for rid, key, name, desc, system, deleted in conn.execute(
            "SELECT id, key, name, description, is_system, deleted_at FROM role WHERE key IS NOT NULL"
        )
    }
    assert set(rows) == {"engineer", "technician", "quality", "admin"}
    assert all(r[3] == 1 for r in rows.values())
    # Conversions keep their id; the canonical name replaces the old casing.
    assert rows["engineer"][:3] == (1, "Engineer", "Our engineers")
    assert rows["quality"][0] == 2 and rows["quality"][1] == "Quality"
    assert rows["quality"][4] is None  # revived
    assert rows["admin"][0] == 4
    assert rows["technician"][0] not in (1, 2, 3, 4)  # created
    assert rows["technician"][2]  # default description
    # The unrelated custom role is untouched.
    assert conn.execute("SELECT key, is_system FROM role WHERE id=3").fetchone() == (None, 0)

    gates = sorted(conn.execute("SELECT role_id, gate FROM role_gate").fetchall())
    assert gates == sorted(
        [(rows["engineer"][0], "issue.disposition"), (rows["quality"][0], "issue.approve")]
    )

    grants = sorted(conn.execute("SELECT user_id, role_id FROM user_role").fetchall())
    eng, qual = rows["engineer"][0], rows["quality"][0]
    # Every active user holds Engineer and Quality (user 1 already had Engineer, once);
    # the deactivated user only keeps what they had; Admin has no grants at all.
    assert (1, eng) in grants and grants.count((1, eng)) == 1
    assert {(1, qual), (2, eng), (2, qual)} <= set(grants)
    assert (3, eng) not in grants and (3, qual) not in grants and (3, 3) in grants
    assert not [g for g in grants if g[1] == rows["admin"][0]]
    # The table rebuild kept the NOCASE collation: names stay unique case-insensitively.
    try:
        conn.execute(
            "INSERT INTO role (name, is_system, created_at, updated_at) VALUES ('WELDER', 0, ?, ?)",
            (STAMP, STAMP),
        )
    except sqlite3.IntegrityError:
        pass
    else:
        raise AssertionError("role names must stay unique case-insensitively")
    # key is unique.
    try:
        conn.execute(
            "INSERT INTO role (name, key, is_system, created_at, updated_at) "
            "VALUES ('Other', 'engineer', 0, ?, ?)",
            (STAMP, STAMP),
        )
    except sqlite3.IntegrityError:
        pass
    else:
        raise AssertionError("role.key must be unique")
    conn.close()

    # Downgrade: gates go, the Admin role goes, the rest stay as ordinary roles.
    _alembic(db, "downgrade", ROLES_REV)
    conn = sqlite3.connect(db)
    assert "role_gate" not in _tables(conn)
    assert "key" not in _cols(conn, "role") and "is_system" not in _cols(conn, "role")
    names = sorted(r[0] for r in conn.execute("SELECT name FROM role"))
    assert names == ["Engineer", "Quality", "Technician", "Welder"]
    assert conn.execute("SELECT count(*) FROM user").fetchone()[0] == 3
    conn.close()

    # And forward again, with the same result.
    _alembic(db, "upgrade", GATES_REV)
    conn = sqlite3.connect(db)
    assert conn.execute("SELECT count(*) FROM role WHERE is_system=1").fetchone()[0] == 4
    assert conn.execute("SELECT count(*) FROM role_gate").fetchone()[0] == 2
    conn.close()


def test_system_roles_on_a_database_with_no_roles(tmp_path):
    db = tmp_path / "empty.db"
    _alembic(db, "upgrade", ROLES_REV)
    conn = sqlite3.connect(db)
    _insert(
        conn,
        "user",
        id=1,
        name="Ada",
        username="ada",
        is_active=1,
        created_at=STAMP,
        updated_at=STAMP,
    )
    conn.commit()
    conn.close()

    _alembic(db, "upgrade", GATES_REV)
    conn = sqlite3.connect(db)
    keys = [r[0] for r in conn.execute("SELECT key FROM role ORDER BY id")]
    assert keys == ["engineer", "technician", "quality", "admin"]
    holds = conn.execute(
        "SELECT r.key FROM user_role ur JOIN role r ON r.id = ur.role_id WHERE ur.user_id = 1"
    ).fetchall()
    assert sorted(h[0] for h in holds) == ["engineer", "quality"]
    conn.close()
