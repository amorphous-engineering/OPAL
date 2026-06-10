"""OPAL configuration via environment variables."""

import logging
import os
import sys
from functools import lru_cache
from pathlib import Path
from typing import TYPE_CHECKING

from pydantic import Field
from pydantic_settings import BaseSettings, SettingsConfigDict

if TYPE_CHECKING:
    from sqlalchemy.orm import Session

    from opal.project import ProjectConfig


def get_default_data_dir() -> Path:
    """Get the platform-appropriate default data directory.

    Resolution order:
    1. OPAL_DATA_DIR environment variable (if set)
    2. Platform-specific directory:
       - macOS:   ~/Library/Application Support/OPAL/
       - Linux:   $XDG_DATA_HOME/opal/ (default ~/.local/share/opal/)
       - Windows: %LOCALAPPDATA%\\OPAL\\

    Returns:
        Path to the data directory.
    """
    env_dir = os.environ.get("OPAL_DATA_DIR")
    if env_dir:
        return Path(env_dir)

    if sys.platform == "darwin":
        return Path.home() / "Library" / "Application Support" / "OPAL"
    elif sys.platform == "win32":
        local_app_data = os.environ.get("LOCALAPPDATA")
        if local_app_data:
            return Path(local_app_data) / "OPAL"
        return Path.home() / "AppData" / "Local" / "OPAL"
    else:
        # Linux / other Unix
        xdg_data = os.environ.get("XDG_DATA_HOME")
        if xdg_data:
            return Path(xdg_data) / "opal"
        return Path.home() / ".local" / "share" / "opal"


def _default_database_url() -> str:
    data_dir = get_default_data_dir()
    return f"sqlite:///{data_dir / 'opal.db'}"


def _default_upload_dir() -> Path:
    return get_default_data_dir() / "attachments"


class Settings(BaseSettings):
    """Application settings loaded from environment variables."""

    model_config = SettingsConfigDict(
        env_prefix="OPAL_",
        env_file=".env",
        env_file_encoding="utf-8",
        extra="ignore",
    )

    # Server
    host: str = Field(default="0.0.0.0", description="Server bind address")
    port: int = Field(default=8080, description="Server port")
    debug: bool = Field(default=False, description="Enable debug mode")

    # Database
    database_url: str = Field(
        default_factory=_default_database_url,
        description="Database connection URL",
    )

    # Security
    allowed_origins: str = Field(
        default="*",
        description="Comma-separated list of allowed CORS origins",
    )
    rate_limit_enabled: bool = Field(default=False, description="Enable rate limiting")
    rate_limit_requests: int = Field(default=100, description="Max requests per window")
    rate_limit_window: int = Field(default=60, description="Rate limit window in seconds")

    # Authentication
    auth_mode: str = Field(default="local", description="Auth mode: 'local' or 'exe'")

    # Onshape integration (off by default)
    onshape_access_key: str = Field(default="", description="Onshape API access key")
    onshape_secret_key: str = Field(default="", description="Onshape API secret key")
    onshape_base_url: str = Field(
        default="https://cad.onshape.com", description="Onshape API base URL"
    )
    onshape_poll_interval_minutes: int = Field(
        default=15, description="Minutes between automatic pull syncs (0 to disable)"
    )
    onshape_webhook_secret: str = Field(
        default="", description="Shared secret for Onshape webhook HMAC verification"
    )

    @property
    def onshape_enabled(self) -> bool:
        """True when Onshape API credentials are configured."""
        return bool(self.onshape_access_key and self.onshape_secret_key)

    # File uploads
    upload_dir: Path = Field(
        default_factory=_default_upload_dir,
        description="Directory for file uploads",
    )
    max_upload_size: int = Field(
        default=10 * 1024 * 1024,  # 10MB
        description="Maximum upload file size in bytes",
    )
    allowed_mime_types: str = Field(
        default=(
            "image/jpeg,image/png,image/gif,image/webp,image/svg+xml,"
            "application/pdf,text/plain,text/csv,text/markdown,"
            "application/msword,"
            "application/vnd.openxmlformats-officedocument.wordprocessingml.document,"
            "application/vnd.ms-excel,"
            "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet,"
            "application/vnd.ms-powerpoint,"
            "application/vnd.openxmlformats-officedocument.presentationml.presentation,"
            "image/vnd.dwg,application/acad,application/x-acad,"
            "model/step+xml,application/step,application/x-step,"
            "model/stl,application/sla,application/vnd.ms-pki.stl,"
            "application/zip,application/json"
        ),
        description="Comma-separated list of allowed MIME types",
    )

    @property
    def cors_origins(self) -> list[str]:
        """Parse allowed origins into a list."""
        if self.allowed_origins == "*":
            return ["*"]
        return [origin.strip() for origin in self.allowed_origins.split(",")]

    @property
    def mime_types_list(self) -> list[str]:
        """Parse allowed MIME types into a list."""
        return [mime.strip() for mime in self.allowed_mime_types.split(",")]

    def ensure_directories(self) -> None:
        """Create required directories if they don't exist."""
        self.upload_dir.mkdir(parents=True, exist_ok=True)
        # Ensure the data directory exists for SQLite — project configs use
        # absolute paths, so this must not be limited to ./relative ones.
        if self.database_url.startswith("sqlite") and ":memory:" not in self.database_url:
            db_path = self.database_url.replace("sqlite:///", "")
            Path(db_path).parent.mkdir(parents=True, exist_ok=True)


