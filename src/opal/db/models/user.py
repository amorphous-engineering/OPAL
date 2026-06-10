"""User model."""

from datetime import datetime

from sqlalchemy import DateTime, String
from sqlalchemy.orm import Mapped, mapped_column, relationship

from opal.db.base import Base, IdMixin, TimestampMixin


class User(Base, IdMixin, TimestampMixin):
    """User account with credentialed authentication.

    Authenticated with username + argon2 password hash, optionally with FIDO2
    passkeys (see PasskeyCredential). Sessions and API tokens live in their
    own tables so future identity providers (SSO) plug into the same session
    layer without touching this model.
    """

    name: Mapped[str] = mapped_column(String(255), nullable=False)
    username: Mapped[str] = mapped_column(
        String(64), nullable=False, unique=True, index=True, comment="Login identifier"
    )
    password_hash: Mapped[str | None] = mapped_column(
        String(255),
        nullable=True,
        comment="Argon2 hash; NULL means the account must set a password on first login",
    )
    email: Mapped[str | None] = mapped_column(String(255), nullable=True, unique=True)
    exe_user_id: Mapped[str | None] = mapped_column(String(255), nullable=True, unique=True)
    is_active: Mapped[bool] = mapped_column(default=True, nullable=False)
    is_admin: Mapped[bool] = mapped_column(default=False, nullable=False)
    needs_profile_setup: Mapped[bool] = mapped_column(default=False, nullable=False)
    needs_onboarding: Mapped[bool] = mapped_column(default=True, nullable=False)

    # Presence tracking
    last_seen_at: Mapped[datetime | None] = mapped_column(
        DateTime(timezone=True), nullable=True, comment="Heartbeat timestamp for presence"
    )
    current_activity: Mapped[str | None] = mapped_column(
        String(255), nullable=True, comment="Current activity: executing:123, viewing:parts:45"
    )

    # Relationships (back-references)
    procedure_versions: Mapped[list["ProcedureVersion"]] = relationship(
        "ProcedureVersion", back_populates="created_by_user"
    )
    procedure_instances: Mapped[list["ProcedureInstance"]] = relationship(
        "ProcedureInstance", back_populates="started_by_user"
    )
    step_executions: Mapped[list["StepExecution"]] = relationship(
        "StepExecution",
        foreign_keys="StepExecution.completed_by_id",
        back_populates="completed_by_user",
    )
    step_signoffs: Mapped[list["StepExecution"]] = relationship(
        "StepExecution",
        foreign_keys="StepExecution.signed_off_by_id",
        back_populates="signed_off_by_user",
    )
    consumptions: Mapped[list["InventoryConsumption"]] = relationship(
        "InventoryConsumption", back_populates="consumed_by_user"
    )
    productions: Mapped[list["InventoryProduction"]] = relationship(
        "InventoryProduction", back_populates="produced_by_user"
    )
    purchases_created: Mapped[list["Purchase"]] = relationship(
        "Purchase", foreign_keys="Purchase.created_by_id", back_populates="created_by"
    )
    purchases_received: Mapped[list["Purchase"]] = relationship(
        "Purchase", foreign_keys="Purchase.received_by_id", back_populates="received_by"
    )
    test_results: Mapped[list["StockTestResult"]] = relationship(
        "StockTestResult", back_populates="tested_by_user"
    )
    sessions: Mapped[list["AuthSession"]] = relationship(
        "AuthSession", back_populates="user", cascade="all, delete-orphan"
    )
    api_tokens: Mapped[list["ApiToken"]] = relationship(
        "ApiToken", back_populates="user", cascade="all, delete-orphan"
    )
    passkeys: Mapped[list["PasskeyCredential"]] = relationship(
        "PasskeyCredential", back_populates="user", cascade="all, delete-orphan"
    )

    def __repr__(self) -> str:
        return f"<User(id={self.id}, name='{self.name}')>"
