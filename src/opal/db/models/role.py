"""Roles: qualifications an admin grants to users.

A template sign-off slot may name a role; only a user holding that role can
sign it. ``User.is_admin`` is separate (app administration) and never
substitutes for a role.
"""

from datetime import UTC, datetime

from sqlalchemy import DateTime, ForeignKey, String, Text, UniqueConstraint
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
