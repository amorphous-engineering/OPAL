"""Part model."""

from datetime import datetime
from decimal import Decimal
from enum import Enum
from typing import TYPE_CHECKING, Any

from sqlalchemy import JSON, Boolean, DateTime, ForeignKey, Integer, Numeric, String, Text
from sqlalchemy.orm import Mapped, mapped_column, relationship

from opal.db.base import Base, IdMixin, SoftDeleteMixin, TimestampMixin

if TYPE_CHECKING:
    from opal.db.models.user import User


class TrackingType(str, Enum):
    """How inventory for this part is tracked."""

    BULK = "bulk"  # One OPAL number for a batch/box (e.g., fasteners)
    SERIALIZED = "serialized"  # Each unit gets its own OPAL number


class ProcurementType(str, Enum):
    """How this part comes to exist — declares which sections expect content.

    make = built in-house (a BOM is expected); buy = purchased (suppliers
    and PO lines are expected); both = made and bought. The declaration
    governs expected emptiness only — actual data always renders.
    """

    MAKE = "make"
    BUY = "buy"
    BOTH = "both"


class Part(Base, IdMixin, TimestampMixin, SoftDeleteMixin):
    """Part in the inventory system.

    IDs are system-unique, auto-incrementing, and never reused.
    """

    internal_pn: Mapped[str | None] = mapped_column(
        String(50),
        nullable=True,
        unique=True,
        index=True,
        comment="Internal part number from project config (e.g., PO/1-001)",
    )
    external_pn: Mapped[str | None] = mapped_column(
        String(255), nullable=True, index=True, comment="Manufacturer/supplier part number"
    )
    name: Mapped[str] = mapped_column(String(255), nullable=False, index=True)
    description: Mapped[str | None] = mapped_column(Text, nullable=True)
    category: Mapped[str | None] = mapped_column(String(100), nullable=True, index=True)
    unit_of_measure: Mapped[str] = mapped_column(
        String(20), nullable=False, default="ea", comment="ea, kg, m, etc."
    )
    metadata_: Mapped[dict[str, Any] | None] = mapped_column(
        "metadata", JSON, nullable=True, comment="Flexible additional fields"
    )
    tracking_type: Mapped[TrackingType] = mapped_column(
        String(20),
        nullable=False,
        default=TrackingType.SERIALIZED,
        comment="bulk = one OPAL per batch, serialized = one OPAL per unit (default)",
    )
    procurement: Mapped[ProcurementType] = mapped_column(
        String(10),
        nullable=False,
        default=ProcurementType.MAKE,
        server_default="make",
        index=True,
        comment="make = in-house (BOM expected), buy = purchased (suppliers/POs expected), both",
    )

    # Tiered inventory classification; levels and their semantics are
    # project-configured (TierConfig in opal.project)
    tier: Mapped[int] = mapped_column(
        Integer,
        nullable=False,
        default=1,
        index=True,
        comment="Inventory tier level, as configured in the project",
    )

    # Low stock threshold
    reorder_point: Mapped[Decimal | None] = mapped_column(
        Numeric(precision=15, scale=4),
        nullable=True,
        comment="Quantity threshold below which part is considered low stock",
    )

    # Tooling & calibration
    is_tooling: Mapped[bool] = mapped_column(
        Boolean,
        nullable=False,
        default=False,
        index=True,
        comment="Whether this part is a tool requiring calibration tracking",
    )
    calibration_interval_days: Mapped[int | None] = mapped_column(
        Integer, nullable=True, comment="Days between required calibrations (e.g., 365 for annual)"
    )

    # Assembly hierarchy - parts can contain other parts
    parent_id: Mapped[int | None] = mapped_column(
        ForeignKey("part.id"),
        nullable=True,
        index=True,
        comment="Parent assembly this part belongs to",
    )

    # Identity lifecycle: parts are born draft (PN/tier mutable, deletable)
    # and become active only by a deliberate activation — never as a side
    # effect. An active part's identity (PN, tier) is immutable forever.
    lifecycle_state: Mapped[str] = mapped_column(
        String(20),
        nullable=False,
        default="draft",
        server_default="draft",
        index=True,
        comment="draft (identity mutable) or active (identity locked)",
    )
    activated_at: Mapped[datetime | None] = mapped_column(
        DateTime(timezone=True), nullable=True
    )
    activated_by_id: Mapped[int | None] = mapped_column(
        ForeignKey("user.id", ondelete="SET NULL"), nullable=True
    )
    activation_cause: Mapped[str | None] = mapped_column(
        String(255),
        nullable=True,
        comment="What locked this part's identity (a part should explain why it locked)",
    )

    # Relationships
    activated_by: Mapped["User | None"] = relationship("User", foreign_keys=[activated_by_id])
    inventory_records: Mapped[list["InventoryRecord"]] = relationship(
        "InventoryRecord", back_populates="part", cascade="all, delete-orphan"
    )
    purchase_lines: Mapped[list["PurchaseLine"]] = relationship(
        "PurchaseLine", back_populates="part"
    )
    kits: Mapped[list["Kit"]] = relationship("Kit", back_populates="part")
    step_kits: Mapped[list["StepKit"]] = relationship("StepKit", back_populates="part")
    procedure_outputs: Mapped[list["ProcedureOutput"]] = relationship(
        "ProcedureOutput", back_populates="part"
    )
    issues: Mapped[list["Issue"]] = relationship("Issue", back_populates="part")
    test_templates: Mapped[list["TestTemplate"]] = relationship(
        "TestTemplate", back_populates="part", cascade="all, delete-orphan"
    )

    # Self-referential relationships for assembly hierarchy
    parent: Mapped["Part | None"] = relationship(
        "Part", remote_side="Part.id", back_populates="children", foreign_keys=[parent_id]
    )
    children: Mapped[list["Part"]] = relationship(
        "Part", back_populates="parent", foreign_keys=[parent_id]
    )

    # Requirements assigned to this part
    requirements: Mapped[list["PartRequirement"]] = relationship(
        "PartRequirement", back_populates="part", cascade="all, delete-orphan"
    )

    # BOM: components contained in this assembly
    bom_lines: Mapped[list["BOMLine"]] = relationship(
        "BOMLine",
        back_populates="assembly",
        foreign_keys="BOMLine.assembly_id",
        cascade="all, delete-orphan",
    )

    # BOM: assemblies this part is used in
    used_in: Mapped[list["BOMLine"]] = relationship(
        "BOMLine", back_populates="component", foreign_keys="BOMLine.component_id"
    )

    # Supplier catalog entries for this part
    supplier_entries: Mapped[list["SupplierPart"]] = relationship(
        "SupplierPart", back_populates="part", cascade="all, delete-orphan"
    )

    def __repr__(self) -> str:
        return f"<Part(id={self.id}, name='{self.name}', tier={self.tier})>"


