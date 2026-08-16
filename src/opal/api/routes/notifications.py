"""Notifications API routes.

Everything here is scoped to the caller. There is no endpoint that reads or
writes another user's notifications, and none that creates one: notifications
are raised by the events that cause them (opal.core.notifications), never by a
client asserting that something happened.
"""

from datetime import datetime

from fastapi import APIRouter, HTTPException, Query
from pydantic import BaseModel, ConfigDict

from opal.api.deps import CurrentUserId, DbSession
from opal.core import notifications
from opal.db.models.notification import Notification, NotificationCategory, category_for

router = APIRouter(prefix="/notifications", tags=["notifications"])


class NotificationResponse(BaseModel):
    model_config = ConfigDict(from_attributes=True)

    id: int
    kind: str
    category: str
    priority: str
    title: str
    body: str | None
    href: str
    subject_type: str
    subject_id: int
    created_at: datetime
    read_at: datetime | None

    @classmethod
    def of(cls, row: Notification) -> "NotificationResponse":
        return cls(
            id=row.id,
            kind=row.kind,
            category=category_for(row.kind).value,
            priority=row.priority,
            title=row.title,
            body=row.body,
            href=row.href,
            subject_type=row.subject_type,
            subject_id=row.subject_id,
            created_at=row.created_at,
            read_at=row.read_at,
        )


class NotificationListResponse(BaseModel):
    items: list[NotificationResponse]
    unread_count: int


@router.get("", response_model=NotificationListResponse)
def list_notifications(
    db: DbSession,
    user_id: CurrentUserId,
    unread_only: bool = False,
    category: str | None = None,
    limit: int = Query(default=50, ge=1, le=200),
) -> NotificationListResponse:
    """The caller's undismissed notifications, newest first."""
    query = db.query(Notification).filter(
        Notification.user_id == user_id, Notification.dismissed_at.is_(None)
    )
    if unread_only:
        query = query.filter(Notification.read_at.is_(None))

    rows = query.order_by(Notification.created_at.desc(), Notification.id.desc()).limit(limit).all()

    if category:
        if category not in {c.value for c in NotificationCategory}:
            raise HTTPException(status_code=400, detail=f"Unknown category: {category}")
        rows = [row for row in rows if category_for(row.kind).value == category]

    return NotificationListResponse(
        items=[NotificationResponse.of(row) for row in rows],
        unread_count=notifications.unread_count(db, user_id),
    )


@router.get("/unread-count", response_model=dict)
def get_unread_count(db: DbSession, user_id: CurrentUserId) -> dict:
    """What the bell shows."""
    return {"unread_count": notifications.unread_count(db, user_id)}


@router.post("/{notification_id}/read", response_model=NotificationResponse)
def mark_notification_read(
    notification_id: int, db: DbSession, user_id: CurrentUserId
) -> NotificationResponse:
    row = notifications.mark_read(db, user_id, notification_id)
    if row is None:
        raise HTTPException(status_code=404, detail="Notification not found")
    db.commit()
    db.refresh(row)
    return NotificationResponse.of(row)


@router.post("/{notification_id}/dismiss", response_model=NotificationResponse)
def dismiss_notification(
    notification_id: int, db: DbSession, user_id: CurrentUserId
) -> NotificationResponse:
    row = notifications.dismiss(db, user_id, notification_id)
    if row is None:
        raise HTTPException(status_code=404, detail="Notification not found")
    db.commit()
    db.refresh(row)
    return NotificationResponse.of(row)


@router.post("/read-all", response_model=dict)
def mark_all_notifications_read(db: DbSession, user_id: CurrentUserId) -> dict:
    changed = notifications.mark_all_read(db, user_id)
    db.commit()
    return {"marked_read": changed}
