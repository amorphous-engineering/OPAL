"""Per-user notification rows.

One row per recipient per event — fanned out at the moment the event happens,
not derived on read. That is deliberate: read state, dismissal and priority
are properties of *a person's* relationship to an event, and there is nowhere
to put them on a shared record.

A notification is a pointer, never a copy. `title`/`body` are the wording at
the time it fired; `subject_type` + `subject_id` and `href` are how the reader
gets to the live record. Nothing here is a source of truth — deleting every
row loses history, not state.
"""

from datetime import datetime
from enum import Enum

from sqlalchemy import DateTime, ForeignKey, Index, String, Text
from sqlalchemy.orm import Mapped, mapped_column, relationship

from opal.db.base import Base, IdMixin, TimestampMixin


class NotificationKind(str, Enum):
    """What happened. Grouped into categories for the inbox filters."""

    ISSUE_ASSIGNED = "issue_assigned"
    ISSUE_DISPOSITIONED = "issue_dispositioned"
    ISSUE_COMMENTED = "issue_commented"
    ISSUE_CLOSED = "issue_closed"
    EXECUTION_BLOCKED = "execution_blocked"
    EXECUTION_UNBLOCKED = "execution_unblocked"


class NotificationCategory(str, Enum):
    """Inbox grouping. Derived from kind — never stored twice."""

    ISSUES = "issues"
    EXECUTIONS = "executions"


class NotificationPriority(str, Enum):
    """Ordering weight for the inbox. Mirrors IssuePriority's vocabulary so a
    notification about an issue can carry the issue's own urgency."""

    LOW = "low"
    NORMAL = "normal"
    HIGH = "high"
    CRITICAL = "critical"


#: kind -> category. The inbox filters on this; it is not a column.
_CATEGORY_BY_KIND: dict[NotificationKind, NotificationCategory] = {
    NotificationKind.ISSUE_ASSIGNED: NotificationCategory.ISSUES,
    NotificationKind.ISSUE_DISPOSITIONED: NotificationCategory.ISSUES,
    NotificationKind.ISSUE_COMMENTED: NotificationCategory.ISSUES,
    NotificationKind.ISSUE_CLOSED: NotificationCategory.ISSUES,
    NotificationKind.EXECUTION_BLOCKED: NotificationCategory.EXECUTIONS,
    NotificationKind.EXECUTION_UNBLOCKED: NotificationCategory.EXECUTIONS,
}

#: Sort weight for "by priority" on the inbox. Higher sorts first.
_PRIORITY_RANK: dict[str, int] = {
    NotificationPriority.CRITICAL.value: 3,
    NotificationPriority.HIGH.value: 2,
    NotificationPriority.NORMAL.value: 1,
    NotificationPriority.LOW.value: 0,
}


def category_for(kind: NotificationKind | str) -> NotificationCategory:
    """Category a kind belongs to; unknown kinds fall back to ISSUES."""
    value = kind.value if isinstance(kind, NotificationKind) else kind
    try:
        return _CATEGORY_BY_KIND[NotificationKind(value)]
    except ValueError:
        return NotificationCategory.ISSUES


class Notification(Base, IdMixin, TimestampMixin):
    """One event, addressed to one person."""

    __tablename__ = "notification"

    user_id: Mapped[int] = mapped_column(
        ForeignKey("user.id", ondelete="CASCADE"),
        nullable=False,
        index=True,
        comment="Recipient",
    )
    actor_id: Mapped[int | None] = mapped_column(
        ForeignKey("user.id", ondelete="SET NULL"),
        nullable=True,
        comment="Who caused it; NULL when the system did",
    )
    kind: Mapped[str] = mapped_column(String(40), nullable=False, index=True)
    priority: Mapped[str] = mapped_column(
        String(16), nullable=False, default=NotificationPriority.NORMAL.value
    )

    title: Mapped[str] = mapped_column(String(255), nullable=False)
    body: Mapped[str | None] = mapped_column(Text, nullable=True)
    href: Mapped[str] = mapped_column(
        String(500), nullable=False, comment="Where the reader goes to see the live record"
    )

    subject_type: Mapped[str] = mapped_column(
        String(40), nullable=False, comment="e.g. issue, procedure_instance"
    )
    subject_id: Mapped[int] = mapped_column(nullable=False)

    read_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True), nullable=True)
    dismissed_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True), nullable=True)

    # Relationships
    user: Mapped["User"] = relationship("User", foreign_keys=[user_id])  # noqa: F821
    actor: Mapped["User | None"] = relationship("User", foreign_keys=[actor_id])  # noqa: F821

    __table_args__ = (
        # The bell's query: this user's undismissed rows, newest first.
        Index("ix_notification_user_created", "user_id", "created_at"),
    )

    @property
    def category(self) -> NotificationCategory:
        return category_for(self.kind)

    @property
    def is_read(self) -> bool:
        return self.read_at is not None

    @property
    def priority_rank(self) -> int:
        return _PRIORITY_RANK.get(self.priority, 1)

    def __repr__(self) -> str:
        return f"<Notification(id={self.id}, user_id={self.user_id}, kind={self.kind!r})>"