@lru_cache
def get_settings() -> Settings:
    """Get cached settings instance."""
    return Settings()


# Runtime settings that can be modified by project config
_runtime_settings: Settings | None = None
_active_project: "ProjectConfig | None" = None


def _upload_dir_is_explicit() -> bool:
    """True when OPAL_UPLOAD_DIR was set explicitly in the environment.

    The upload_dir must not be overwritten by database-path derivation
    when the operator has pinned it via env var.
    """
    import os

    return bool(os.environ.get("OPAL_UPLOAD_DIR"))


def configure_for_project(
    project: "ProjectConfig | None" = None,
    database_path: Path | str | None = None,
    upload_dir: Path | None = None,
) -> Settings:
    """Configure settings for a specific project.

    Args:
        project: Project configuration to use.
        database_path: Explicit database path (overrides project).
        upload_dir: Explicit upload directory.  When None the upload dir is
            derived from ``database_path`` **only if** ``OPAL_UPLOAD_DIR`` is
            not set in the environment.  A user-configured upload dir is never
            discarded by a database switch.

    Returns:
        Configured Settings instance.
    """
    global _runtime_settings, _active_project

    base = get_settings()

    # Determine database URL and upload dir.
    # upload_dir derivation rules:
    #   1. Caller supplied an explicit upload_dir → use it.
    #   2. OPAL_UPLOAD_DIR is set in the environment → keep base.upload_dir
    #      (env-configured dir must survive any DB switch).
    #   3. project carries its own attachments_dir → use that.
    #   4. database_path given with no explicit dir → derive next to the DB.
    #   5. Fallback → keep base.upload_dir.
    if database_path:
        db_path = Path(database_path).resolve()
        database_url = f"sqlite:///{db_path}"
        if upload_dir is not None:
            resolved_upload_dir = upload_dir
        elif _upload_dir_is_explicit():
            resolved_upload_dir = base.upload_dir
        else:
            resolved_upload_dir = db_path.parent / "attachments"
    elif project:
        database_url = project.database_url
        resolved_upload_dir = upload_dir if upload_dir is not None else project.attachments_dir
    else:
        database_url = base.database_url
        resolved_upload_dir = upload_dir if upload_dir is not None else base.upload_dir

    # Create new settings with overrides
    _runtime_settings = Settings(
        host=base.host,
        port=base.port,
        debug=base.debug,
        database_url=database_url,
        allowed_origins=base.allowed_origins,
        rate_limit_enabled=base.rate_limit_enabled,
        rate_limit_requests=base.rate_limit_requests,
        rate_limit_window=base.rate_limit_window,
        upload_dir=resolved_upload_dir,
        max_upload_size=base.max_upload_size,
        allowed_mime_types=base.allowed_mime_types,
        auth_mode=base.auth_mode,
        onshape_access_key=base.onshape_access_key,
        onshape_secret_key=base.onshape_secret_key,
        onshape_base_url=base.onshape_base_url,
        onshape_poll_interval_minutes=base.onshape_poll_interval_minutes,
        onshape_webhook_secret=base.onshape_webhook_secret,
    )
    _active_project = project

    return _runtime_settings


def get_active_settings() -> Settings:
    """Get the currently active settings (runtime or default)."""
    return _runtime_settings or get_settings()


def get_active_project() -> "ProjectConfig | None":
    """Get the currently active project configuration."""
    return _active_project


# Subset of Settings fields editable from the in-app settings UI. The DB
# overlay only touches these; everything else stays env-driven.
_DB_OVERLAY_FIELDS: tuple[str, ...] = (
    "auth_mode",
    "onshape_access_key",
    "onshape_secret_key",
    "onshape_base_url",
    "onshape_poll_interval_minutes",
    "onshape_webhook_secret",
)


