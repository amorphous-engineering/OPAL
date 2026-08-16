"""Raising notifications, and deciding who receives them.

Every notification is raised from the place the thing actually happened, so
the trigger and the record can never disagree. Two rules hold everywhere:

**You are never notified of your own action.** The actor is dropped from the
recipient set. An inbox that tells you what you just did is noise, and it is
the fastest way to make people stop reading the inbox at all.

**Blocked/unblocked are derived, so they are diffed, not observed.**
``opal.core.holds`` computes holds live and stores nothing — there is no
moment where a row flips to "blocked". So callers wrap the mutation in
:func:`blocking_change`, which samples whether the work order had any blocker
before and after and raises the transition only when the *answer* changed.
That way ten issues raised against one run produce one BLOCKED notification,
and the run reports UNBLOCKED only when the last blocker clears.

Failures here never propagate: a notification that cannot be written must not
roll back the disposition that caused it.
"""

from __future__ import annotations

import contextlib
import logging
from collections.abc import Iterator, Sequence
from contextlib import contextmanager
from datetime import UTC, datetime

from sqlalchemy import or_
from sqlalchemy.orm import Session

from opal.db.models.execution import ProcedureInstance, StepExecution
from opal.db.models.issue import Containment, Issue, IssueStatus
from opal.db.models.notification import Notification, NotificationKind, NotificationPriority
from opal.db.models.user import User

logger = logging.getLogger("opal.notifications")

#: Issue priority -> notification priority. An issue's urgency is the reader's
#: urgency; there is no second scale to invent.
_PRIORITY_FROM_ISSUE: dict[str, str] = {
    "critical": NotificationPriority.CRITICAL.value,
    "high": NotificationPriority.HIGH.value,
    "medium": NotificationPriority.NORMAL.value,
    "low": NotificationPriority.LOW.value,
}


def _enum_value(obj: object) -> str | None:
    if obj is None:
        return None
    return obj.value if hasattr(obj, "value") else str(obj)


def _issue_priority(issue: Issue) -> str:
    return _PRIORITY_FROM_ISSUE.get(
        _enum_value(issue.priority) or "", NotificationPriority.NORMAL.value
    )


def _issue_href(issue: Issue) -> str:
    return f"/issues/{issue.id}"


def _instance_href(instance_id: int) -> str:
    return f"/executions/{instance_id}"


# ============ Recipients ============


def issue_audience(issue: Issue) -> set[int]:
    """People with a standing interest in an issue: its assignee and its raiser."""
    return {uid for uid in (issue.assigned_to_id, issue.raised_by_id) if uid is not None}


def instance_operators(db: Session, instance_id: int) -> set[int]:
    """Everyone who has actually worked the run.

    The person who started the work order, plus anyone who completed or signed
    off any step on it. Being named on a step is what makes a hold your
    problem — merely having the page open is not, which is why StepFocus
    (presence) is deliberately not consulted here.
    """
    operators: set[int] = set()

    instance = db.get(ProcedureInstance, instance_id)
    if instance is not None and instance.started_by_id is not None:
        operators.add(instance.started_by_id)

    rows = (
        db.query(StepExecution.completed_by_id, StepExecution.signed_off_by_id)
        .filter(StepExecution.instance_id == instance_id)
        .all()
    )
    for completed, signed in rows:
        operators.update(uid for uid in (completed, signed) if uid is not None)

    return operators


# ============ Fan-out ============


def notify(
    db: Session,
    *,
    recipients: Sequence[int] | set[int],
    kind: NotificationKind,
    title: str,
    href: str,
    subject_type: str,
    subject_id: int,
    body: str | None = None,
    priority: str = NotificationPriority.NORMAL.value,
    actor_id: int | None = None,
) -> list[Notification]:
    """Write one row per recipient. Caller commits.

    Drops the actor and anyone inactive or unknown. Returns the rows created,
    which is an empty list whenever the only candidate was the actor.
    """
    targets = {uid for uid in recipients if uid is not None and uid != actor_id}
    if not targets:
        return []

    active = {
        uid
        for (uid,) in db.query(User.id).filter(User.id.in_(targets), User.is_active.is_(True)).all()
    }
    if not active:
        return []

    created: list[Notification] = []
    for user_id in sorted(active):
        row = Notification(
            user_id=user_id,
            actor_id=actor_id,
            kind=kind.value,
            priority=priority,
            title=title,
            body=body,
            href=href,
            subject_type=subject_type,
            subject_id=subject_id,
        )
        db.add(row)
        created.append(row)

    db.flush()
    return created


