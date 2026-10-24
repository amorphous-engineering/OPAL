"""Baseline events — the project's configuration history.

One event per baseline commitment (a queue batch or a single dossier
baseline), joined to the exact requirement revision rows it locked. This is
the one-row answer to "when was this locked and by whom"; gates (SE-Module-4)
will reference these events.
"""

from typing import TYPE_CHECKING

from sqlalchemy import ForeignKey, String, Text
from sqlalchemy.orm import Mapped, mapped_column, relationship

from opal.db.base import Base, IdMixin, TimestampMixin

if TYPE_CHECKING:
    from opal.db.models.requirement import Requirement
    from opal.db.models.user import User


class BaselineEvent(Base, IdMixin, TimestampMixin):
    """A baseline commitment: who signed, optionally labelled (e.g. l0-freeze)."""

    label: Mapped[str | None] = mapped_column(
        String(100), nullable=True, comment="Free-text label, e.g. design-freeze"
    )
    note: Mapped[str | None] = mapped_column(Text, nullable=True)
    signed_by_id: Mapped[int | None] = mapped_column(
        ForeignKey("user.id", ondelete="SET NULL"), nullable=True
    )

    signed_by: Mapped["User | None"] = relationship("User")
    items: Mapped[list["BaselineEventItem"]] = relationship(
        "BaselineEventItem", back_populates="event", cascade="all, delete-orphan"
    )

    def __repr__(self) -> str:
        return f"<BaselineEvent(id={self.id}, label={self.label!r})>"


class BaselineEventItem(Base, IdMixin):
    """Join to the specific requirement revision row locked by the event."""

    event_id: Mapped[int] = mapped_column(
        ForeignKey("baseline_event.id", ondelete="CASCADE"), nullable=False, index=True
    )
    requirement_id: Mapped[int] = mapped_column(
        ForeignKey("requirement.id", ondelete="CASCADE"), nullable=False, index=True
    )

    event: Mapped["BaselineEvent"] = relationship("BaselineEvent", back_populates="items")
    requirement: Mapped["Requirement"] = relationship("Requirement")
