"""Requirement model — first-class systems-engineering requirements.

Promotes requirements from the opal.project.yaml catalog into the database
with flow-down hierarchy, lifecycle (baseline/revision) state, and TBD/TBR
tracking. Allocation to parts stays on PartRequirement (part.py); flow-down
(parent_id) and allocation are deliberately separate edges.
"""

from datetime import datetime
from enum import Enum
from typing import TYPE_CHECKING

from sqlalchemy import Boolean, DateTime, ForeignKey, Integer, String, Text, UniqueConstraint
from sqlalchemy.orm import Mapped, mapped_column, relationship

from opal.db.base import Base, IdMixin, LifecycleMixin, SoftDeleteMixin, TimestampMixin

if TYPE_CHECKING:
    from opal.db.models.part import PartRequirement
    from opal.db.models.user import User


class VerificationMethod(str, Enum):
    """How a requirement gets verified (AIDT)."""

    ANALYSIS = "analysis"
    INSPECTION = "inspection"
    DEMONSTRATION = "demonstration"
    TEST = "test"


class Requirement(Base, IdMixin, TimestampMixin, SoftDeleteMixin, LifecycleMixin):
    """A single requirement; revisions share req_number with bumped revision."""

    __table_args__ = (
        UniqueConstraint("req_number", "revision", name="uq_requirement_number_revision"),
    )

    req_number: Mapped[str] = mapped_column(
        String(20),
        nullable=False,
        index=True,
        comment="Human-readable number, e.g. REQ-0042. System-unique, never reused.",
    )
    title: Mapped[str] = mapped_column(String(255), nullable=False)
    statement: Mapped[str] = mapped_column(
        Text, nullable=False, comment="The shall statement — exactly one thought"
    )
    rationale: Mapped[str | None] = mapped_column(
        Text, nullable=True, comment="Why this requirement exists; required to baseline"
    )
    category: Mapped[str | None] = mapped_column(
        String(50),
        nullable=True,
        comment="functional, performance, interface, environmental, safety, ...",
    )
    parent_id: Mapped[int | None] = mapped_column(
        ForeignKey("requirement.id", ondelete="SET NULL"),
        nullable=True,
        index=True,
        comment="Flow-down hierarchy; level-0 roots have no parent",
    )
    level: Mapped[int] = mapped_column(
        Integer,
        nullable=False,
        default=0,
        comment="0 = mission/stakeholder, 1 = system, 2 = subsystem, ...",
    )
    verification_method: Mapped[str | None] = mapped_column(
        String(20), nullable=True, comment="analysis | inspection | demonstration | test"
    )

    # TBD/TBR tracking (SP-2016-6105 App. C): a TBR carries an owner and a
    # closure target; both must be set before the requirement can baseline.
    tbd: Mapped[bool] = mapped_column(
        Boolean, nullable=False, default=False, comment="Value not yet determined"
    )
    tbr: Mapped[bool] = mapped_column(
        Boolean, nullable=False, default=False, comment="Value to be reviewed/resolved"
    )
    tbr_owner_id: Mapped[int | None] = mapped_column(
        ForeignKey("user.id", ondelete="SET NULL"), nullable=True
    )
    tbr_due: Mapped[datetime | None] = mapped_column(DateTime(timezone=True), nullable=True)

    # Relationships
    parent: Mapped["Requirement | None"] = relationship(
        "Requirement",
        remote_side="Requirement.id",
        foreign_keys=[parent_id],
        back_populates="children",
    )
    children: Mapped[list["Requirement"]] = relationship(
        "Requirement", foreign_keys=[parent_id], back_populates="parent"
    )
    tbr_owner: Mapped["User | None"] = relationship("User", foreign_keys=[tbr_owner_id])
    part_links: Mapped[list["PartRequirement"]] = relationship(
        "PartRequirement", back_populates="requirement_ref"
    )

    def __repr__(self) -> str:
        return (
            f"<Requirement(id={self.id}, req_number='{self.req_number}', "
            f"rev={self.revision}, state={self.lifecycle_state})>"
        )