# ============ Issue events ============


def _actor_name(db: Session, actor_id: int | None) -> str:
    if actor_id is None:
        return "Someone"
    user = db.get(User, actor_id)
    return user.name if user is not None and user.name else "Someone"


def issue_assigned(db: Session, issue: Issue, actor_id: int | None = None) -> list[Notification]:
    """The issue was assigned to someone. Only the new assignee hears about it."""
    if issue.assigned_to_id is None:
        return []
    return notify(
        db,
        recipients={issue.assigned_to_id},
        kind=NotificationKind.ISSUE_ASSIGNED,
        title=f"{issue.issue_number} assigned to you",
        body=issue.title,
        href=_issue_href(issue),
        subject_type="issue",
        subject_id=issue.id,
        priority=_issue_priority(issue),
        actor_id=actor_id,
    )


def issue_dispositioned(
    db: Session, issue: Issue, actor_id: int | None = None
) -> list[Notification]:
    disposition = _enum_value(issue.disposition_type) or "signed"
    return notify(
        db,
        recipients=issue_audience(issue),
        kind=NotificationKind.ISSUE_DISPOSITIONED,
        title=f"{issue.issue_number} dispositioned {disposition.replace('_', ' ')}",
        body=issue.title,
        href=_issue_href(issue),
        subject_type="issue",
        subject_id=issue.id,
        priority=_issue_priority(issue),
        actor_id=actor_id,
    )


def issue_commented(
    db: Session, issue: Issue, comment_body: str, actor_id: int | None = None
) -> list[Notification]:
    excerpt = comment_body.strip().replace("\n", " ")
    if len(excerpt) > 160:
        excerpt = excerpt[:157] + "..."
    return notify(
        db,
        recipients=issue_audience(issue),
        kind=NotificationKind.ISSUE_COMMENTED,
        title=f"{_actor_name(db, actor_id)} commented on {issue.issue_number}",
        body=excerpt,
        href=_issue_href(issue),
        subject_type="issue",
        subject_id=issue.id,
        priority=_issue_priority(issue),
        actor_id=actor_id,
    )


def issue_closed(db: Session, issue: Issue, actor_id: int | None = None) -> list[Notification]:
    return notify(
        db,
        recipients=issue_audience(issue),
        kind=NotificationKind.ISSUE_CLOSED,
        title=f"{issue.issue_number} closed",
        body=issue.title,
        href=_issue_href(issue),
        subject_type="issue",
        subject_id=issue.id,
        priority=NotificationPriority.NORMAL.value,
        actor_id=actor_id,
    )


# ============ Execution blocked / unblocked ============


def _instance_has_blocker(db: Session, instance_id: int) -> bool:
    """Same predicate as core.holds.blocking_issues_for_instance, as an exists.

    Kept in lockstep with holds deliberately: if this drifts, OPAL would
    announce a block the execution page does not show.
    """
    return (
        db.query(Issue.id)
        .filter(
            Issue.procedure_instance_id == instance_id,
            Issue.deleted_at.is_(None),
            Issue.status != IssueStatus.CLOSED,
            Issue.containment != Containment.ADVISORY,
            or_(Issue.disposition_type.is_(None), Issue.dispositioned_at.is_(None)),
        )
        .first()
        is not None
    )


def _execution_label(db: Session, instance_id: int) -> str:
    instance = db.get(ProcedureInstance, instance_id)
    if instance is None:
        return "Work order"
    return instance.work_order_number or (
        instance.procedure.name if instance.procedure is not None else "Work order"
    )


def has_blocker(db: Session, instance_id: int | None) -> bool:
    """Whether this work order currently has any blocking issue."""
    if instance_id is None:
        return False
    return _instance_has_blocker(db, instance_id)


