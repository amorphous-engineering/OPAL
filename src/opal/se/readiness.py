"""Baseline readiness as structured checks — the dossier panel and queue payload.

Hard checks are a re-grouping of lint_requirement_row() block findings, so
this module agrees with what lifecycle.baseline() enforces by construction:
both consume the same findings. The parent-baselined check is relational
(needs the DB) and advisory — flowing down from an unbaselined parent is
suspect but never blocks.

Payload shape is shared by GET /api/requirements/{id}/readiness and the
future baseline queue:

    {ready: bool, checks: [{key, label, passed, severity, detail}]}
"""

from typing import Any

from sqlalchemy.orm import Session

from opal.db.base import LifecycleState
from opal.db.models import Requirement
from opal.se.lint import LintFinding, lint_requirement_row

_EDITABLE = (LifecycleState.DRAFT.value, LifecycleState.PRELIMINARY.value)


def _check(
    key: str,
    label: str,
    failing: list[LintFinding],
    severity: str = "hard",
    detail: str | None = None,
) -> dict[str, Any]:
    if detail is None and failing:
        messages = list(dict.fromkeys(f.message for f in failing))
        detail = messages[0] + (f" (+{len(messages) - 1} more)" if len(messages) > 1 else "")
    return {
        "key": key,
        "label": label,
        "passed": not failing,
        "severity": severity,
        "detail": detail,
    }


def readiness(db: Session, req: Requirement) -> dict[str, Any]:
    """Structured pass/fail checks for baselining one requirement."""
    block = [f for f in lint_requirement_row(req) if f.severity == "block_baseline"]

    rationale = [f for f in block if f.name == "rationale_present"]
    tbd = [f for f in block if f.name == "tbd_tbr_discipline" and "TBD" in f.message]
    tbr = [f for f in block if f.name == "tbd_tbr_discipline" and f.message.startswith("TBR")]
    verification = [f for f in block if f.name == "verification_method_set"]
    grouped = {id(f) for f in rationale + tbd + tbr + verification}
    rest = [f for f in block if id(f) not in grouped]

    checks = [
        _check("rationale_present", "rationale recorded", rationale),
        _check("no_tbd", "no TBD values", tbd),
        _check("tbr_fields", "TBR has owner and due date", tbr),
        _check("verification_method", "verification method set", verification),
        _check("lint_clean", "statement lint clean", rest),
    ]

    parent_detail = None
    if req.parent_id is not None:
        parent = db.get(Requirement, req.parent_id)
        if parent is not None and parent.lifecycle_state != LifecycleState.BASELINED.value:
            parent_detail = f"{parent.req_number} is {parent.lifecycle_state}"
    checks.append(
        {
            "key": "parent_baselined",
            "label": "parent is baselined",
            "passed": parent_detail is None,
            "severity": "warning",
            "detail": parent_detail,
        }
    )

    ready = req.lifecycle_state in _EDITABLE and all(
        c["passed"] for c in checks if c["severity"] == "hard"
    )
    return {"ready": ready, "checks": checks}


def ready_requirement_ids(db: Session) -> list[int]:
    """IDs of every draft/preliminary requirement that would baseline cleanly."""
    candidates = (
        db.query(Requirement)
        .filter(
            Requirement.deleted_at.is_(None),
            Requirement.lifecycle_state.in_(_EDITABLE),
        )
        .order_by(Requirement.level, Requirement.req_number)
        .all()
    )
    return [req.id for req in candidates if readiness(db, req)["ready"]]
