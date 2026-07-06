"""`opal seed` must never write demo data over a configured instance.

The seed OVERWRITES the stored project config and inserts demo users with a
publicly documented password (build / kestrel-demo) — on a LAN-exposed
instance that is a security problem, so the CLI refuses when the database
shows ANY sign of configuration (parts, users, workcenters, suppliers, or a
saved project config) unless --force is given.
"""

import argparse

import pytest
from sqlalchemy import event
from sqlalchemy.engine import Engine

import opal.config as config_mod
from opal.__main__ import cmd_seed
from opal.config import PROJECT_CONFIG_KEY, configure_for_project, set_app_setting
from opal.db.base import SessionLocal, init_database, reinitialize_engine
from opal.db.models import Part, Supplier, User, Workcenter


@pytest.fixture(autouse=True, scope="module")
def fast_sqlite():
    """Disable fsync for the file-backed databases these tests create."""

    @event.listens_for(Engine, "connect")
    def _no_fsync(dbapi_conn, _record):
        cursor = dbapi_conn.cursor()
        cursor.execute("PRAGMA synchronous=OFF")
        cursor.close()

    yield
    event.remove(Engine, "connect", _no_fsync)


@pytest.fixture
def cli_db(tmp_path, monkeypatch):
    """A file-backed database as `opal init` leaves it; restores globals."""
    monkeypatch.delenv("OPAL_DATABASE_URL", raising=False)
    monkeypatch.chdir(tmp_path)  # no opal.project.yaml auto-detect
    saved_settings = config_mod._runtime_settings
    saved_project = config_mod._active_project

    db_file = tmp_path / "opal.db"
    configure_for_project(database_path=db_file)
    reinitialize_engine()
    init_database()

    yield db_file

    config_mod._runtime_settings = saved_settings
    config_mod._active_project = saved_project
    reinitialize_engine()


def _seed(db_file, force=False):
    cmd_seed(argparse.Namespace(database=str(db_file), force=force))


def test_seed_refuses_configured_instance_without_parts(cli_db, capsys):
    """Users + workcenters + saved config but zero parts must still refuse."""
    with SessionLocal() as db:
        db.add(User(name="Operator", username="operator", is_admin=True))
        db.add(Workcenter(code="WC1", name="Bench"))
        db.add(Supplier(name="ACME"))
        set_app_setting(db, PROJECT_CONFIG_KEY, '{"name": "Real Project"}')
        db.commit()

    with pytest.raises(SystemExit) as exc:
        _seed(cli_db)
    assert exc.value.code == 1

    err = capsys.readouterr().err
    assert "Refusing to seed" in err
    for named in ("1 users", "1 workcenters", "1 suppliers", "a saved project config"):
        assert named in err
    assert "--force" in err

    with SessionLocal() as db:
        assert db.query(Part).count() == 0, "refusal must not touch the database"


def test_seed_refuses_when_only_parts_exist(cli_db, capsys):
    with SessionLocal() as db:
        db.add(Part(name="Lone Part", tier=3))
        db.commit()

    with pytest.raises(SystemExit):
        _seed(cli_db)
    assert "1 parts" in capsys.readouterr().err


def test_seed_force_overrides_guard(cli_db):
    with SessionLocal() as db:
        db.add(Workcenter(code="WC1", name="Bench"))
        db.commit()

    _seed(cli_db, force=True)

    with SessionLocal() as db:
        assert db.query(Part).count() > 100


def test_seed_runs_on_fresh_database(cli_db):
    _seed(cli_db)
    with SessionLocal() as db:
        assert db.query(Part).count() > 100
