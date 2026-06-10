"""Red-only traceability queries for the home dashboard.

Principle 2 of the UX spec: checks find you. The widget shows only what is
red — overdue TBRs and block-lint drafts that have sat too long — plus
exactly one non-red line (ready-to-baseline count, from readiness).
"""

from datetime import UTC, datetime, timedelta
from typing import Any

from sqlalchemy.orm import Session

from opal.db.base import LifecycleState
from opal.db.models import Requirement, User
from opal.se.lint import lint_requirement_row

_LIVE_STATES = (
    LifecycleState.DRAFT.value,
    LifecycleState.PRELIMINARY.value,
    LifecycleState.BASELINED.value,
)


def overdue_tbrs(db: Session) -> list[dict[str, Any]]:
    """Non-superseded requirements whose TBR closure date has passed."""
    now = datetime.now(UTC)
    rows = (
        db.query(Requirement)
        .filter(
            Requirement.deleted_at.is_(None),
            Requirement.lifecycle_state.in_(_LIVE_STATES),
            Requirement.tbr.is_(True),
            Requirement.tbr_due.isnot(None),
        )
        .order_by(Requirement.tbr_due)
        .all()
    )
    overdue = []
    for req in rows:
        due = req.tbr_due if req.tbr_due.tzinfo else req.tbr_due.replace(tzinfo=UTC)
        if due >= now:
            continue
        owner = db.get(User, req.tbr_owner_id) if req.tbr_owner_id else None
        overdue.append(
            {
                "req": req,
                "owner_name": owner.name if owner else "(no owner)",
                "days_over": (now - due).days,
            }
        )
    return overdue


def old_block_lint_drafts(db: Session, older_than_days: int = 7) -> list[Requirement]:
    """Drafts older than the window still carrying block-severity lint."""
    cutoff = datetime.now(UTC) - timedelta(days=older_than_days)
    drafts = (
        db.query(Requirement)
        .filter(
            Requirement.deleted_at.is_(None),
            Requirement.lifecycle_state.in_(
                (LifecycleState.DRAFT.value, LifecycleState.PRELIMINARY.value)
            ),
        )
        .order_by(Requirement.req_number)
        .all()
    )
    result = []
    for req in drafts:
        created = req.created_at if req.created_at.tzinfo else req.created_at.replace(tzinfo=UTC)
        if created > cutoff:
            continue
        if any(f.severity == "block_baseline" for f in lint_requirement_row(req)):
            result.append(req)
    return result
