"""Authentication services: passwords, sessions, API tokens.

Design notes
------------
- Passwords are hashed with argon2id. ``User.password_hash`` of NULL marks a
  migrated account that must set its password on first login.
- Browser sessions are opaque random tokens in an HttpOnly cookie; the
  database stores only the SHA-256 of the token (AuthSession). Sessions have
  a sliding expiry and are individually revocable.
- Programmatic clients authenticate with long-lived API tokens
  (``Authorization: Bearer opal_...``), also stored hashed.
- The session layer is auth-method agnostic: password, passkey and exe-proxy
  logins all call ``create_session`` with a method label. A future SSO
  provider does the same — it only needs to resolve a User, then mint a
  session.

The signing secret (``get_auth_secret``) is used for short-lived stateless
payloads such as the WebAuthn challenge cookie, not for sessions.
"""

import hashlib
import hmac
import json
import logging
import secrets
from base64 import urlsafe_b64decode, urlsafe_b64encode
from datetime import UTC, datetime, timedelta
from pathlib import Path

from argon2 import PasswordHasher
from argon2.exceptions import VerifyMismatchError
from sqlalchemy.orm import Session

from opal.db.models.auth import ApiToken, AuthSession
from opal.db.models.user import User

logger = logging.getLogger("opal.auth")

SESSION_COOKIE = "opal_session"
SESSION_LIFETIME = timedelta(days=30)
# Refresh expiry at most this often to avoid a write on every request
SESSION_TOUCH_INTERVAL = timedelta(minutes=15)
API_TOKEN_PREFIX = "opal_"

_password_hasher = PasswordHasher()  # argon2id with library defaults

# ---------------------------------------------------------------------------
# Passwords
# ---------------------------------------------------------------------------


def hash_password(password: str) -> str:
    """Hash a password with argon2id."""
    return _password_hasher.hash(password)


def verify_password(password_hash: str | None, password: str) -> bool:
    """Check a password against its hash. None hash never verifies."""
    if not password_hash:
        return False
    try:
        return _password_hasher.verify(password_hash, password)
    except VerifyMismatchError:
        return False
    except Exception:  # malformed hash
        logger.warning("Malformed password hash encountered")
        return False


def password_needs_rehash(password_hash: str) -> bool:
    """Whether the hash predates current argon2 parameters."""
    return _password_hasher.check_needs_rehash(password_hash)


def validate_password_strength(password: str) -> str | None:
    """Return an error message if the password is unacceptable, else None."""
    if len(password) < 10:
        return "Password must be at least 10 characters."
    if len(password) > 256:
        return "Password must be at most 256 characters."
    return None


def authenticate_password(db: Session, username: str, password: str) -> User | None:
    """Resolve a user by username and verify the password.

    Performs a dummy verification when the user is unknown so response time
    does not reveal which usernames exist.
    """
    user = (
        db.query(User)
        .filter(User.username == username.strip().lower(), User.is_active.is_(True))
        .first()
    )
    if user is None or user.password_hash is None:
        # burn comparable time; never authenticates
        verify_password(_DUMMY_HASH, password)
        return None
    if not verify_password(user.password_hash, password):
        return None
    if password_needs_rehash(user.password_hash):
        user.password_hash = hash_password(password)
    return user


_DUMMY_HASH = hash_password(secrets.token_hex(16))


def normalize_username(raw: str) -> str:
    """Normalize arbitrary input into a username slug."""
    import re

    slug = re.sub(r"[^a-z0-9._-]+", ".", raw.strip().lower()).strip(".")
    return slug[:64]


def generate_unique_username(db: Session, raw: str) -> str:
    """Derive a username from raw input, suffixing digits until unique."""
    base = normalize_username(raw) or "user"
    candidate = base
    suffix = 2
    while db.query(User).filter(User.username == candidate).first() is not None:
        candidate = f"{base[: 64 - len(str(suffix))]}{suffix}"
        suffix += 1
    return candidate


# ---------------------------------------------------------------------------
# Login throttling (in-process; OPAL runs single-process by design)
# ---------------------------------------------------------------------------


class LoginRateLimiter:
    """Sliding-window failure counter keyed by (ip, username)."""

    def __init__(self, max_failures: int = 10, window_seconds: float = 300.0) -> None:
        self.max_failures = max_failures
        self.window_seconds = window_seconds
        self._failures: dict[str, list[float]] = {}

    def _prune(self, key: str, now: float) -> list[float]:
        entries = [t for t in self._failures.get(key, []) if now - t < self.window_seconds]
        if entries:
            self._failures[key] = entries
        else:
            self._failures.pop(key, None)
        return entries

    def is_blocked(self, key: str) -> bool:
        import time

        return len(self._prune(key, time.monotonic())) >= self.max_failures

    def record_failure(self, key: str) -> None:
        import time

        self._failures.setdefault(key, []).append(time.monotonic())

    def reset(self, key: str) -> None:
        self._failures.pop(key, None)


login_rate_limiter = LoginRateLimiter()


