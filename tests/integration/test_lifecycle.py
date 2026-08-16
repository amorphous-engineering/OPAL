"""Instance lifecycle integration tests: demo database switching, factory reset.

These run against real file-backed SQLite databases under tmp_path and
exercise the module-global engine/settings machinery, so every test MUST
restore that state on teardown — otherwise later tests inherit a dead
engine.
"""

from pathlib import Path

import pytest
from sqlalchemy import event, inspect
from sqlalchemy.engine import Engine

import opal.config as config_mod
from opal.config import configure_for_project, get_active_settings
from opal.core import lifecycle
from opal.db.base import SessionLocal, get_engine, init_database, reinitialize_engine
from opal.db.models import Part, User


@pytest.fixture(autouse=True, scope="module")
def fast_sqlite():
    """Disable fsync for the file-backed databases these tests create.

    Each test runs create_all plus a full demo seed against fresh SQLite
    files; with default PRAGMA synchronous the suite is fsync-bound
    (~30s wall for ~7s CPU). Durability is irrelevant under tmp_path.
    """

    @event.listens_for(Engine, "connect")
    def _no_fsync(dbapi_conn, _record):
        cursor = dbapi_conn.cursor()
        cursor.execute("PRAGMA synchronous=OFF")
        cursor.close()

    yield
    event.remove(Engine, "connect", _no_fsync)


@pytest.fixture
def real_instance(tmp_path):
    """A real file-backed OPAL instance under tmp_path; restores globals after."""
    saved_settings = config_mod._runtime_settings
    saved_project = config_mod._active_project
    saved_real_url = lifecycle._real_database_url
    saved_real_upload_dir = lifecycle._real_upload_dir

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
    lifecycle._real_upload_dir = saved_real_upload_dir
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
            username=name.lower(),
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
        # Sphinx seed data present, real part absent
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


def test_enter_demo_seeds_blank_existing_demo_file(real_instance):
    """An interrupted first seed leaves an empty-but-existing demo file.

    Freshness must derive from database content, not file existence — the
    next ENTER DEMO self-heals by seeding instead of opening a blank demo.
    """
    # Simulate the trap: the demo file exists (as _switch_database creates it
    # before the seed commits) but holds no content.
    lifecycle.demo_db_path().parent.mkdir(parents=True, exist_ok=True)
    lifecycle.demo_db_path().touch()

    lifecycle.enter_demo(None)
    with SessionLocal() as db:
        assert db.query(Part).count() > 10, "blank demo file must be seeded on entry"
    lifecycle.exit_demo(delete=True)
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


# ── Blocker 2: upload_dir isolation ──────────────────────────────────────────


def test_demo_gets_own_attachments_dir(real_instance):
    """Demo upload_dir must differ from real upload_dir — no cross-contamination."""
    real_upload_dir = get_active_settings().upload_dir

    lifecycle.enter_demo(None)

    demo_upload_dir = get_active_settings().upload_dir
    assert demo_upload_dir != real_upload_dir, (
        "Demo upload_dir must not be the same as the real upload_dir"
    )
    # Demo attachments must live next to the demo DB, not the real one.
    assert demo_upload_dir.parent == lifecycle.demo_db_path().parent

    lifecycle.exit_demo(delete=True)


def test_exit_demo_restores_real_upload_dir(real_instance):
    """After exit_demo the active upload_dir must be the one from before enter_demo."""
    real_upload_dir = get_active_settings().upload_dir

    lifecycle.enter_demo(None)
    lifecycle.exit_demo(delete=True)

    restored_upload_dir = get_active_settings().upload_dir
    assert restored_upload_dir == real_upload_dir, (
        "exit_demo must restore the upload_dir that was active before enter_demo"
    )


def test_configured_upload_dir_survives_demo_round_trip(real_instance, tmp_path):
    """A user-configured OPAL_UPLOAD_DIR (passed explicitly here) must survive."""
    custom_upload = tmp_path / "my-uploads"
    custom_upload.mkdir()
    # Simulate an explicitly configured upload dir by passing it directly to
    # configure_for_project; this is what OPAL_UPLOAD_DIR=... produces.
    configure_for_project(database_path=real_instance, upload_dir=custom_upload)
    # Re-register real URL so lifecycle helpers find the correct path.
    lifecycle.set_real_database_url(get_active_settings().database_url)

    lifecycle.enter_demo(None)
    assert get_active_settings().upload_dir != custom_upload  # demo has its own
    lifecycle.exit_demo(delete=True)

    assert get_active_settings().upload_dir == custom_upload, (
        "Explicitly configured upload_dir must be restored after exit_demo"
    )


def test_factory_reset_removes_configured_upload_dir(real_instance, tmp_path):
    """factory_reset removes the upload_dir that was actually configured."""
    custom_upload = tmp_path / "reset-uploads"
    custom_upload.mkdir()
    # Write a sentinel file to prove rmtree hits the right directory.
    (custom_upload / "sentinel.txt").write_text("x")

    configure_for_project(database_path=real_instance, upload_dir=custom_upload)
    lifecycle.set_real_database_url(get_active_settings().database_url)

    lifecycle.factory_reset()

    assert not custom_upload.exists(), (
        "factory_reset must remove the configured upload_dir, not a derived one"
    )


