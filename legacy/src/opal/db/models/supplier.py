"""Supplier model."""

from sqlalchemy import Boolean, ForeignKey, String, Text, UniqueConstraint
from sqlalchemy.orm import Mapped, mapped_column, relationship

from opal.db.base import Base, IdMixin, SoftDeleteMixin, TimestampMixin


class Supplier(Base, IdMixin, TimestampMixin, SoftDeleteMixin):
    """External supplier/vendor company."""

    name: Mapped[str] = mapped_column(String(255), nullable=False, index=True)
    code: Mapped[str | None] = mapped_column(
        String(50), nullable=True, unique=True, comment="Short code like SUP001"
    )
    description: Mapped[str | None] = mapped_column(Text, nullable=True)
    website: Mapped[str | None] = mapped_column(String(255), nullable=True)
    email: Mapped[str | None] = mapped_column(String(255), nullable=True)
    phone: Mapped[str | None] = mapped_column(String(50), nullable=True)
    address: Mapped[str | None] = mapped_column(Text, nullable=True)
    notes: Mapped[str | None] = mapped_column(Text, nullable=True)
    is_active: Mapped[bool] = mapped_column(default=True, nullable=False)

    # Relationships
    purchases: Mapped[list["Purchase"]] = relationship("Purchase", back_populates="supplier_rel")
    catalog_entries: Mapped[list["SupplierPart"]] = relationship(
        "SupplierPart", back_populates="supplier", cascade="all, delete-orphan"
    )

    def __repr__(self) -> str:
        return f"<Supplier(id={self.id}, name='{self.name}')>"


class SupplierPart(Base, IdMixin, TimestampMixin):
    """Supplier-specific catalog number for a part (many-to-many join with metadata)."""

    __table_args__ = (UniqueConstraint("supplier_id", "part_id", name="uq_supplier_part"),)

    supplier_id: Mapped[int] = mapped_column(
        ForeignKey("supplier.id", ondelete="CASCADE"), nullable=False, index=True
    )
    part_id: Mapped[int] = mapped_column(
        ForeignKey("part.id", ondelete="CASCADE"), nullable=False, index=True
    )
    vendor_pn: Mapped[str] = mapped_column(
        String(255), nullable=False, comment="Supplier's own catalog/part number"
    )
    is_preferred: Mapped[bool] = mapped_column(
        Boolean,
        nullable=False,
        default=False,
        comment="Preferred supplier for this part",
    )
    notes: Mapped[str | None] = mapped_column(Text, nullable=True)

    supplier: Mapped["Supplier"] = relationship("Supplier", back_populates="catalog_entries")
    part: Mapped["Part"] = relationship("Part", back_populates="supplier_entries")

    def __repr__(self) -> str:
        return (
            f"<SupplierPart(supplier_id={self.supplier_id}, part_id={self.part_id},"
            f" vendor_pn='{self.vendor_pn}')>"
        )
