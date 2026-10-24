"""Roles: qualifications an admin grants to users.

A template sign-off slot may name a role; only a user holding that role (or an
admin) can sign it. Four system roles (Engineer, Technician, Quality, Admin)
exist on every install; the Admin role's membership IS ``User.is_admin``.
"""

from datetime import UTC, datetime

from sqlalchemy import Boolean, DateTime, ForeignKey, String, Text, UniqueConstraint
from sqlalchemy.orm import Mapped, mapped_column

from opal.db.base import Base, IdMixin, SoftDeleteMixin, TimestampMixin


class Role(Base, IdMixin, TimestampMixin, SoftDeleteMixin):
    """A named qualification (Technician, Engineer, QA ...)."""

    name: Mapped[str] = mapped_column(
        String(50, collation="NOCASE"),
        nullable=False,
        unique=True,
        comment="Unique case-insensitively; the canonical casing is what sign-offs show",
    )
    description: Mapped[str | None] = mapped_column(Text, nullable=True)
    key: Mapped[str | None] = mapped_column(
        String(30),
        nullable=True,
        unique=True,
        comment="Stable identifier of a system role (engineer, technician, quality, admin)",
    )
    is_system: Mapped[bool] = mapped_column(
        Boolean, nullable=False, default=False, server_default="0"
    )

    def __repr__(self) -> str:
        return f"<Role(id={self.id}, name='{self.name}')>"


class UserRole(Base, IdMixin):
    """A role granted to a user."""

    __table_args__ = (UniqueConstraint("user_id", "role_id", name="uq_user_role"),)

    user_id: Mapped[int] = mapped_column(
        ForeignKey("user.id", ondelete="CASCADE"), nullable=False, index=True
    )
    role_id: Mapped[int] = mapped_column(
        ForeignKey("role.id", ondelete="CASCADE"), nullable=False, index=True
    )
    granted_by_id: Mapped[int | None] = mapped_column(
        ForeignKey("user.id", ondelete="SET NULL"), nullable=True
    )
    granted_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), default=lambda: datetime.now(UTC), nullable=False
    )


class RoleGate(Base, IdMixin):
    """A role that passes a permission gate (keys live in ``opal.core.gates``)."""

    __table_args__ = (UniqueConstraint("role_id", "gate", name="uq_role_gate"),)

    role_id: Mapped[int] = mapped_column(
        ForeignKey("role.id", ondelete="CASCADE"), nullable=False, index=True
    )
    gate: Mapped[str] = mapped_column(String(50), nullable=False)