# ── Blocker 1: audit logging ──────────────────────────────────────────────────


def test_enter_demo_user_create_is_audit_logged(real_instance):
    """Creating a user in enter_demo must produce an AuditLog CREATE row."""
    from opal.db.models.audit import AuditAction, AuditLog

    admin = _make_admin("AuditedAdmin")
    lifecycle.enter_demo(admin)

    with SessionLocal() as db:
        entries = (
            db.query(AuditLog)
            .filter(AuditLog.table_name == "user", AuditLog.action == AuditAction.CREATE)
            .all()
        )
        assert len(entries) >= 1, "Expected at least one CREATE audit log for the demo user"
        created_names = [e.new_values.get("name") for e in entries if e.new_values]
        assert admin.name in created_names

    lifecycle.exit_demo(delete=True)


def test_enter_demo_user_update_is_audit_logged(real_instance):
    """Upsert of a non-admin demo user in enter_demo must produce an AuditLog UPDATE row."""
    from opal.db.models.audit import AuditAction, AuditLog
    from opal.db.models.user import User

    admin = _make_admin("ExistingAdmin")

    # Pre-seed the demo database with the user but set is_admin=False so
    # enter_demo has a real change to make (→ is_admin=True).
    lifecycle.enter_demo(None)
    with SessionLocal() as db:
        existing = db.query(User).filter(User.name == admin.name).first()
        if existing is None:
            # Not seeded yet — insert a non-admin version.
            non_admin = User(
                name=admin.name,
                username=admin.username,
                email=admin.email,
                is_active=True,
                is_admin=False,  # deliberately not admin
                needs_profile_setup=False,
                needs_onboarding=False,
            )
            db.add(non_admin)
            db.commit()
        else:
            existing.is_admin = False
            db.commit()
    lifecycle.exit_demo(delete=False)

    # Second entry should find the user and promote them to admin → UPDATE row.
    lifecycle.enter_demo(admin)

    with SessionLocal() as db:
        entries = (
            db.query(AuditLog)
            .filter(AuditLog.table_name == "user", AuditLog.action == AuditAction.UPDATE)
            .all()
        )
        assert len(entries) >= 1, "Expected at least one UPDATE audit log for promoted demo user"

    lifecycle.exit_demo(delete=True)


def test_save_project_to_db_writes_audit_log(real_instance):
    """save_project_to_db must write an AuditLog row for the project_config AppSetting."""
    from opal.config import PROJECT_CONFIG_KEY, save_project_to_db
    from opal.db.models.audit import AuditAction, AuditLog
    from opal.project import ProjectConfig

    config = ProjectConfig(name="Test Project")

    with SessionLocal() as db:
        save_project_to_db(db, config, user_id=None)
        db.commit()

        entries = db.query(AuditLog).filter(AuditLog.table_name == "app_setting").all()
        assert len(entries) == 1
        assert entries[0].action == AuditAction.CREATE
        assert entries[0].new_values["key"] == PROJECT_CONFIG_KEY

    # A second save must produce UPDATE.
    config.name = "Updated Project"
    with SessionLocal() as db:
        save_project_to_db(db, config, user_id=None)
        db.commit()

        update_entries = (
            db.query(AuditLog)
            .filter(AuditLog.table_name == "app_setting", AuditLog.action == AuditAction.UPDATE)
            .all()
        )
        assert len(update_entries) == 1
        assert update_entries[0].old_values["key"] == PROJECT_CONFIG_KEY


# ── Demo inbox belongs to whoever entered the demo ────────────────────────────


def test_enter_demo_gives_the_operator_a_populated_inbox(real_instance):
    """An operator entering the demo as themselves must not find an empty bell.

    Demo notifications are seeded against the demo's own users, so without
    mirroring, the person actually looking at the demo would conclude the
    notification system does nothing.
    """
    from opal.core import notifications
    from opal.db.models.notification import Notification
    from opal.db.models.user import User

    admin = _make_admin("InboxAdmin")
    lifecycle.enter_demo(admin)

    with SessionLocal() as db:
        operator = db.query(User).filter(User.name == admin.name).one()
        assert notifications.unread_count(db, operator.id) > 0
        assert len(notifications.recent(db, operator.id, limit=8)) > 0

        # The never-notify-your-own-action rule survives the copy.
        mirrored = db.query(Notification).filter(Notification.user_id == operator.id).all()
        assert all(n.actor_id != operator.id for n in mirrored)

    lifecycle.exit_demo(delete=True)


def test_reentering_the_demo_does_not_duplicate_the_inbox(real_instance):
    from opal.db.models.notification import Notification
    from opal.db.models.user import User

    admin = _make_admin("ReentryAdmin")

    lifecycle.enter_demo(admin)
    with SessionLocal() as db:
        operator = db.query(User).filter(User.name == admin.name).one()
        first = db.query(Notification).filter(Notification.user_id == operator.id).count()

    lifecycle.exit_demo(delete=False)
    lifecycle.enter_demo(admin)
    with SessionLocal() as db:
        operator = db.query(User).filter(User.name == admin.name).one()
        second = db.query(Notification).filter(Notification.user_id == operator.id).count()

    assert second == first, "re-entering the demo must not stack duplicate notifications"
    lifecycle.exit_demo(delete=True)
