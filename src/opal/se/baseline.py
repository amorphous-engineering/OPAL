"""Baseline events: the shared commit path for queue batches and one-offs.

Every baseline commitment writes one BaselineEvent joined to the exact
requirement revision rows it locked — the project's configuration history.
Nothing here commits; callers own the transaction and audit logging,
matching the opal.se.lifecycle convention.
"""

from typing import Any

from sqlalchemy.orm import Session

from opal.db.models import BaselineEvent, BaselineEventItem, Requirement
from opal.se.lifecycle import baseline
from opal.se.readiness import readiness


def write_baseline_event(
    db: Session,
    reqs: list[Requirement],
    user_id: int | None,
    label: str | None = None,
    note: str | None = None,
) -> BaselineEvent:
    """Record one event over already-baselined revision rows."""
    event = BaselineEvent(label=label, note=note, signed_by_id=user_id)
    db.add(event)
    db.flush()
    for req in reqs:
        db.add(BaselineEventItem(event_id=event.id, requirement_id=req.id))
    db.flush()
    return event


def baseline_batch(
    db: Session,
    reqs: list[Requirement],
    user_id: int | None,
    label: str | None = None,
    note: str | None = None,
) -> tuple[BaselineEvent | None, list[dict[str, Any]]]:
    """Re-validate every item at commit time, then flip all or nothing.

    Returns (event, []) on success or (None, offenders) — offenders carry the
    failing hard-check keys so a mid-session edit by the other person surfaces
    instead of half-committing. No session state is mutated when offenders
    exist (validation happens before any lifecycle flip).
    """
    offenders: list[dict[str, Any]] = []
    for req in reqs:
        result = readiness(db, req)
        if not result["ready"]:
            offenders.append(
                {
                    "id": req.id,
                    "req_number": req.req_number,
                    "lifecycle_state": req.lifecycle_state,
                    "failing_checks": [
                        c["key"]
                        for c in result["checks"]
                        if c["severity"] == "hard" and not c["passed"]
                    ],
                }
            )
    if offenders:
        return None, offenders

    for req in reqs:
        baseline(db, req, user_id)
    return write_baseline_event(db, reqs, user_id, label=label, note=note), []
