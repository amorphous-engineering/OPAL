"""Installed-extension registry row.

The filesystem holds the extension; this table holds the instance's decision
about it — whether it is enabled, when it arrived, and what the manifest said
at that moment. Discovery reconciles the two on every settings read, so a
directory removed by hand disappears from the registry rather than lingering.
"""

from datetime import datetime
from typing import Any

from sqlalchemy import JSON, Boolean, DateTime, String, Text
from sqlalchemy.orm import Mapped, mapped_column

from opal.db.base import Base, TimestampMixin

#: Origin values. Bundled extensions ship in the package and cannot be
#: uninstalled; installed ones came from an operator-uploaded archive.
ORIGIN_BUNDLED = "bundled"
ORIGIN_INSTALLED = "installed"


class Extension(Base, TimestampMixin):
    """One known extension, keyed by its manifest id."""

    __tablename__ = "extension"

    id: Mapped[str] = mapped_column(String(64), primary_key=True)
    name: Mapped[str] = mapped_column(String(120), nullable=False)
    version: Mapped[str] = mapped_column(String(32), nullable=False)
    summary: Mapped[str | None] = mapped_column(Text, nullable=True)
    origin: Mapped[str] = mapped_column(
        String(16), nullable=False, comment="bundled = ships with OPAL, installed = uploaded"
    )
    enabled: Mapped[bool] = mapped_column(Boolean, nullable=False, default=True)
    installed_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), nullable=False)
    checksum: Mapped[str | None] = mapped_column(
        String(64), nullable=True, comment="SHA-256 of the uploaded archive; NULL for bundled"
    )
    manifest: Mapped[dict[str, Any]] = mapped_column(
        JSON, nullable=False, comment="Manifest as accepted at install time"
    )

    @property
    def is_bundled(self) -> bool:
        return self.origin == ORIGIN_BUNDLED

    def __repr__(self) -> str:
        return f"<Extension(id={self.id!r}, version={self.version!r}, enabled={self.enabled})>"
