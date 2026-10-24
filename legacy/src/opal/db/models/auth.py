"""Authentication models: sessions, API tokens, passkey credentials.

Raw secrets (session tokens, API tokens) are never stored — only their
SHA-256 digests. The session layer is auth-method agnostic: password logins,
passkey logins, exe-proxy logins and any future SSO provider all mint the
same AuthSession rows.
"""

from datetime import UTC, datetime
from typing import TYPE_CHECKING

from sqlalchemy import DateTime, ForeignKey, Integer, LargeBinary, String, Text
from sqlalchemy.orm import Mapped, mapped_column, relationship

from opal.db.base import Base, IdMixin, TimestampMixin

if TYPE_CHECKING:
    from opal.db.models.user import User


class AuthSession(Base, IdMixin, TimestampMixin):
    """A browser session minted at login.

    The cookie holds the raw random token; this row stores its SHA-256.
    Sessions expire on a sliding window and can be revoked individually
    (logout) or in bulk (logout everywhere, password change, deactivation).
    """

    __tablename__ = "auth_session"

    user_id: Mapped[int] = mapped_column(
        ForeignKey("user.id", ondelete="CASCADE"), nullable=False, index=True
    )
    token_hash: Mapped[str] = mapped_column(String(64), nullable=False, unique=True, index=True)
    auth_method: Mapped[str] = mapped_column(
        String(32), nullable=False, default="password", comment="password, passkey, exe, ..."
    )
    expires_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), nullable=False)
    last_seen_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True), nullable=True)
    revoked_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True), nullable=True)
    user_agent: Mapped[str | None] = mapped_column(String(255), nullable=True)
    ip_address: Mapped[str | None] = mapped_column(String(64), nullable=True)

    user: Mapped["User"] = relationship("User", back_populates="sessions")

    @property
    def is_valid(self) -> bool:
        now = datetime.now(UTC)
        expires = self.expires_at
        if expires is not None and expires.tzinfo is None:
            expires = expires.replace(tzinfo=UTC)
        return self.revoked_at is None and expires is not None and expires > now

    def __repr__(self) -> str:
        return f"<AuthSession(id={self.id}, user_id={self.user_id}, method={self.auth_method})>"


class ApiToken(Base, IdMixin, TimestampMixin):
    """Long-lived bearer token for programmatic clients (TUI, scripts).

    Sent as ``Authorization: Bearer <token>``. The raw token is shown once at
    creation; only its SHA-256 is stored.
    """

    __tablename__ = "api_token"

    user_id: Mapped[int] = mapped_column(
        ForeignKey("user.id", ondelete="CASCADE"), nullable=False, index=True
    )
    name: Mapped[str] = mapped_column(
        String(100), nullable=False, comment="Human label, e.g. 'workshop TUI'"
    )
    token_hash: Mapped[str] = mapped_column(String(64), nullable=False, unique=True, index=True)
    last_used_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True), nullable=True)
    revoked_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True), nullable=True)
    # NULL = never expires (default). A timestamp makes the token invalid past it.
    expires_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True), nullable=True)

    user: Mapped["User"] = relationship("User", back_populates="api_tokens")

    @property
    def is_valid(self) -> bool:
        if self.revoked_at is not None:
            return False
        expires = self.expires_at
        if expires is not None:
            if expires.tzinfo is None:
                expires = expires.replace(tzinfo=UTC)
            if expires <= datetime.now(UTC):
                return False
        return True

    def __repr__(self) -> str:
        return f"<ApiToken(id={self.id}, user_id={self.user_id}, name='{self.name}')>"


class WebauthnChallenge(Base, IdMixin, TimestampMixin):
    """A pending WebAuthn handshake, stored so each challenge is single-use.

    The begin step persists the fido2 server state here and hands the client a
    signed cookie carrying only the random ``nonce``. The complete step looks
    the row up by nonce and deletes it, so a captured cookie + assertion cannot
    be replayed once the handshake finishes (or the row expires).
    """

    __tablename__ = "webauthn_challenge"

    nonce: Mapped[str] = mapped_column(String(64), nullable=False, unique=True, index=True)
    kind: Mapped[str] = mapped_column(String(16), nullable=False, comment="login | register")
    rp_id: Mapped[str] = mapped_column(String(255), nullable=False)
    user_id: Mapped[int | None] = mapped_column(
        ForeignKey("user.id", ondelete="CASCADE"), nullable=True, index=True
    )
    state_json: Mapped[str] = mapped_column(Text, nullable=False, comment="fido2 server state")
    expires_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), nullable=False)

    def __repr__(self) -> str:
        return f"<WebauthnChallenge(kind={self.kind}, user_id={self.user_id})>"


class PasskeyCredential(Base, IdMixin, TimestampMixin):
    """A registered FIDO2/WebAuthn credential (passkey)."""

    __tablename__ = "passkey_credential"

    user_id: Mapped[int] = mapped_column(
        ForeignKey("user.id", ondelete="CASCADE"), nullable=False, index=True
    )
    credential_id: Mapped[bytes] = mapped_column(
        LargeBinary, nullable=False, unique=True, index=True
    )
    public_key: Mapped[bytes] = mapped_column(
        LargeBinary, nullable=False, comment="CBOR-encoded COSE public key"
    )
    sign_count: Mapped[int] = mapped_column(Integer, nullable=False, default=0)
    name: Mapped[str] = mapped_column(
        String(100), nullable=False, default="Passkey", comment="Human label"
    )
    aaguid: Mapped[str | None] = mapped_column(String(36), nullable=True)
    transports: Mapped[str | None] = mapped_column(
        String(100), nullable=True, comment="Comma-separated WebAuthn transports"
    )
    last_used_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True), nullable=True)

    user: Mapped["User"] = relationship("User", back_populates="passkeys")

    def __repr__(self) -> str:
        return f"<PasskeyCredential(id={self.id}, user_id={self.user_id}, name='{self.name}')>"
