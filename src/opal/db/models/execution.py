"""Procedure execution models."""

from datetime import datetime
from enum import Enum
from typing import Any

from sqlalchemy import JSON, Boolean, DateTime, ForeignKey, Integer, String, Text
from sqlalchemy.orm import Mapped, mapped_column, relationship

from opal.db.base import Base, IdMixin, TimestampMixin


class InstanceStatus(str, Enum):
    """Procedure instance status."""

    PENDING = "pending"
    IN_PROGRESS = "in_progress"
    COMPLETED = "completed"
    ABORTED = "aborted"


class StepStatus(str, Enum):
    """Step execution status."""

    PENDING = "pending"
    IN_PROGRESS = "in_progress"
    ON_HOLD = "on_hold"  # NC logged; blocked until all open NC dispositions terminal
    COMPLETED = "completed"  # Work done (leaf steps or sub-steps)
    AWAITING_SIGNOFF = "awaiting_signoff"  # Parent OP waiting for sign-off
    SIGNED_OFF = "signed_off"  # Parent OP signed off
    SKIPPED = "skipped"


class ProcedureInstance(Base, IdMixin, TimestampMixin):
    """Execution of a specific procedure version."""

    procedure_id: Mapped[int] = mapped_column(
        ForeignKey("master_procedure.id", ondelete="RESTRICT"), nullable=False, index=True
    )
    version_id: Mapped[int] = mapped_column(
        ForeignKey("procedure_version.id", ondelete="RESTRICT"),
        nullable=False,
        index=True,
        comment="Locked at start",
    )
    work_order_number: Mapped[str | None] = mapped_column(
        String(100), nullable=True, index=True, comment="For grouping related instances"
    )
    status: Mapped[InstanceStatus] = mapped_column(
        String(20), nullable=False, default=InstanceStatus.PENDING
    )
    started_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True), nullable=True)
    completed_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True), nullable=True)
    started_by_id: Mapped[int | None] = mapped_column(
        ForeignKey("user.id", ondelete="SET NULL"), nullable=True
    )
    participants: Mapped[list[dict[str, Any]] | None] = mapped_column(
        JSON, nullable=True, comment="Active users: [{user_id, joined_at, last_step}]"
    )

    # Scheduling fields
    scheduled_start_at: Mapped[datetime | None] = mapped_column(
        DateTime(timezone=True), nullable=True, comment="When work is planned to start"
    )
    target_completion_at: Mapped[datetime | None] = mapped_column(
        DateTime(timezone=True), nullable=True, comment="Due date for completion"
    )
    priority: Mapped[int] = mapped_column(
        Integer,
        nullable=False,
        default=0,
        comment="Higher = more urgent (0=normal, 1=high, 2=urgent)",
    )

    # Relationships
    procedure: Mapped["MasterProcedure"] = relationship(
        "MasterProcedure", back_populates="instances"
    )
    version: Mapped["ProcedureVersion"] = relationship(
        "ProcedureVersion", back_populates="instances"
    )
    started_by_user: Mapped["User | None"] = relationship(
        "User", back_populates="procedure_instances"
    )
    step_executions: Mapped[list["StepExecution"]] = relationship(
        "StepExecution",
        back_populates="instance",
        cascade="all, delete-orphan",
        order_by="StepExecution.step_number",
    )
    issues: Mapped[list["Issue"]] = relationship("Issue", back_populates="procedure_instance")
    attachments: Mapped[list["Attachment"]] = relationship(
        "Attachment", back_populates="procedure_instance"
    )
    consumptions: Mapped[list["InventoryConsumption"]] = relationship(
        "InventoryConsumption", back_populates="procedure_instance"
    )
    productions: Mapped[list["InventoryProduction"]] = relationship(
        "InventoryProduction", back_populates="procedure_instance"
    )

    @property
    def duration_seconds(self) -> int | None:
        """Calculate duration in seconds if completed."""
        if self.started_at and self.completed_at:
            return int((self.completed_at - self.started_at).total_seconds())
        return None

    def __repr__(self) -> str:
        return f"<ProcedureInstance(id={self.id}, procedure_id={self.procedure_id}, status={self.status})>"