# ---------------------------------------------------------------------------
# Sessions
# ---------------------------------------------------------------------------


def _sha256(value: str) -> str:
    return hashlib.sha256(value.encode()).hexdigest()


def create_session(
    db: Session,
    user: User,
    auth_method: str = "password",
    user_agent: str | None = None,
    ip_address: str | None = None,
) -> str:
    """Mint a session for a user and return the raw cookie token."""
    token = secrets.token_urlsafe(32)
    db.add(
        AuthSession(
            user_id=user.id,
            token_hash=_sha256(token),
            auth_method=auth_method,
            expires_at=datetime.now(UTC) + SESSION_LIFETIME,
            last_seen_at=datetime.now(UTC),
            user_agent=(user_agent or "")[:255] or None,
            ip_address=(ip_address or "")[:64] or None,
        )
    )
    db.flush()
    return token


def resolve_session(db: Session, token: str | None) -> User | None:
    """Resolve a raw session token to its active user, touching expiry."""
    if not token:
        return None
    session = db.query(AuthSession).filter(AuthSession.token_hash == _sha256(token)).first()
    if session is None or not session.is_valid:
        return None
    user = db.query(User).filter(User.id == session.user_id, User.is_active.is_(True)).first()
    if user is None:
        return None

    now = datetime.now(UTC)
    last_seen = session.last_seen_at
    if last_seen is not None and last_seen.tzinfo is None:
        last_seen = last_seen.replace(tzinfo=UTC)
    if last_seen is None or now - last_seen > SESSION_TOUCH_INTERVAL:
        session.last_seen_at = now
        session.expires_at = now + SESSION_LIFETIME
    return user


def revoke_session(db: Session, token: str | None) -> None:
    """Revoke the session belonging to a raw token (logout)."""
    if not token:
        return
    session = db.query(AuthSession).filter(AuthSession.token_hash == _sha256(token)).first()
    if session is not None and session.revoked_at is None:
        session.revoked_at = datetime.now(UTC)


def revoke_all_sessions(db: Session, user_id: int, except_token: str | None = None) -> int:
    """Revoke every active session for a user (password change, deactivation).

    Returns the number of sessions revoked. ``except_token`` keeps the
    caller's own session alive.
    """
    query = db.query(AuthSession).filter(
        AuthSession.user_id == user_id, AuthSession.revoked_at.is_(None)
    )
    if except_token:
        query = query.filter(AuthSession.token_hash != _sha256(except_token))
    count = 0
    for session in query.all():
        session.revoked_at = datetime.now(UTC)
        count += 1
    return count


# ---------------------------------------------------------------------------
# API tokens
# ---------------------------------------------------------------------------


def create_api_token(db: Session, user: User, name: str) -> tuple[ApiToken, str]:
    """Mint an API token. Returns (record, raw token) — raw shown only once."""
    raw = API_TOKEN_PREFIX + secrets.token_urlsafe(32)
    record = ApiToken(user_id=user.id, name=name[:100], token_hash=_sha256(raw))
    db.add(record)
    db.flush()
    return record, raw


def resolve_api_token(db: Session, raw: str | None) -> User | None:
    """Resolve a bearer token to its active user."""
    if not raw or not raw.startswith(API_TOKEN_PREFIX):
        return None
    record = db.query(ApiToken).filter(ApiToken.token_hash == _sha256(raw)).first()
    if record is None or not record.is_valid:
        return None
    user = db.query(User).filter(User.id == record.user_id, User.is_active.is_(True)).first()
    if user is None:
        return None
    record.last_used_at = datetime.now(UTC)
    return user


# ---------------------------------------------------------------------------
# Install signing secret (stateless short-lived payloads, e.g. WebAuthn state)
# ---------------------------------------------------------------------------

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
    """Get the install's signing secret, creating it on first use."""
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


def sign_payload(payload: dict, max_age: timedelta = timedelta(minutes=5)) -> str:
    """Serialize and HMAC-sign a small dict with an expiry (URL-safe)."""
    body = dict(payload)
    body["__exp"] = (datetime.now(UTC) + max_age).timestamp()
    raw = json.dumps(body, separators=(",", ":")).encode()
    sig = hmac.new(get_auth_secret().encode(), raw, hashlib.sha256).hexdigest()
    return urlsafe_b64encode(raw).decode() + "." + sig


def verify_payload(value: str | None) -> dict | None:
    """Verify and deserialize a payload from sign_payload. None if invalid."""
    if not value or "." not in value:
        return None
    encoded, sig = value.rsplit(".", 1)
    try:
        raw = urlsafe_b64decode(encoded.encode())
    except Exception:
        return None
    expected = hmac.new(get_auth_secret().encode(), raw, hashlib.sha256).hexdigest()
    if not hmac.compare_digest(sig, expected):
        return None
    try:
        body = json.loads(raw)
    except ValueError:
        return None
    exp = body.pop("__exp", 0)
    if datetime.now(UTC).timestamp() > exp:
        return None
    return body