class PartRequirement(Base, IdMixin, TimestampMixin):
    """Links a part to a project requirement.

    Requirements are defined in the project config (opal.project.yaml).
    This tracks which requirements apply to which parts and their status.
    """

    __tablename__ = "part_requirements"

    part_id: Mapped[int] = mapped_column(
        ForeignKey("part.id", ondelete="CASCADE"), nullable=False, index=True
    )
    requirement_id: Mapped[str] = mapped_column(
        String(50),
        nullable=False,
        index=True,
        comment="Requirement ID from project config (e.g., REQ-001)",
    )
    requirement_ref_id: Mapped[int | None] = mapped_column(
        ForeignKey("requirement.id", ondelete="SET NULL"),
        nullable=True,
        index=True,
        comment="FK to the first-class Requirement row; supersedes the string requirement_id",
    )
    status: Mapped[str] = mapped_column(
        String(20), nullable=False, default="open", comment="open, verified, waived, not_applicable"
    )
    notes: Mapped[str | None] = mapped_column(Text, nullable=True)
    verified_at: Mapped[datetime | None] = mapped_column(DateTime, nullable=True)
    verified_by_id: Mapped[int | None] = mapped_column(ForeignKey("user.id"), nullable=True)

    # Relationships
    part: Mapped["Part"] = relationship("Part", back_populates="requirements")
    verified_by: Mapped["User | None"] = relationship("User")
    requirement_ref: Mapped["Requirement | None"] = relationship(
        "Requirement", back_populates="part_links"
    )

    def __repr__(self) -> str:
        return f"<PartRequirement(part_id={self.part_id}, requirement_id='{self.requirement_id}', status='{self.status}')>"


class BOMLine(Base, IdMixin, TimestampMixin):
    """Bill of Materials line item - quantity of a component in an assembly.

    This defines the design-level BOM structure (what parts go into an assembly).
    Different from genealogy.AssemblyComponent which tracks actual instance usage.
    """

    __tablename__ = "bom_lines"

    assembly_id: Mapped[int] = mapped_column(
        ForeignKey("part.id", ondelete="CASCADE"),
        nullable=False,
        index=True,
        comment="The assembly (parent part)",
    )
    component_id: Mapped[int] = mapped_column(
        ForeignKey("part.id", ondelete="CASCADE"),
        nullable=False,
        index=True,
        comment="The component (child part)",
    )
    quantity: Mapped[int] = mapped_column(
        Integer, nullable=False, default=1, comment="Number of this component in the assembly"
    )
    reference_designator: Mapped[str | None] = mapped_column(
        String(50), nullable=True, comment="Reference designator (e.g., R1, C3, U2)"
    )
    notes: Mapped[str | None] = mapped_column(Text, nullable=True)

    # Relationships
    assembly: Mapped["Part"] = relationship(
        "Part", back_populates="bom_lines", foreign_keys=[assembly_id]
    )
    component: Mapped["Part"] = relationship(
        "Part", back_populates="used_in", foreign_keys=[component_id]
    )

    def __repr__(self) -> str:
        return f"<BOMLine(assembly_id={self.assembly_id}, component_id={self.component_id}, qty={self.quantity})>"
