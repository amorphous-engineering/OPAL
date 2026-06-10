"""Baseline lifecycle enforcement for LifecycleMixin objects.

Enforcement lives here in one shared helper layer — the API routes and the
MCP server both call these functions, so the rules cannot drift between
entry points. Nothing here commits; callers own the transaction and the
audit logging for the object they act on (log_update/log_create at the
call site). Side-effect mutations callers never see — the predecessor
supersede and dependent stale flips — are audit-logged here, in the same
transaction, for the same no-drift reason.

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

from opal.core.audit import get_model_dict, log_update
from opal.db.base import LifecycleState


class LifecycleError(Exception):
    """A lifecycle rule was violated. API layers map this to HTTP 409."""


#: Columns owned by the lifecycle/identity machinery, never copied on revise.
#: stale is here because a new revision is by definition a fresh look.
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
    "stale",
}


def ensure_mutable(obj: Any) -> None:
    """Raise unless the object is in an editable state (draft/preliminary)."""
    if not obj.is_mutable:
        raise LifecycleError(
            f"{type(obj).__name__} {getattr(obj, 'id', '?')} is {obj.lifecycle_state} "
            "and immutable — use revise() to create a new revision"
        )


def baseline_blockers(obj: Any) -> list[str]:
    """Mechanically decidable reasons this object cannot baseline yet.

    Statement-bearing objects (requirements) get the full lint — every
    block_baseline finding blocks here, so the linter is the single source
    of truth for what a baselineable requirement looks like. Other lifecycle
    objects (future interfaces, ...) keep the generic field checks.
    """
    if hasattr(obj, "statement"):
        from opal.se.lint import baseline_lint_blockers

        return baseline_lint_blockers(obj)

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
            old_values = get_model_dict(predecessor)
            predecessor.lifecycle_state = LifecycleState.SUPERSEDED.value
            log_update(db, predecessor, old_values, user_id)
            mark_dependents_stale(db, predecessor, user_id)

    return obj


def mark_dependents_stale(db: Session, predecessor: Any, user_id: int | None = None) -> None:
    """Flag everything that depended on a now-superseded revision.

    Today: direct flow-down children (UX spec §7). Phase 2 verification
    staleness reuses this hook — VAs closed against the superseded revision
    get flagged identically, in the same transaction as the supersede.
    Staleness is informational only; it clears on edit or re-affirm.
    """
    cls = type(predecessor)
    if not (hasattr(predecessor, "stale") and hasattr(predecessor, "parent_id")):
        return
    children = db.query(cls).filter(cls.parent_id == predecessor.id, cls.deleted_at.is_(None)).all()
    for child in children:
        old_values = get_model_dict(child)
        child.stale = True
        log_update(db, child, old_values, user_id)


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
