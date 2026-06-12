"""Issue model.

Issues are the authorized container for off-nominal reality (AS9100 §8.7
lineage): when reality departs from the published procedure, work either
stops at the containment boundary or continues inside a ticket under a
signed disposition. Two gates, not one:

    raised → UNDISPOSITIONED → (disposition signed) → DISPOSITIONED → CLOSED

The blocking predicate is `undispositioned`, never `open`. A signed
disposition releases work immediately; closure is bookkeeping.
"""

from datetime import datetime
from enum import Enum

from sqlalchemy import DateTime, ForeignKey, String, Text
from sqlalchemy.orm import Mapped, mapped_column, relationship

from opal.db.base import Base, IdMixin, SoftDeleteMixin, TimestampMixin


class IssueType(str, Enum):
    """Issue type classification."""

    NON_CONFORMANCE = "non_conformance"
    BUG = "bug"
    TASK = "task"
    IMPROVEMENT = "improvement"


class IssueStatus(str, Enum):
    """Issue status — open or closed; the disposition gate is a separate,
    derived state (see Issue.disp_state)."""

    OPEN = "open"
    CLOSED = "closed"


class IssuePriority(str, Enum):
    """Issue priority level."""

    LOW = "low"
    MEDIUM = "medium"
    HIGH = "high"
    CRITICAL = "critical"


class DispositionType(str, Enum):
    """Disposition type (MIL-STD-1520 lineage)."""

    USE_AS_IS = "use_as_is"
    REWORK = "rework"
    REPAIR = "repair"
    SCRAP = "scrap"
    RETURN_TO_SUPPLIER = "return_to_supplier"
    NO_DEFECT = "no_defect"


class Containment(str, Enum):
    """What an undispositioned issue holds."""

    STEP = "step"
    OP = "op"
    WO = "wo"
    ADVISORY = "advisory"


# Widening moves up this ladder freely; narrowing releases a hold and is
# therefore audited with a note.
CONTAINMENT_RANK: dict[str, int] = {
    Containment.ADVISORY.value: 0,
    Containment.STEP.value: 1,
    Containment.OP.value: 2,
    Containment.WO.value: 3,
}


