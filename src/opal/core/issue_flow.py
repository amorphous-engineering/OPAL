"""Issue ticket-state transitions: pending → in work → in review → done.

One home for the rules, shared by the API routes and the MCP tools. Every
function raises IssueFlowError (a 400 at the API) when the issue is in the wrong
state, stamps who/when, and audit-logs the change. Callers commit.
"""

from datetime import UTC, datetime

from sqlalchemy import and_, or_
from sqlalchemy.orm import Query, Session

from opal.core import notifications
from opal.core.audit import get_model_dict, log_create, log_update
from opal.db.models.issue import Containment, Issue, IssueStatus, IssueType, TicketState
from opal.db.models.issue_comment import IssueComment


class IssueFlowError(ValueError):
    """A transition refused; the message is shown to the user."""


def validate_close(issue: Issue, corrective_action: str | None = None) -> None:
    """Closing an undispositioned containment-bearing issue is impossible —
    disposition first, always. Advisory issues close freely. NC-type issues
    additionally require corrective action text (type-based, any containment).
    `corrective_action` overrides the stored text when a close request carries one."""
    if issue.containment_bearing and not issue.dispositioned:
        raise IssueFlowError(
            f"{issue.issue_number} is undispositioned; sign a disposition before closing"
        )
    issue_type = issue.issue_type.value if hasattr(issue.issue_type, "value") else issue.issue_type
    if issue_type == IssueType.NON_CONFORMANCE.value:
        corrective = corrective_action if corrective_action is not None else issue.corrective_action
        if not (corrective or "").strip():
            raise IssueFlowError(
                f"{issue.issue_number} is a non-conformance; corrective action is required to close"
            )


def _require_state(issue: Issue, state: TicketState, action: str) -> None:
    if issue.ticket_state != state.value:
        raise IssueFlowError(
            f"{issue.issue_number} is {issue.ticket_state.replace('_', ' ')}; cannot {action}"
        )


def start_work(db: Session, issue: Issue, user_id: int) -> None:
    """Advisory issue: pending → in work. Containment-bearing issues enter work
    by signing the disposition."""
    if issue.containment_bearing:
        raise IssueFlowError(f"{issue.issue_number} holds work; sign its disposition to start work")
    _require_state(issue, TicketState.PENDING, "start work")
    old = get_model_dict(issue)
    issue.work_started_at = datetime.now(UTC)
    issue.work_started_by_id = user_id
    log_update(db, issue, old, user_id)


def request_review(db: Session, issue: Issue, user_id: int) -> None:
    """In work → in review."""
    _require_state(issue, TicketState.IN_WORK, "submit for review")
    old = get_model_dict(issue)
    issue.review_requested_at = datetime.now(UTC)
    issue.review_requested_by_id = user_id
    log_update(db, issue, old, user_id)


def return_from_review(db: Session, issue: Issue, user_id: int, comment: str) -> IssueComment:
    """In review → in work; the comment is stored on the issue."""
    _require_state(issue, TicketState.IN_REVIEW, "return from review")
    if not comment.strip():
        raise IssueFlowError("A comment is required to return an issue")
    old = get_model_dict(issue)
    issue.review_requested_at = None
    issue.review_requested_by_id = None
    log_update(db, issue, old, user_id)
    note = IssueComment(
        issue_id=issue.id, user_id=user_id, body=f"Returned from review: {comment.strip()}"
    )
    db.add(note)
    db.flush()
    log_create(db, note, user_id)
    return note


def sign_off(db: Session, issue: Issue, user_id: int) -> None:
    """In review → done, under the closing rules. Callers run the same
    follow-ups as any close (hold transition, issue_closed notification)."""
    _require_state(issue, TicketState.IN_REVIEW, "sign off")
    validate_close(issue)
    old = get_model_dict(issue)
    issue.status = IssueStatus.CLOSED
    issue.closed_at = datetime.now(UTC)
    issue.closed_by_id = user_id
    log_update(db, issue, old, user_id)


def after_close(db: Session, issue: Issue, was_blocking: bool, user_id: int) -> None:
    """Follow-ups every close shares: the run may be clear, the watchers hear of it."""
    notifications.blocking_transition(db, issue.procedure_instance_id, was_blocking, user_id, issue)
    notifications.issue_closed(db, issue, user_id)


def filter_ticket_state(query: Query, states: list[str]) -> Query:
    """SQL twin of Issue.ticket_state for one or more states (OR). Accepts
    repeated values and comma lists."""
    wanted = {part.strip() for raw in states for part in raw.split(",") if part.strip()}
    invalid = wanted - {t.value for t in TicketState}
    if invalid:
        raise IssueFlowError(f"Invalid state: {', '.join(sorted(invalid))}")
    signed = and_(Issue.disposition_type.isnot(None), Issue.dispositioned_at.isnot(None))
    advisory = Issue.containment == Containment.ADVISORY
    open_ = Issue.status != IssueStatus.CLOSED
    quiet = and_(open_, Issue.review_requested_at.is_(None))
    started = or_(and_(advisory, Issue.work_started_at.isnot(None)), and_(~advisory, signed))
    clauses = {
        TicketState.DONE.value: Issue.status == IssueStatus.CLOSED,
        TicketState.IN_REVIEW.value: and_(open_, Issue.review_requested_at.isnot(None)),
        TicketState.IN_WORK.value: and_(quiet, started),
        TicketState.PENDING.value: and_(quiet, ~started),
    }
    return query.filter(or_(*(clauses[w] for w in wanted)))
