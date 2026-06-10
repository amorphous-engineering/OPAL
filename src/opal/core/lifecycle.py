"""Instance lifecycle: demo database switching and factory reset.

One instance = one project — the database is the project. The demo is a
completely separate sibling database file (demo.<name>): entering switches
the running engine to it (seeding on first entry), exiting switches back
and deletes the file. Factory reset wipes the real database back to the
first-run state.

Concurrency note: switching the engine affects every user of the instance.
A request in flight during a switch may complete against the previous
database. With admin-initiated switches on a two-person LAN deployment
this is acceptable; no locking is attempted.
"""

import logging
import shutil
from pathlib import Path

from opal.config import (
    apply_db_overlay,
    configure_for_project,
    get_active_settings,
    load_project_from_db,
    set_app_setting,
)
from opal.db.base import SessionLocal, get_engine, init_database, reinitialize_engine

logger = logging.getLogger("opal.lifecycle")

DEMO_PREFIX = "demo."

# Captured at boot: the server always starts against the real database, so
# this is the way home from demo mode even after a crash mid-demo.
_real_database_url: str | None = None


def set_real_database_url(url: str) -> None:
    global _real_database_url
    _real_database_url = url


def _url_to_path(url: str) -> Path:
    return Path(url.replace("sqlite:///", ""))


def real_db_path() -> Path:
    if _real_database_url is None:
        # CLI/tests that never ran the app lifespan: the active URL is real.
        return _url_to_path(get_active_settings().database_url)
    return _url_to_path(_real_database_url)


def demo_db_path() -> Path:
    real = real_db_path()
    return real.with_name(f"{DEMO_PREFIX}{real.name}")


def is_demo_active() -> bool:
    """True when the running engine points at the demo database. No queries."""
    active = _url_to_path(get_active_settings().database_url)
    return active == demo_db_path()


def demo_file_exists() -> bool:
    return demo_db_path().exists()


def _switch_database(path: Path) -> None:
    """Point the running instance at a different SQLite file."""
    configure_for_project(database_path=path)
    reinitialize_engine()
    settings = get_active_settings()
    settings.ensure_directories()
    init_database()
    with SessionLocal() as db:
        apply_db_overlay(db)
        load_project_from_db(db)
    logger.info("Switched active database to %s", path)


def _unlink_sqlite_files(path: Path) -> None:
    """Delete a SQLite database and its -wal/-shm sidecars, best-effort."""
    for candidate in (path, path.with_name(path.name + "-wal"), path.with_name(path.name + "-shm")):
        try:
            candidate.unlink(missing_ok=True)
        except OSError:
            logger.warning("Could not delete %s — remove it manually", candidate)


def enter_demo(current_user=None) -> int | None:
    """Switch to the demo database, seeding it on first entry.

    If a user object from the real database is given, an equivalent active
    admin is upserted in the demo database so the operator stays logged in.
    Returns that demo user's id (or None).
    """
    from opal.db.models.user import User

    fresh = not demo_file_exists()

    # Carry the auth mode across so e.g. an exe-mode deployment doesn't
    # bounce its users to a local login they cannot complete.
    auth_mode = get_active_settings().auth_mode

    _switch_database(demo_db_path())

    demo_user_id: int | None = None
    with SessionLocal() as db:
        if fresh:
            from opal.seed import seed_database

            seed_database(db)
            set_app_setting(db, "auth_mode", auth_mode)
            db.commit()
            logger.info("Demo database created and seeded at %s", demo_db_path())

        if current_user is not None:
            match = None
            if current_user.email:
                match = db.query(User).filter(User.email == current_user.email).first()
            if match is None:
                match = db.query(User).filter(User.name == current_user.name).first()
            if match is None:
                match = User(
                    name=current_user.name,
                    email=current_user.email,
                    is_active=True,
                    is_admin=True,
                    needs_profile_setup=False,
                    needs_onboarding=False,
                )
                db.add(match)
            else:
                match.is_active = True
                match.is_admin = True
                match.needs_onboarding = False
            db.commit()
            demo_user_id = match.id

        apply_db_overlay(db)

    return demo_user_id


def exit_demo(delete: bool = True) -> None:
    """Switch back to the real database; delete the demo file by default."""
    if not is_demo_active():
        return
    _switch_database(real_db_path())
    if delete:
        _unlink_sqlite_files(demo_db_path())
        logger.info("Demo database deleted")


def delete_demo_file() -> None:
    """Delete an inactive demo database file."""
    if is_demo_active():
        raise RuntimeError("Cannot delete the demo database while it is active — exit demo first")
    _unlink_sqlite_files(demo_db_path())


def factory_reset() -> None:
    """Wipe the instance back to first-run state.

    Drops and recreates the schema on the real database (no file deletion —
    avoids Windows file-lock issues), restamps the Alembic head, removes the
    demo database and all uploaded attachments, and clears runtime config so
    the next request lands on /setup.
    """
    from opal.db.base import Base, stamp_head

    if is_demo_active():
        _switch_database(real_db_path())
    _unlink_sqlite_files(demo_db_path())

    engine = get_engine()
    # Schema drop/recreate here is sanctioned reinitialization via the same
    # metadata init_database uses for new databases — not a schema change.
    # FK enforcement must be off for the drop: the schema has FK cycles, so
    # tables cannot be dropped in a dependency-safe order.
    with engine.connect() as conn:
        conn.exec_driver_sql("PRAGMA foreign_keys=OFF")
        Base.metadata.drop_all(bind=conn)
        conn.commit()
    Base.metadata.create_all(engine)
    stamp_head(engine, purge=True)

    upload_dir = get_active_settings().upload_dir
    if upload_dir.exists():
        shutil.rmtree(upload_dir, ignore_errors=True)

    # Rebuild runtime settings from env (clears DB-overlaid auth/Onshape
    # config) and drop the active project — the blob was just wiped.
    configure_for_project(database_path=real_db_path())
    reinitialize_engine()
    get_active_settings().ensure_directories()
    logger.info("Factory reset complete — instance is back to first-run state")