class StepExecution(Base, IdMixin, TimestampMixin):
    """Execution of a single step within a procedure instance."""

    instance_id: Mapped[int] = mapped_column(
        ForeignKey("procedure_instance.id", ondelete="CASCADE"), nullable=False, index=True
    )
    step_number: Mapped[int] = mapped_column(
        Integer, nullable=False, comment="References step order from version snapshot"
    )
    status: Mapped[StepStatus] = mapped_column(
        String(20), nullable=False, default=StepStatus.PENDING
    )
    data_captured: Mapped[dict[str, Any] | None] = mapped_column(
        JSON, nullable=True, comment="Values matching step's required_data_schema"
    )
    started_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True), nullable=True)
    completed_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True), nullable=True)
    completed_by_id: Mapped[int | None] = mapped_column(
        ForeignKey("user.id", ondelete="SET NULL"), nullable=True
    )
    workcenter_id: Mapped[int | None] = mapped_column(
        ForeignKey("workcenter.id", ondelete="SET NULL"),
        nullable=True,
        index=True,
        comment="Actual workcenter where step was performed",
    )

    # Hierarchy tracking (preserved from version snapshot)
    step_number_str: Mapped[str] = mapped_column(
        String(20), nullable=False, default="1", comment="Display number like 1, 1.1, C1"
    )
    level: Mapped[int] = mapped_column(
        Integer, nullable=False, default=0, comment="0=parent OP, 1+=sub-step"
    )
    parent_step_order: Mapped[int | None] = mapped_column(
        Integer, nullable=True, comment="Order of parent step (for sub-steps)"
    )

    # Operator notes
    notes: Mapped[str | None] = mapped_column(
        Text, nullable=True, comment="Free-text operator notes"
    )

    # Sign-off fields (for parent OPs or steps with requires_signoff)
    signed_off_at: Mapped[datetime | None] = mapped_column(
        DateTime(timezone=True), nullable=True, comment="When OP was signed off"
    )
    signed_off_by_id: Mapped[int | None] = mapped_column(
        ForeignKey("user.id", ondelete="SET NULL"), nullable=True
    )

    # Redline / ad-hoc step fields. Non-NULL ad_hoc_issue_id marks the row as
    # an ad-hoc step inserted into a running execution as part of an NC.
    # The op-level row (level=0) and its sub-steps share the same issue_id
    # and host_order. Snapshot steps leave these NULL.
    ad_hoc_issue_id: Mapped[int | None] = mapped_column(
        ForeignKey("issue.id", ondelete="SET NULL"),
        nullable=True,
        index=True,
        comment="Issue (NC) that authorized this redline",
    )
    ad_hoc_host_order: Mapped[int | None] = mapped_column(
        Integer,
        nullable=True,
        comment="Snapshot step_number of the host op being gated",
    )
    title: Mapped[str | None] = mapped_column(
        String(255), nullable=True, comment="Used by ad-hoc rows; snapshot rows load from version"
    )
    instructions: Mapped[str | None] = mapped_column(Text, nullable=True, comment="Markdown")
    required_data_schema: Mapped[dict[str, Any] | None] = mapped_column(
        JSON, nullable=True, comment="Same shape as procedure_step.required_data_schema"
    )
    requires_signoff: Mapped[bool] = mapped_column(
        Boolean, nullable=False, default=False, comment="Ad-hoc sign-off flag"
    )

    # Relationships
    instance: Mapped["ProcedureInstance"] = relationship(
        "ProcedureInstance", back_populates="step_executions"
    )
    ad_hoc_issue: Mapped["Issue | None"] = relationship("Issue", foreign_keys=[ad_hoc_issue_id])
    completed_by_user: Mapped["User | None"] = relationship(
        "User", foreign_keys=[completed_by_id], back_populates="step_executions"
    )
    signed_off_by_user: Mapped["User | None"] = relationship(
        "User", foreign_keys=[signed_off_by_id], back_populates="step_signoffs"
    )
    workcenter: Mapped["Workcenter | None"] = relationship(
        "Workcenter", back_populates="step_executions"
    )
    attachments: Mapped[list["Attachment"]] = relationship(
        "Attachment", back_populates="step_execution"
    )
    consumptions: Mapped[list["InventoryConsumption"]] = relationship(
        "InventoryConsumption", back_populates="step_execution"
    )

    @property
    def duration_seconds(self) -> int | None:
        """Calculate duration in seconds if completed."""
        if self.started_at and self.completed_at:
            return int((self.completed_at - self.started_at).total_seconds())
        return None

    def __repr__(self) -> str:
        return f"<StepExecution(id={self.id}, instance_id={self.instance_id}, step={self.step_number}, status={self.status})>"