class Issue(Base, IdMixin, TimestampMixin, SoftDeleteMixin):
    """Issue tracker entry.

    Issues can be auto-created from non-conformances during procedure execution,
    or created manually for bugs, tasks, and improvements.
    """

    issue_number: Mapped[str] = mapped_column(
        String(20),
        nullable=False,
        unique=True,
        index=True,
        comment="Human-readable issue ID (e.g., IT-001)",
    )
    title: Mapped[str] = mapped_column(String(255), nullable=False, index=True)
    description: Mapped[str | None] = mapped_column(Text, nullable=True)
    issue_type: Mapped[IssueType] = mapped_column(
        String(20), nullable=False, default=IssueType.TASK
    )
    status: Mapped[IssueStatus] = mapped_column(
        String(30), nullable=False, default=IssueStatus.OPEN
    )
    priority: Mapped[IssuePriority] = mapped_column(
        String(20), nullable=False, default=IssuePriority.MEDIUM
    )

    # Containment: what this issue holds while undispositioned
    containment: Mapped[Containment] = mapped_column(
        String(20), nullable=False, default=Containment.ADVISORY
    )
    containment_step_id: Mapped[int | None] = mapped_column(
        ForeignKey("step_execution.id", ondelete="SET NULL"),
        nullable=True,
        comment="Boundary step ('resolve by 3.7'); for op/wo containment the boundary is implicit",
    )

    # Capture: the should-be / is pair belongs at the moment of discovery
    should_be: Mapped[str | None] = mapped_column(Text, nullable=True, comment="Expected condition")
    actual: Mapped[str | None] = mapped_column(Text, nullable=True, comment="Actual condition")
    steps_to_reproduce: Mapped[str | None] = mapped_column(
        Text, nullable=True, comment="Bug: repro steps"
    )
    expected_behavior: Mapped[str | None] = mapped_column(
        Text, nullable=True, comment="Bug: expected"
    )
    actual_behavior: Mapped[str | None] = mapped_column(Text, nullable=True, comment="Bug: actual")
    expected_benefit: Mapped[str | None] = mapped_column(
        Text, nullable=True, comment="Improvement: benefit"
    )

    # Disposition — the signature releases containment; root cause and
    # corrective action are required at NC closure, not at disposition.
    root_cause: Mapped[str | None] = mapped_column(Text, nullable=True)
    corrective_action: Mapped[str | None] = mapped_column(Text, nullable=True)
    disposition_type: Mapped[DispositionType | None] = mapped_column(String(30), nullable=True)
    disposition_rationale: Mapped[str | None] = mapped_column(Text, nullable=True)
    dispositioned_at: Mapped[datetime | None] = mapped_column(
        DateTime(timezone=True), nullable=True
    )

    # Optional links - an issue can link to any of these (or none)
    part_id: Mapped[int | None] = mapped_column(
        ForeignKey("part.id", ondelete="SET NULL"), nullable=True, index=True
    )
    procedure_id: Mapped[int | None] = mapped_column(
        ForeignKey("master_procedure.id", ondelete="SET NULL"), nullable=True, index=True
    )
    procedure_instance_id: Mapped[int | None] = mapped_column(
        ForeignKey("procedure_instance.id", ondelete="SET NULL"), nullable=True, index=True
    )
    raised_step_id: Mapped[int | None] = mapped_column(
        ForeignKey("step_execution.id", ondelete="SET NULL"),
        nullable=True,
        index=True,
        comment="Where it was found (execution-raised issues)",
    )
    raised_by_id: Mapped[int | None] = mapped_column(
        ForeignKey("user.id", ondelete="SET NULL"), nullable=True
    )
    assigned_to_id: Mapped[int | None] = mapped_column(
        ForeignKey("user.id", ondelete="SET NULL"), nullable=True, index=True
    )
    dispositioned_by_id: Mapped[int | None] = mapped_column(
        ForeignKey("user.id", ondelete="SET NULL"), nullable=True
    )

    # Relationships
    part: Mapped["Part | None"] = relationship("Part", back_populates="issues")
    procedure: Mapped["MasterProcedure | None"] = relationship(
        "MasterProcedure", back_populates="issues"
    )
    procedure_instance: Mapped["ProcedureInstance | None"] = relationship(
        "ProcedureInstance", back_populates="issues"
    )
    raised_step: Mapped["StepExecution | None"] = relationship(
        "StepExecution", foreign_keys=[raised_step_id]
    )
    containment_step: Mapped["StepExecution | None"] = relationship(
        "StepExecution", foreign_keys=[containment_step_id]
    )
    risk_links: Mapped[list["RiskIssueLink"]] = relationship(
        "RiskIssueLink", back_populates="issue", cascade="all, delete-orphan"
    )
    references: Mapped[list["IssueReference"]] = relationship(
        "IssueReference", back_populates="issue", cascade="all, delete-orphan"
    )
    raised_by: Mapped["User | None"] = relationship("User", foreign_keys=[raised_by_id])
    assigned_to: Mapped["User | None"] = relationship("User", foreign_keys=[assigned_to_id])
    dispositioned_by: Mapped["User | None"] = relationship(
        "User", foreign_keys=[dispositioned_by_id]
    )
    comments: Mapped[list["IssueComment"]] = relationship(
        "IssueComment",
        back_populates="issue",
        cascade="all, delete-orphan",
        order_by="IssueComment.created_at",
    )
    attachments: Mapped[list["Attachment"]] = relationship("Attachment", back_populates="issue")

    @property
    def dispositioned(self) -> bool:
        """Derived: disposition type and signature both set."""
        return self.disposition_type is not None and self.dispositioned_at is not None

    @property
    def containment_bearing(self) -> bool:
        """Disposition state exists only above advisory containment."""
        containment = (
            self.containment.value if hasattr(self.containment, "value") else self.containment
        )
        return containment != Containment.ADVISORY.value

    @property
    def disp_state(self) -> str:
        """Containment-bearing: undispositioned | dispositioned | closed.
        Advisory issues carry plain open | closed."""
        status = self.status.value if hasattr(self.status, "value") else self.status
        if status == IssueStatus.CLOSED.value:
            return "closed"
        if not self.containment_bearing:
            return status
        return "dispositioned" if self.dispositioned else "undispositioned"

    @property
    def is_blocking(self) -> bool:
        """True when this issue currently holds work: undispositioned with
        non-advisory containment."""
        return (
            self.deleted_at is None
            and self.containment_bearing
            and self.disp_state == "undispositioned"
        )

    @property
    def self_dispositioned(self) -> bool:
        """Signer == raiser. Visible, not forbidden — a two-person shop cannot
        always separate roles; the record can always say so."""
        return (
            self.raised_by_id is not None
            and self.dispositioned_by_id is not None
            and self.raised_by_id == self.dispositioned_by_id
        )

    def __repr__(self) -> str:
        return f"<Issue(id={self.id}, type={self.issue_type}, title='{self.title}', status={self.status})>"