@contextmanager
def blocking_change(
    db: Session, instance_id: int | None, actor_id: int | None = None, issue: Issue | None = None
) -> Iterator[None]:
    """Raise BLOCKED/UNBLOCKED if the wrapped mutation changed the answer.

    ``instance_id`` of None makes this a no-op, so callers can wrap
    unconditionally without testing whether the issue is bound to a work order.
    """
    if instance_id is None:
        yield
        return

    before = has_blocker(db, instance_id)
    yield
    blocking_transition(db, instance_id, before, actor_id=actor_id, issue=issue)


def blocking_transition(
    db: Session,
    instance_id: int | None,
    before: bool,
    actor_id: int | None = None,
    issue: Issue | None = None,
) -> None:
    """Report a blocked/unblocked transition against a `before` sample.

    The explicit form of :func:`blocking_change`, for call sites whose
    mutation is too long to wrap in a ``with`` block. Reports only a genuine
    transition: a run that was already blocked and gains a second blocker
    stays quiet, and it goes UNBLOCKED only when the last blocker clears.
    """
    if instance_id is None:
        return

    db.flush()
    after = has_blocker(db, instance_id)
    if before == after:
        return

    with contextlib.suppress(Exception):
        label = _execution_label(db, instance_id)
        recipients = instance_operators(db, instance_id)
        if after:
            notify(
                db,
                recipients=recipients,
                kind=NotificationKind.EXECUTION_BLOCKED,
                title=f"{label} is blocked",
                body=(
                    f"{issue.issue_number} — {issue.title}"
                    if issue is not None
                    else "An undispositioned issue is holding this work order."
                ),
                href=_instance_href(instance_id),
                subject_type="procedure_instance",
                subject_id=instance_id,
                priority=NotificationPriority.HIGH.value,
                actor_id=actor_id,
            )
        else:
            notify(
                db,
                recipients=recipients,
                kind=NotificationKind.EXECUTION_UNBLOCKED,
                title=f"{label} is unblocked",
                body="Every blocking issue is dispositioned or closed.",
                href=_instance_href(instance_id),
                subject_type="procedure_instance",
                subject_id=instance_id,
                priority=NotificationPriority.HIGH.value,
                actor_id=actor_id,
            )


# ============ Reading ============


def unread_count(db: Session, user_id: int) -> int:
    return (
        db.query(Notification)
        .filter(
            Notification.user_id == user_id,
            Notification.read_at.is_(None),
            Notification.dismissed_at.is_(None),
        )
        .count()
    )


def recent(db: Session, user_id: int, limit: int = 8) -> list[Notification]:
    """Newest undismissed notifications — what the bell shows."""
    return (
        db.query(Notification)
        .filter(Notification.user_id == user_id, Notification.dismissed_at.is_(None))
        .order_by(Notification.created_at.desc(), Notification.id.desc())
        .limit(limit)
        .all()
    )


def mark_read(db: Session, user_id: int, notification_id: int) -> Notification | None:
    """Mark one notification read. Scoped to the owner — caller commits."""
    row = (
        db.query(Notification)
        .filter(Notification.id == notification_id, Notification.user_id == user_id)
        .first()
    )
    if row is None:
        return None
    if row.read_at is None:
        row.read_at = datetime.now(UTC)
    return row


def mark_all_read(db: Session, user_id: int) -> int:
    """Mark every unread notification read. Returns how many changed."""
    now = datetime.now(UTC)
    return (
        db.query(Notification)
        .filter(Notification.user_id == user_id, Notification.read_at.is_(None))
        .update({Notification.read_at: now}, synchronize_session=False)
    )


def dismiss(db: Session, user_id: int, notification_id: int) -> Notification | None:
    """Remove a notification from the reader's inbox. Caller commits."""
    row = (
        db.query(Notification)
        .filter(Notification.id == notification_id, Notification.user_id == user_id)
        .first()
    )
    if row is None:
        return None
    now = datetime.now(UTC)
    row.dismissed_at = now
    if row.read_at is None:
        row.read_at = now
    return row
