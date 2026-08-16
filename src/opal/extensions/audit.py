"""Audit rows for the extension registry.

``opal.core.audit`` writes ``record_id=instance.id``, which assumes an integer
primary key. ``Extension`` is keyed by its manifest id, so — exactly as
``config.save_project_to_db`` does for ``app_setting`` — these helpers store 0
in ``record_id`` and carry the real key inside the values payload.
"""

from __future__ import annotations

from datetime import UTC, datetime
from typing import Any

from sqlalchemy.orm import Session

from opal.db.models.audit import AuditAction, AuditLog
from opal.db.models.extension import Extension

#: record_id sentinel for string-keyed tables; the key lives in the payload.
_STRING_KEY_SENTINEL = 0


def snapshot(row: Extension) -> dict[str, Any]:
    """The audit-visible state of an extension row."""
    return {
        "id": row.id,
        "name": row.name,
        "version": row.version,
        "origin": row.origin,
        "enabled": row.enabled,
        "checksum": row.checksum,
    }


def _log(
    db: Session,
    action: AuditAction,
    old_values: dict[str, Any] | None,
    new_values: dict[str, Any] | None,
    user_id: int | None,
) -> AuditLog:
    entry = AuditLog(
        timestamp=datetime.now(UTC),
        table_name=Extension.__tablename__,
        record_id=_STRING_KEY_SENTINEL,
        action=action,
        user_id=user_id,
        old_values=old_values,
        new_values=new_values,
    )
    db.add(entry)
    return entry


def log_install(db: Session, row: Extension, user_id: int | None = None) -> AuditLog:
    return _log(db, AuditAction.CREATE, None, snapshot(row), user_id)


def log_change(
    db: Session, row: Extension, old_values: dict[str, Any], user_id: int | None = None
) -> AuditLog | None:
    new_values = snapshot(row)
    if new_values == old_values:
        return None
    return _log(db, AuditAction.UPDATE, old_values, new_values, user_id)


def log_uninstall(db: Session, row: Extension, user_id: int | None = None) -> AuditLog:
    return _log(db, AuditAction.DELETE, snapshot(row), None, user_id)
