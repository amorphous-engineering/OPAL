"""SQLAlchemy database setup."""

from collections.abc import Generator
from datetime import UTC, datetime
from enum import Enum
from typing import Any

from sqlalchemy import JSON, DateTime, ForeignKey, Integer, String, create_engine, event
from sqlalchemy.orm import (
    DeclarativeBase,
    Mapped,
    Session,
    declared_attr,
    mapped_column,
    sessionmaker,
)


class Base(DeclarativeBase):
    """Base class for all database models."""

    type_annotation_map = {
        dict[str, Any]: JSON,
    }

    @declared_attr.directive
    def __tablename__(cls) -> str:
        """Generate table name from class name."""
        # Convert CamelCase to snake_case
        name = cls.__name__
        result = [name[0].lower()]
        for char in name[1:]:
            if char.isupper():
                result.append("_")
                result.append(char.lower())
            else:
                result.append(char)
        return "".join(result)


class TimestampMixin:
    """Mixin for created_at and updated_at timestamps."""

    created_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True),
        default=lambda: datetime.now(UTC),
        nullable=False,
    )
    updated_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True),
        default=lambda: datetime.now(UTC),
        onupdate=lambda: datetime.now(UTC),
        nullable=False,
    )


class SoftDeleteMixin:
    """Mixin for soft delete support."""

    deleted_at: Mapped[datetime | None] = mapped_column(
        DateTime(timezone=True),
        default=None,
        nullable=True,
    )

    @property
    def is_deleted(self) -> bool:
        """Check if record is soft-deleted."""
        return self.deleted_at is not None

    def soft_delete(self) -> None:
        """Mark record as deleted."""
        self.deleted_at = datetime.now(UTC)

    def restore(self) -> None:
        """Restore a soft-deleted record."""
        self.deleted_at = None


class IdMixin:
    """Mixin for auto-incrementing integer primary key."""

    id: Mapped[int] = mapped_column(Integer, primary_key=True, autoincrement=True)


class LifecycleState(str, Enum):
    """Maturity states for baselined work products (NPR 7123.1D App. F terminology).

    draft -> preliminary -> baselined -> superseded | cancelled

    Baselined objects are immutable: changing one creates a new revision row
    (revision + supersedes_id) rather than mutating in place. Enforcement lives
    in opal.se.lifecycle, not in the database layer.
    """

    DRAFT = "draft"
    PRELIMINARY = "preliminary"
    BASELINED = "baselined"
    SUPERSEDED = "superseded"
    CANCELLED = "cancelled"


class LifecycleMixin:
    """Mixin for objects with a baseline lifecycle (requirements, interfaces, ...).

    Revisions are separate rows sharing the same human-readable number:
    revision increments and supersedes_id points at the prior row.
    """

    lifecycle_state: Mapped[str] = mapped_column(
        String(20), nullable=False, default=LifecycleState.DRAFT.value
    )
    revision: Mapped[int] = mapped_column(Integer, nullable=False, default=1)
    baselined_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True), nullable=True)

    @declared_attr
    def baselined_by_id(cls) -> Mapped[int | None]:  # noqa: N805
        return mapped_column(ForeignKey("user.id", ondelete="SET NULL"), nullable=True)

    @declared_attr
    def supersedes_id(cls) -> Mapped[int | None]:  # noqa: N805
        return mapped_column(
            ForeignKey(f"{cls.__tablename__}.id", ondelete="SET NULL"), nullable=True
        )

    @property
    def is_baselined(self) -> bool:
        return self.lifecycle_state == LifecycleState.BASELINED.value

    @property
    def is_mutable(self) -> bool:
        """Only draft and preliminary objects may be edited in place."""
        return self.lifecycle_state in (
            LifecycleState.DRAFT.value,
            LifecycleState.PRELIMINARY.value,
        )


# Lazy engine initialization - allows project config to be set before engine creation
_engine = None
_session_local = None


