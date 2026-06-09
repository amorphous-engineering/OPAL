"""Baseline lifecycle enforcement for LifecycleMixin objects.

Enforcement lives here in one shared helper layer — the API routes and the
MCP server both call these functions, so the rules cannot drift between
entry points. Nothing here commits; callers own the transaction and the
audit logging (log_update/log_create at the call site).

State machine (NPR 7123.1D App. F terminology):

    draft -> preliminary -> baselined -> superseded | cancelled

- Baselined objects are immutable. Editing one requires an explicit
  revise(), which returns a NEW draft row (revision + 1, supersedes_id set).
  The old row stays the effective baseline until the new revision itself
  baselines, at which point the predecessor flips to superseded.
- Baseline preconditions that are mechanically decidable are enforced here
  (rationale present; TBD resolved; TBR has owner + due date). The fuller
  write-time linter is advisory and lives separately; only baseline blocks.
"""

from datetime import UTC, datetime
from typing import Any

from sqlalchemy import inspect as sa_inspect
from sqlalchemy.orm import Session

from opal.db.base import LifecycleState


class LifecycleError(Exception):
    """A lifecycle rule was violated. API layers map this to HTTP 409."""


#: Columns owned by the lifecycle/identity machinery, never copied on revise.
_NON_COPYABLE = {
    "id",
    "lifecycle_state",
    "revision",
    "supersedes_id",
    "baselined_at",
    "baselined_by_id",
    "created_at",
    "updated_at",
    "deleted_at",
}


def ensure_mutable(obj: Any) -> None:
    """Raise unless the object is in an editable state (draft/preliminary)."""
    if not obj.is_mutable:
        raise LifecycleError(
            f"{type(obj).__name__} {getattr(obj, 'id', '?')} is {obj.lifecycle_state} "
            "and immutable — use revise() to create a new revision"
        )


def baseline_blockers(obj: Any) -> list[str]:
    """Mechanically decidable reasons this object cannot baseline yet."""
    blockers: list[str] = []
    if hasattr(obj, "rationale") and not (obj.rationale or "").strip():
        blockers.append("rationale is required to baseline")
    if getattr(obj, "tbd", False):
        blockers.append("statement contains a TBD value; resolve it before baselining")
    if getattr(obj, "tbr", False):
        if not getattr(obj, "tbr_owner_id", None):
            blockers.append("TBR requires an owner before baselining")
        if not getattr(obj, "tbr_due", None):
            blockers.append("TBR requires a closure due date before baselining")
    return blockers


def baseline(db: Session, obj: Any, user_id: int | None) -> Any:
    """Baseline a draft/preliminary object; supersede its predecessor if any."""
    if obj.lifecycle_state not in (
        LifecycleState.DRAFT.value,
        LifecycleState.PRELIMINARY.value,
    ):
        raise LifecycleError(
            f"cannot baseline from state '{obj.lifecycle_state}' "
            "(only draft or preliminary objects can baseline)"
        )

    blockers = baseline_blockers(obj)
    if blockers:
        raise LifecycleError("; ".join(blockers))

    obj.lifecycle_state = LifecycleState.BASELINED.value
    obj.baselined_at = datetime.now(UTC)
    obj.baselined_by_id = user_id

    # The predecessor stays the effective baseline until this moment.
    if obj.supersedes_id is not None:
        predecessor = db.get(type(obj), obj.supersedes_id)
        if predecessor is not None and predecessor.is_baselined:
            predecessor.lifecycle_state = LifecycleState.SUPERSEDED.value

    return obj


def revise(db: Session, obj: Any, **overrides: Any) -> Any:
    """Create the next revision of a baselined object as a new draft row.

    Copies all data columns, bumps revision, points supersedes_id at the
    source. Field changes can be applied in the same call via overrides.
    The caller adds audit logging and commits.
    """
    if not obj.is_baselined:
        raise LifecycleError(
            f"cannot revise from state '{obj.lifecycle_state}' "
            "(only baselined objects can be revised; drafts are edited in place)"
        )

    bad = set(overrides) & _NON_COPYABLE
    if bad:
        raise LifecycleError(f"cannot override lifecycle-managed fields: {sorted(bad)}")

    cls = type(obj)
    values = {
        col.key: getattr(obj, col.key)
        for col in sa_inspect(cls).columns
        if col.key not in _NON_COPYABLE
    }
    values.update(overrides)

    new_obj = cls(
        **values,
        revision=obj.revision + 1,
        supersedes_id=obj.id,
        lifecycle_state=LifecycleState.DRAFT.value,
    )
    db.add(new_obj)
    db.flush()
    return new_obj


def cancel(db: Session, obj: Any) -> Any:
    """Cancel an object (terminal). Allowed from any non-terminal state."""
    if obj.lifecycle_state in (
        LifecycleState.SUPERSEDED.value,
        LifecycleState.CANCELLED.value,
    ):
        raise LifecycleError(f"cannot cancel from terminal state '{obj.lifecycle_state}'")
    obj.lifecycle_state = LifecycleState.CANCELLED.value
    return obj
