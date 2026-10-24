"""Audit log API: who changed what, with field-level detail."""

from datetime import UTC, date, datetime, timedelta
from typing import Any

from fastapi import APIRouter, HTTPException, Query
from pydantic import BaseModel
from sqlalchemy.orm import Session

from opal.api.deps import DbSession
from opal.core.audit_refs import entity_label, resolve_entities
from opal.db.models.audit import AuditLog
from opal.db.models.part import Part
from opal.db.models.user import User

router = APIRouter(prefix="/audit", tags=["audit"])

#: Columns that change on every write and say nothing about intent.
_NOISE_FIELDS = frozenset({"updated_at"})
#: Columns whose integer value names a user.
_USER_FIELDS = frozenset({"user_id", "assigned_to_id", "owner_id"})


class FieldChange(BaseModel):
    field: str
    old: Any = None
    new: Any = None
    # Readable stand-ins for foreign keys (user / part), when resolvable.
    old_label: str | None = None
    new_label: str | None = None


class AuditEntry(BaseModel):
    id: int
    timestamp: datetime
    action: str
    entity_type: str
    entity_label: str
    record_label: str | None
    href: str | None
    user_id: int | None
    user_name: str | None
    changes: list[FieldChange]


class AuditListResponse(BaseModel):
    items: list[AuditEntry]
    total: int


class EntityTypeOption(BaseModel):
    value: str
    label: str


class UserOption(BaseModel):
    id: int
    name: str


class AuditFacets(BaseModel):
    entity_types: list[EntityTypeOption]
    users: list[UserOption]


def _action(entry: AuditLog) -> str:
    return entry.action.value if hasattr(entry.action, "value") else str(entry.action)


def _parse_bound(value: str | None, name: str, end: bool) -> datetime | None:
    """A YYYY-MM-DD day or a full ISO 8601 instant, as a UTC instant.

    A bare day as an upper bound includes that whole day (exclusive next midnight).
    """
    if not value:
        return None
    try:
        if len(value) == 10:
            d = date.fromisoformat(value)
            dt = datetime(d.year, d.month, d.day, tzinfo=UTC)
            return dt + timedelta(days=1) if end else dt
        dt = datetime.fromisoformat(value)
    except ValueError:
        raise HTTPException(status_code=422, detail=f"{name} must be ISO 8601") from None
    return dt.astimezone(UTC) if dt.tzinfo else dt.replace(tzinfo=UTC)


def _raw_changes(entry: AuditLog) -> list[tuple[str, Any, Any]]:
    """(field, old, new) triples. Updates keep only fields that changed; creates and
    deletes list the populated fields."""
    action = _action(entry)
    old, new = entry.old_values or {}, entry.new_values or {}
    if action == "update":
        return [(k, old.get(k), v) for k, v in new.items() if k not in _NOISE_FIELDS]
    if action == "create":
        return [(k, None, v) for k, v in new.items() if v is not None and k != "id"]
    return [(k, v, None) for k, v in old.items() if v is not None and k != "id"]


@router.get("", response_model=AuditListResponse)
def list_audit(
    db: DbSession,
    table_name: str | None = None,
    record_id: int | None = None,
    action: str | None = None,
    user_id: int | None = None,
    date_from: str | None = Query(None, description="YYYY-MM-DD or ISO 8601 instant, inclusive"),
    date_to: str | None = Query(None, description="YYYY-MM-DD (whole day) or ISO 8601, exclusive"),
    skip: int = Query(0, ge=0),
    limit: int = Query(100, ge=1, le=500),
) -> AuditListResponse:
    """Audit entries, newest first."""
    query = db.query(AuditLog)
    if table_name:
        query = query.filter(AuditLog.table_name == table_name)
    if record_id is not None:
        query = query.filter(AuditLog.record_id == record_id)
    if action:
        query = query.filter(AuditLog.action == action)
    if user_id is not None:
        query = query.filter(AuditLog.user_id == user_id)
    start = _parse_bound(date_from, "date_from", end=False)
    stop = _parse_bound(date_to, "date_to", end=True)
    if start:
        query = query.filter(AuditLog.timestamp >= start)
    if stop:
        query = query.filter(AuditLog.timestamp < stop)

    total = query.count()
    entries = (
        query.order_by(AuditLog.timestamp.desc(), AuditLog.id.desc())
        .offset(skip)
        .limit(limit)
        .all()
    )
    return AuditListResponse(items=audit_entries(db, entries), total=total)


def audit_entries(db: Session, entries: list[AuditLog]) -> list[AuditEntry]:
    """Resolve audit rows to readable entries (shared with the overview feed)."""
    refs = resolve_entities(db, {(e.table_name, e.record_id) for e in entries})
    raw = {e.id: _raw_changes(e) for e in entries}

    # Foreign keys that read better as a name: users, and parts.
    user_ids = {e.user_id for e in entries if e.user_id}
    part_ids: set[int] = set()
    for triples in raw.values():
        for field, old, new in triples:
            for v in (old, new):
                if not isinstance(v, int) or isinstance(v, bool):
                    continue
                if field in _USER_FIELDS or field.endswith("_by_id"):
                    user_ids.add(v)
                elif field == "part_id":
                    part_ids.add(v)
    users = {u.id: u.name for u in db.query(User).filter(User.id.in_(user_ids)).all()}
    parts = {
        p.id: p.internal_pn or p.name for p in db.query(Part).filter(Part.id.in_(part_ids)).all()
    }

    def label_for(field: str, value: Any) -> str | None:
        if not isinstance(value, int) or isinstance(value, bool):
            return None
        if field in _USER_FIELDS or field.endswith("_by_id"):
            return users.get(value)
        if field == "part_id":
            return parts.get(value)
        return None

    out: list[AuditEntry] = []
    for e in entries:
        ref = refs[(e.table_name, e.record_id)]
        out.append(
            AuditEntry(
                id=e.id,
                timestamp=e.timestamp,
                action=_action(e),
                entity_type=e.table_name,
                entity_label=entity_label(e.table_name),
                record_label=ref.label,
                href=ref.href,
                user_id=e.user_id,
                user_name=users.get(e.user_id) if e.user_id else None,
                changes=[
                    FieldChange(
                        field=f,
                        old=o,
                        new=n,
                        old_label=label_for(f, o),
                        new_label=label_for(f, n),
                    )
                    for f, o, n in raw[e.id]
                ],
            )
        )
    return out


@router.get("/facets", response_model=AuditFacets)
def audit_facets(db: DbSession) -> AuditFacets:
    """Filter options: entity types present in the log, and users who made entries."""
    tables = [r[0] for r in db.query(AuditLog.table_name).distinct().all()]
    user_rows = (
        db.query(User.id, User.name)
        .filter(User.id.in_(db.query(AuditLog.user_id).filter(AuditLog.user_id.isnot(None))))
        .order_by(User.name)
        .all()
    )
    return AuditFacets(
        entity_types=sorted(
            (EntityTypeOption(value=t, label=entity_label(t)) for t in tables),
            key=lambda o: o.label,
        ),
        users=[UserOption(id=i, name=n) for i, n in user_rows],
    )