def _setup_sqlite_pragma(dbapi_connection: Any, connection_record: Any) -> None:
    """Configure SQLite for multi-user access.

    - foreign_keys: enforce FK constraints (off by default in SQLite)
    - journal_mode=WAL: writers no longer block readers; survives across
      connections since it is a property of the database file
    - busy_timeout: wait for a lock instead of failing immediately with
      "database is locked" when another connection is writing
    - synchronous=NORMAL: safe with WAL, much faster than FULL
    """
    cursor = dbapi_connection.cursor()
    cursor.execute("PRAGMA foreign_keys=ON")
    cursor.execute("PRAGMA journal_mode=WAL")
    cursor.execute("PRAGMA busy_timeout=10000")
    cursor.execute("PRAGMA synchronous=NORMAL")
    cursor.close()


def get_engine():
    """Get or create the database engine (lazy initialization)."""
    global _engine
    if _engine is None:
        from opal.config import get_active_settings

        settings = get_active_settings()
        _engine = create_engine(
            settings.database_url,
            connect_args={"check_same_thread": False} if "sqlite" in settings.database_url else {},
            echo=settings.debug,
        )
        # Enable SQLite foreign key support
        if "sqlite" in settings.database_url:
            event.listen(_engine, "connect", _setup_sqlite_pragma)
    return _engine


def reinitialize_engine():
    """Reinitialize the engine (call after configure_for_project).

    Disposes the old engine first so SQLite file handles are released —
    required before deleting or replacing a database file.
    """
    global _engine, _session_local
    if _engine is not None:
        _engine.dispose()
    _engine = None
    _session_local = None


def SessionLocal():
    """Get a database session (lazy initialization)."""
    global _session_local
    if _session_local is None:
        _session_local = sessionmaker(autocommit=False, autoflush=False, bind=get_engine())
    return _session_local()


def get_db() -> Generator[Session, None, None]:
    """Dependency for getting database sessions."""
    db = SessionLocal()
    try:
        yield db
    finally:
        db.close()


def init_database(engine=None) -> None:
    """Initialize or migrate the database.

    For new databases: creates all tables and stamps the current alembic revision.
    For existing databases: runs alembic upgrade to apply pending migrations.

    Args:
        engine: SQLAlchemy engine. If None, uses get_engine().
    """
    import logging

    from sqlalchemy import inspect

    logger = logging.getLogger("opal.db")

    if engine is None:
        engine = get_engine()

    inspector = inspect(engine)
    existing_tables = inspector.get_table_names()

    # Import all models to ensure metadata is populated
    import opal.db.models  # noqa: F401

    if not existing_tables:
        # New database: create all tables directly
        logger.info("Creating new database schema...")
        Base.metadata.create_all(engine)

        # FTS index tables/triggers are not part of ORM metadata; create them
        # here since stamping head below means the FTS migration never runs
        from opal.db.fts import create_fts_schema

        with engine.begin() as conn:
            create_fts_schema(conn)

        # Stamp alembic version so future migrations know the starting point
        _stamp_alembic_head(engine)
        logger.info("Database initialized at current schema version.")
    else:
        # Existing database: run migrations to apply any pending changes
        logger.info("Running database migrations...")
        _run_alembic_upgrade(engine)
        logger.info("Database migrations complete.")


def stamp_head(engine, purge: bool = False) -> None:
    """Stamp the alembic version table at head (public wrapper).

    Args:
        engine: SQLAlchemy engine.
        purge: Delete existing version rows first (used by factory reset).
    """
    from alembic import command

    cfg = _get_alembic_config(engine)
    with engine.begin() as conn:
        cfg.attributes["connection"] = conn
        command.stamp(cfg, "head", purge=purge)


def _get_alembic_config(engine=None):
    """Build an alembic Config object for programmatic use.

    Looks for migrations in the installed package or the project root.
    """
    from pathlib import Path

    from alembic.config import Config

    cfg = Config()

    # Find the migrations directory — try package resources first, then project root
    project_root = Path(__file__).resolve().parent.parent.parent.parent
    migrations_dir = project_root / "migrations"

    if not migrations_dir.is_dir():
        # Bundled binary: migrations might be alongside the package
        import opal

        pkg_dir = Path(opal.__file__).resolve().parent
        for candidate in [
            pkg_dir.parent.parent / "migrations",
            pkg_dir.parent / "migrations",
            pkg_dir / "migrations",
        ]:
            if candidate.is_dir():
                migrations_dir = candidate
                break

    cfg.set_main_option("script_location", str(migrations_dir))

    if engine is not None:
        cfg.set_main_option("sqlalchemy.url", str(engine.url))

    return cfg