def apply_db_overlay(db: "Session") -> Settings:
    """Overlay DB-stored AppSetting values onto the active Settings.

    Reads every row from the ``app_setting`` table and, for each key listed
    in :data:`_DB_OVERLAY_FIELDS`, replaces the matching field on the active
    Settings instance. Rebuilds ``_runtime_settings`` so future
    ``get_active_settings()`` callers see the overlay. Idempotent — safe to
    call after any settings edit.
    """
    global _runtime_settings

    from opal.db.models.app_setting import AppSetting

    base = get_active_settings()
    overrides: dict[str, object] = {}
    rows = db.query(AppSetting).filter(AppSetting.key.in_(_DB_OVERLAY_FIELDS)).all()
    for row in rows:
        if row.value is None:
            continue
        field = Settings.model_fields.get(row.key)
        if field is None:
            continue
        # Coerce text → field type. int is the only non-str we currently overlay.
        if field.annotation is int:
            try:
                overrides[row.key] = int(row.value)
            except ValueError:
                continue
        else:
            overrides[row.key] = row.value

    if not overrides:
        return base

    merged = base.model_dump()
    merged.update(overrides)
    _runtime_settings = Settings(**merged)
    return _runtime_settings


def set_app_setting(db: "Session", key: str, value: str | None) -> None:
    """Upsert a single AppSetting row. Caller commits."""
    from opal.db.models.app_setting import AppSetting

    row = db.query(AppSetting).filter(AppSetting.key == key).first()
    if row is None:
        row = AppSetting(key=key, value=value)
        db.add(row)
    else:
        row.value = value


def get_app_setting(db: "Session", key: str) -> str | None:
    from opal.db.models.app_setting import AppSetting

    row = db.query(AppSetting).filter(AppSetting.key == key).first()
    return row.value if row else None


# ============ Project config persistence (one instance = one project) ============
#
# The database is the project: live project configuration (name, tiers, part
# numbering, categories, Onshape documents) is stored as a JSON blob in the
# app_setting table. opal.project.yaml is a read-once bootstrap, deprecated
# as a write target.

PROJECT_CONFIG_KEY = "project_config"

logger = logging.getLogger("opal.config")


def save_project_to_db(
    db: "Session", config: "ProjectConfig", user_id: int | None = None
) -> None:
    """Persist the project config blob, activate it, and write an audit row.

    ``user_id`` is the acting admin; pass it from routes that have a resolved
    user.  Callers commit.
    """
    global _active_project

    from datetime import UTC, datetime

    from opal.db.models.app_setting import AppSetting
    from opal.db.models.audit import AuditAction, AuditLog

    new_value = config.model_dump_json(exclude={"project_dir"})

    existing = db.query(AppSetting).filter(AppSetting.key == PROJECT_CONFIG_KEY).first()
    old_value = existing.value if existing is not None else None

    set_app_setting(db, PROJECT_CONFIG_KEY, new_value)
    db.flush()  # ensure the row is visible to audit

    action = AuditAction.CREATE if old_value is None else AuditAction.UPDATE
    audit_entry = AuditLog(
        timestamp=datetime.now(UTC),
        table_name=AppSetting.__tablename__,
        # AppSetting PK is a string key; record_id stores 0 as sentinel.
        # The actual key is captured in new_values.
        record_id=0,
        action=action,
        user_id=user_id,
        old_values={"key": PROJECT_CONFIG_KEY, "value": old_value} if old_value is not None else None,
        new_values={"key": PROJECT_CONFIG_KEY, "value": new_value},
    )
    db.add(audit_entry)

    _active_project = config


def load_project_from_db(db: "Session") -> "ProjectConfig | None":
    """Load and activate the project config stored in the database, if any."""
    global _active_project

    from opal.project import ProjectConfig

    raw = get_app_setting(db, PROJECT_CONFIG_KEY)
    if raw is None:
        return None
    try:
        config = ProjectConfig.model_validate_json(raw)
    except Exception as e:
        logger.warning("Stored project config is invalid, ignoring: %s", e)
        return _active_project
    _active_project = config
    return config


def bootstrap_project_config(db: "Session") -> "ProjectConfig | None":
    """Read-once yaml import: establish the active project config.

    Precedence: existing DB blob > yaml already loaded via --project >
    opal.project.yaml in the current directory > nothing. The yaml import
    happens once; afterwards the database is the source of truth.
    """
    from pathlib import Path as _Path

    from opal.project import PROJECT_CONFIG_FILENAME, load_project_config

    stored = load_project_from_db(db)
    if stored is not None:
        if (_Path.cwd() / PROJECT_CONFIG_FILENAME).exists():
            logger.info(
                "opal.project.yaml present but project config now lives in the "
                "database — ignoring the file"
            )
        return stored

    config = _active_project
    if config is None:
        yaml_path = _Path.cwd() / PROJECT_CONFIG_FILENAME
        if yaml_path.exists():
            config = load_project_config(yaml_path)

    if config is None:
        return None

    save_project_to_db(db, config)
    db.commit()
    logger.info(
        "Imported project config '%s' from opal.project.yaml into the database", config.name
    )
    return config
