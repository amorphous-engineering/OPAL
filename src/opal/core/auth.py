"""Signed session cookie helpers.

The auth cookie carries ``<user_id>.<hmac-sha256-signature>`` so a user on
the network cannot impersonate another user by forging a bare-id cookie.
The signing secret comes from OPAL_AUTH_SECRET when set, otherwise it is
generated once and persisted next to the SQLite database file.
"""

import hashlib
import hmac
import logging
import secrets
from pathlib import Path

logger = logging.getLogger("opal.auth")

AUTH_COOKIE = "opal_user_id"
AUTH_COOKIE_MAX_AGE = 365 * 24 * 3600

# Fallback for databases without a filesystem location (e.g. in-memory):
# sessions then last until the process restarts.
_ephemeral_secret: str | None = None


def _secret_file_for_database(database_url: str) -> Path | None:
    from sqlalchemy.engine import make_url

    url = make_url(database_url)
    if url.get_backend_name() != "sqlite":
        return None
    raw_path = url.database
    if not raw_path or raw_path == ":memory:" or raw_path.startswith(":"):
        return None
    return Path(raw_path).resolve().parent / ".opal_auth_secret"


def get_auth_secret() -> str:
    """Get the install's cookie-signing secret, creating it on first use."""
    from opal.config import get_active_settings

    settings = get_active_settings()
    configured = getattr(settings, "auth_secret", "")
    if configured:
        return configured

    secret_file = _secret_file_for_database(settings.database_url)
    global _ephemeral_secret
    if secret_file is None:
        if _ephemeral_secret is None:
            _ephemeral_secret = secrets.token_hex(32)
        return _ephemeral_secret

    try:
        if secret_file.exists():
            existing = secret_file.read_text(encoding="utf-8").strip()
            if existing:
                return existing
        secret = secrets.token_hex(32)
        secret_file.write_text(secret, encoding="utf-8")
        secret_file.chmod(0o600)
        return secret
    except OSError as exc:
        logger.warning("Could not persist auth secret (%s); using process-lifetime secret", exc)
        if _ephemeral_secret is None:
            _ephemeral_secret = secrets.token_hex(32)
        return _ephemeral_secret


def _signature(payload: str, secret: str) -> str:
    return hmac.new(secret.encode(), payload.encode(), hashlib.sha256).hexdigest()


def sign_user_id(user_id: int) -> str:
    """Produce the signed cookie value for a user id."""
    payload = str(int(user_id))
    return f"{payload}.{_signature(payload, get_auth_secret())}"


def verify_user_id(cookie_value: str | None) -> int | None:
    """Return the user id from a signed cookie value, or None if invalid.

    Unsigned legacy cookies are rejected; those sessions simply log in again.
    """
    if not cookie_value or "." not in cookie_value:
        return None
    payload, signature = cookie_value.rsplit(".", 1)
    if not hmac.compare_digest(signature, _signature(payload, get_auth_secret())):
        return None
    try:
        return int(payload)
    except ValueError:
        return None