def _stamp_alembic_head(engine) -> None:
    """Stamp the alembic version table to the current head revision."""
    from alembic import command

    cfg = _get_alembic_config(engine)
    with engine.begin() as conn:
        cfg.attributes["connection"] = conn
        command.stamp(cfg, "head")


class UnknownDatabaseRevisionError(RuntimeError):
    """The database is stamped with an alembic revision this checkout lacks.

    Typically a shared database whose alembic_version head was written by a
    different branch. Raised before any migration runs, so the database is
    never touched.
    """


def _describe_database_selection(engine: Any) -> str:
    """Name the setting/env var that selected this database, best-effort."""
    import os

    from opal.config import _default_database_url

    url = str(engine.url)
    if os.environ.get("OPAL_DATABASE_URL") == url:
        return "selected by OPAL_DATABASE_URL"
    if url == _default_database_url():
        if os.environ.get("OPAL_DATA_DIR"):
            return "default opal.db under OPAL_DATA_DIR"
        return "platform default data dir"
    return "selected by --database, --project, or project config"


def _unknown_revision_error(engine: Any, revision: str) -> UnknownDatabaseRevisionError:
    """Build the actionable startup error for a cross-branch database."""
    db_path = engine.url.database or str(engine.url)
    source = _describe_database_selection(engine)
    message = (
        f"Database {db_path} ({source}) is stamped at alembic revision "
        f"'{revision}', which does not exist in this checkout's "
        "migrations/versions/ — it was migrated by a different branch. "
        "Refusing to serve or migrate.\n"
        "Remedies:\n"
        "  1. Run from a branch that contains the revision (e.g. rebase onto devel).\n"
        "  2. Point at a throwaway database:\n"
        "     env -u OPAL_DATABASE_URL OPAL_DATA_DIR=$(mktemp -d) uv run opal init \\\n"
        "       && uv run opal seed && uv run opal serve"
    )
    return UnknownDatabaseRevisionError(message)


def _ensure_stamped_revisions_known(engine: Any, cfg: Any) -> None:
    """Refuse to migrate a database stamped with a revision unknown to this checkout.

    Reads the alembic_version table and verifies every stamped revision exists
    in the script directory. A missing revision means the database belongs to
    another branch: upgrading would either crash with a raw ResolutionError or
    (worse) silently advance a shared database past every other checkout.
    """
    from alembic.runtime.migration import MigrationContext
    from alembic.script import ScriptDirectory
    from alembic.util import CommandError

    script = ScriptDirectory.from_config(cfg)
    with engine.connect() as conn:
        stamped = MigrationContext.configure(conn).get_current_heads()
    for revision in stamped:
        try:
            # Raises CommandError (wrapping ResolutionError) when unknown.
            script.get_revision(revision)
        except CommandError as exc:
            raise _unknown_revision_error(engine, revision) from exc


def _run_alembic_upgrade(engine) -> None:
    """Run alembic upgrade to head programmatically.

    Migrations run on a plain engine WITHOUT the foreign_keys=ON pragma
    listener: alembic batch mode recreates tables via copy/DROP/RENAME, and
    under FK enforcement the DROP cascade-deletes every referencing row
    (ON DELETE CASCADE children silently emptied). FK off during migrations
    is alembic's documented requirement for SQLite batch mode; the CLI
    `opal migrate upgrade` path (env.py engine) already behaves this way.

    Raises:
        UnknownDatabaseRevisionError: the database is stamped with a revision
            this checkout's migrations/versions/ does not contain.
    """
    from alembic import command

    if engine.url.database in (None, ":memory:"):
        # A fresh engine on :memory: would migrate a different, empty database.
        # In-memory databases are created via create_all, never migrated.
        migration_engine = engine
        dispose = False
    else:
        migration_engine = create_engine(engine.url, connect_args={"check_same_thread": False})
        dispose = True

    try:
        cfg = _get_alembic_config(migration_engine)
        _ensure_stamped_revisions_known(migration_engine, cfg)
        with migration_engine.begin() as conn:
            cfg.attributes["connection"] = conn
            command.upgrade(cfg, "head")
    finally:
        if dispose:
            migration_engine.dispose()
