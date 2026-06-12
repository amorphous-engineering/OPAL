"""Disposition state machine and acceptance for risks.

Mirrors opal.se.lifecycle: enforcement lives in one shared helper layer —
the API routes and the MCP server both call these functions, so the rules
cannot drift between entry points. Nothing here commits; callers own the
transaction. Transitions are audit-logged here (with the note attached to
the audit entry) so every entry point records them identically.

The disposition set (NASA CRM Plan-step, elevate omitted):

    open | mitigate | watch | research | accepted | closed | realized

Dispositions are freely changeable except:
- accepted -> * requires a note (un-accepting a signature is auditable)
- accepted is only reachable through accept() — the signature moment
- realized is terminal — the risk's afterlife is its issue

Acceptance is per-revision-of-circumstance: scenario or score changes
after acceptance flip the disposition back to open (the signature covered
the risk *as scored*) via apply_acceptance_invalidation().
"""

from datetime import UTC, datetime
from typing import Any

from sqlalchemy.orm import Session

from opal.core.audit import get_model_dict, log_update
from opal.db.models.issue import IssueStatus
from opal.db.models.risk import Risk, RiskDisposition, RiskIssueLink, RiskIssueRole
from opal.risks.readiness import acceptance_blockers


class RiskDispositionError(Exception):
    """A disposition rule was violated. API layers map this to HTTP 409."""


#: Dispositions that count as live exposure. realized is excluded — the
#: departure happened; the exposure lives on as its issue, not as a risk.
OPEN_DISPOSITIONS = [
    d.value
    for d in RiskDisposition
    if d not in (RiskDisposition.CLOSED, RiskDisposition.REALIZED)
]


#: Fields the acceptance signature covers — changing any of these on an
#: accepted risk invalidates the acceptance. probability/impact included:
#: the signature states the score.
SIGNATURE_FIELDS = (
    "condition",
    "departure",
    "asset_part_id",
    "asset_text",
    "consequence",
    "probability",
    "impact",
)


def open_links(risk: Risk, role: str) -> list[RiskIssueLink]:
    """Links of the given role whose issue is still open work."""
    return [
        link
        for link in risk.issue_links
        if link.role == role
        and link.issue is not None
        and link.issue.deleted_at is None
        and link.issue.status != IssueStatus.CLOSED
    ]


def _log_transition(
    db: Session,
    risk: Risk,
    old_values: dict[str, Any],
    user_id: int | None,
    note: str | None,
) -> None:
    """Audit the change; the note rides in new_values (AuditLog has no note column)."""
    entry = log_update(db, risk, old_values, user_id)
    if entry is not None and note:
        entry.new_values = {**entry.new_values, "disposition_note": note}


def disposition_blockers(
    db: Session, risk: Risk, target: str, note: str | None = None
) -> list[str]:
    """Reasons this transition is refused — each names its requirement."""
    valid = {d.value for d in RiskDisposition}
    if target not in valid:
        return [f"unknown disposition '{target}'"]
    current = risk.disposition

    if current == RiskDisposition.REALIZED.value:
        return ["realized is terminal — the risk lives on as its linked issue"]
    if target == current:
        return [f"risk is already {target}"]
    if target == RiskDisposition.ACCEPTED.value:
        return ["acceptance requires the accept action — a signature, not a status change"]

    blockers: list[str] = []
    if current == RiskDisposition.ACCEPTED.value and not (note or "").strip():
        blockers.append("un-accepting a signed risk requires a note")

    if target == RiskDisposition.MITIGATE.value:
        if not open_links(risk, RiskIssueRole.MITIGATION.value):
            blockers.append(
                "mitigate requires at least one open linked issue (role: mitigation) — "
                "a mitigation is real when it has an issue with an owner"
            )
        if risk.residual_probability is None or risk.residual_impact is None:
            blockers.append("mitigate requires a residual score — the post-response target")
    elif target == RiskDisposition.WATCH.value:
        if not (risk.watch_observable or "").strip():
            blockers.append("watch requires an observable — what is being monitored")
        if not (risk.watch_threshold or "").strip():
            blockers.append("watch requires a threshold — when the watch trips")
    elif target == RiskDisposition.RESEARCH.value:
        if not open_links(risk, RiskIssueRole.RESEARCH.value) and not (
            risk.description or ""
        ).strip():
            blockers.append(
                "research requires a linked issue (role: research) or a narrative note"
            )
    elif target == RiskDisposition.CLOSED.value:
        if not (note or "").strip():
            blockers.append("closing requires a one-line close note")
    elif target == RiskDisposition.REALIZED.value:
        if risk.realized_issue_id is None:
            blockers.append(
                "realized requires a linked issue — the departure happened; "
                "its afterlife is a problem record"
            )

    return blockers


def set_disposition(
    db: Session,
    risk: Risk,
    target: str,
    user_id: int | None,
    note: str | None = None,
) -> Risk:
    """Transition the risk; raises RiskDispositionError naming each unmet requirement."""
    blockers = disposition_blockers(db, risk, target, note=note)
    if blockers:
        raise RiskDispositionError("; ".join(blockers))

    old_values = get_model_dict(risk)
    risk.disposition = target
    _log_transition(db, risk, old_values, user_id, note)
    return risk


def accept(
    db: Session,
    risk: Risk,
    user_id: int | None,
    rationale: str | None = None,
) -> Risk:
    """The signature moment. Requires a user and full acceptance readiness."""
    if user_id is None:
        raise RiskDispositionError("acceptance is a signature — it requires a user")

    old_values = get_model_dict(risk)
    if rationale is not None and rationale.strip():
        risk.acceptance_rationale = rationale.strip()

    blockers = acceptance_blockers(db, risk)
    if blockers:
        raise RiskDispositionError("; ".join(blockers))

    risk.disposition = RiskDisposition.ACCEPTED.value
    risk.accepted_by_id = user_id
    risk.accepted_at = datetime.now(UTC)
    _log_transition(db, risk, old_values, user_id, None)
    return risk


def apply_acceptance_invalidation(
    db: Session,
    risk: Risk,
    old_values: dict[str, Any],
    user_id: int | None,
) -> bool:
    """Re-disposition an accepted risk whose scenario or score just changed.

    Call after applying field edits, before commit, with old_values captured
    before the edit. The signature fields (accepted_by/at/rationale) are kept
    as history — the system refuses to let an old signature cover a new
    scenario, not to pretend the signature never happened.
    """
    if old_values.get("disposition") != RiskDisposition.ACCEPTED.value:
        return False
    if risk.disposition != RiskDisposition.ACCEPTED.value:
        return False

    changed = [
        field for field in SIGNATURE_FIELDS if old_values.get(field) != getattr(risk, field)
    ]
    if not changed:
        return False

    pre_revert = get_model_dict(risk)
    risk.disposition = RiskDisposition.OPEN.value
    _log_transition(
        db,
        risk,
        pre_revert,
        user_id,
        "re-dispositioned: scenario changed post-acceptance (" + ", ".join(changed) + ")",
    )
    return True


def stamp_review(db: Session, risks: list[Risk], user_id: int | None) -> int:
    """Stamp last_reviewed_* on each risk — the entire review ceremony."""
    now = datetime.now(UTC)
    for risk in risks:
        old_values = get_model_dict(risk)
        risk.last_reviewed_at = now
        risk.last_reviewed_by_id = user_id
        log_update(db, risk, old_values, user_id)
    return len(risks)
