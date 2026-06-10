"""Instance lifecycle integration tests: demo database switching, factory reset.

These run against real file-backed SQLite databases under tmp_path and
exercise the module-global engine/settings machinery, so every test MUST
restore that state on teardown — otherwise later tests inherit a dead
engine.
"""

from pathlib import Path

import pytest
from sqlalchemy import inspect

import opal.config as config_mod
from opal.config import configure_for_project, get_active_settings
from opal.core import lifecycle
from opal.db.base import SessionLocal, get_engine, init_database, reinitialize_engine
from opal.db.models import Part, User


@pytest.fixture
def real_instance(tmp_path):
    """A real file-backed OPAL instance under tmp_path; restores globals after."""
    saved_settings = config_mod._runtime_settings
    saved_project = config_mod._active_project
    saved_real_url = lifecycle._real_database_url

    db_path = tmp_path / "data" / "opal.db"
    configure_for_project(database_path=db_path)
    reinitialize_engine()
    get_active_settings().ensure_directories()
    init_database()
    lifecycle.set_real_database_url(get_active_settings().database_url)

    yield db_path

    config_mod._runtime_settings = saved_settings
    config_mod._active_project = saved_project
    lifecycle._real_database_url = saved_real_url
    reinitialize_engine()


def _add_real_part(name: str) -> None:
    with SessionLocal() as db:
        db.add(Part(name=name, tier=3))
        db.commit()


def _count_parts() -> int:
    with SessionLocal() as db:
        return db.query(Part).count()


def _make_admin(name: str = "Operator") -> User:
    with SessionLocal() as db:
        user = User(
            name=name,
            email=f"{name.lower()}@test.local",
            is_active=True,
            is_admin=True,
            needs_profile_setup=False,
            needs_onboarding=False,
        )
        db.add(user)
        db.commit()
        db.refresh(user)
        db.expunge(user)
        return user


def test_enter_demo_creates_separate_db(real_instance):
    _add_real_part("Real Part")
    admin = _make_admin()

    demo_user_id = lifecycle.enter_demo(admin)

    assert lifecycle.is_demo_active()
    assert lifecycle.demo_db_path().exists()
    assert demo_user_id is not None

    with SessionLocal() as db:
        # Kestrel seed data present, real part absent
        assert db.query(Part).count() > 10
        assert db.query(Part).filter(Part.name == "Real Part").first() is None
        # Operator replicated as admin
        demo_user = db.query(User).filter(User.id == demo_user_id).one()
        assert demo_user.is_admin
        assert demo_user.email == admin.email

    # Real database untouched on disk
    assert real_instance.exists()


def test_exit_demo_deletes_file_and_restores_real(real_instance):
    _add_real_part("Survivor")
    lifecycle.enter_demo(None)
    assert lifecycle.is_demo_active()

    lifecycle.exit_demo(delete=True)

    assert not lifecycle.is_demo_active()
    assert not lifecycle.demo_db_path().exists()
    with SessionLocal() as db:
        assert db.query(Part).filter(Part.name == "Survivor").count() == 1


def test_demo_resume_keeps_demo_data(real_instance):
    lifecycle.enter_demo(None)
    with SessionLocal() as db:
        db.add(Part(name="Demo Scratch", tier=3))
        db.commit()
    lifecycle.exit_demo(delete=False)
    assert lifecycle.demo_file_exists()

    lifecycle.enter_demo(None)  # resume — must not reseed
    with SessionLocal() as db:
        assert db.query(Part).filter(Part.name == "Demo Scratch").count() == 1
    lifecycle.exit_demo(delete=True)


def test_delete_demo_file_guarded_while_active(real_instance):
    lifecycle.enter_demo(None)
    with pytest.raises(RuntimeError):
        lifecycle.delete_demo_file()
    lifecycle.exit_demo(delete=True)


def test_factory_reset_wipes_everything(real_instance):
    _add_real_part("Doomed")
    _make_admin("Doomed Admin")
    lifecycle.enter_demo(None)  # reset must also handle being in demo

    lifecycle.factory_reset()

    assert not lifecycle.is_demo_active()
    assert not lifecycle.demo_db_path().exists()
    with SessionLocal() as db:
        assert db.query(Part).count() == 0
        assert db.query(User).count() == 0
    assert config_mod.get_active_project() is None

    # Schema is intact and stamped at head
    engine = get_engine()
    inspector = inspect(engine)
    tables = inspector.get_table_names()
    assert "part" in tables
    assert "alembic_version" in tables
    with engine.connect() as conn:
        from sqlalchemy import text

        version = conn.execute(text("SELECT version_num FROM alembic_version")).scalar()
    assert version  # stamped, non-empty

    # Instance is usable again after reset
    _add_real_part("Phoenix")
    assert _count_parts() == 1


def test_demo_db_path_is_sibling(real_instance):
    demo = lifecycle.demo_db_path()
    assert demo.parent == Path(real_instance).parent
    assert demo.name == "demo.opal.db"
