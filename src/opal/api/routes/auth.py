"""Authentication API: passkey login, password change, sessions, API tokens.

``public_router`` carries the unauthenticated passkey login handshake;
``router`` (mounted behind require_user) carries account security management.
The WebAuthn challenge between begin/complete travels in a short-lived signed
cookie so the server stays stateless across the handshake.
"""

import hashlib
from datetime import UTC, datetime, timedelta

from fastapi import APIRouter, HTTPException, Request, Response, status
from pydantic import BaseModel, Field

from opal.api.deps import DbSession, RequiredUser
from opal.api.net import client_ip, request_is_secure, set_session_cookie
from opal.core import webauthn
from opal.core.auth import (
    SESSION_COOKIE,
    authenticate_password,
    create_api_token,
    create_session,
    generate_unique_username,
    hash_password,
    login_rate_limiter,
    revoke_all_sessions,
    revoke_session,
    sign_payload,
    validate_password_strength,
    verify_password,
    verify_payload,
)
from opal.db.models import ApiToken, AuthSession, PasskeyCredential, User

public_router = APIRouter(prefix="/auth", tags=["auth"])
router = APIRouter(prefix="/auth", tags=["auth"])

PASSKEY_STATE_COOKIE = "opal_webauthn_state"


def _passkeys_enabled() -> bool:
    from opal.config import get_active_settings

    return bool(getattr(get_active_settings(), "passkeys_enabled", True))


def _require_passkeys_enabled() -> None:
    if not _passkeys_enabled():
        raise HTTPException(
            status_code=status.HTTP_403_FORBIDDEN,
            detail="Passkeys are disabled on this OPAL instance",
        )


# ---------------------------------------------------------------------------
# Public: sign-in surface for the web client
# ---------------------------------------------------------------------------


def _user_payload(user: User) -> dict:
    """The signed-in identity as the web client sees it."""
    return {
        "id": user.id,
        "username": user.username,
        "name": user.name,
        "email": user.email,
        "is_admin": user.is_admin,
        "needs_onboarding": bool(user.needs_onboarding),
        "needs_profile_setup": bool(user.needs_profile_setup),
    }


def _session_response(request: Request, db: DbSession, user: User, auth_method: str) -> Response:
    """Mint a session for ``user`` and return its identity with the cookie set."""
    from fastapi.responses import JSONResponse

    token = create_session(
        db,
        user,
        auth_method=auth_method,
        user_agent=request.headers.get("user-agent"),
        ip_address=client_ip(request),
    )
    db.commit()
    response = JSONResponse({"user": _user_payload(user)})
    set_session_cookie(response, request, token)
    return response


@public_router.get("/config")
def sign_in_config(db: DbSession) -> dict:
    """Which sign-in methods this instance offers, and whether it needs first-run setup."""
    from opal.config import get_active_settings
    from opal.core import oidc

    settings = get_active_settings()
    oidc_on = oidc.is_enabled()
    return {
        "needs_setup": db.query(User).count() == 0,
        "password_login_enabled": settings.password_login_enabled,
        "passkeys_enabled": _passkeys_enabled(),
        "oidc_enabled": oidc_on,
        "oidc_provider_name": oidc.get_config().provider_name if oidc_on else None,
    }


class LoginRequest(BaseModel):
    username: str
    password: str


@public_router.post("/login")
def password_login(request: Request, body: LoginRequest, db: DbSession) -> Response:
    """Verify username + password and mint a session.

    Passwordless (pre-credential) accounts are not claimable here; they fail
    closed exactly like a wrong password (see /auth/claim)."""
    from opal.config import get_active_settings

    if not get_active_settings().password_login_enabled:
        raise HTTPException(status_code=403, detail="Password sign-in is disabled")
    username = body.username.strip().lower()
    rate_key = f"{client_ip(request) or 'unknown'}:{username}"
    if login_rate_limiter.is_blocked(rate_key):
        raise HTTPException(status_code=429, detail="Too many failed attempts. Try again later.")
    user = authenticate_password(db, username, body.password)
    if user is None:
        login_rate_limiter.record_failure(rate_key)
        raise HTTPException(status_code=401, detail="Invalid username or password")
    login_rate_limiter.reset(rate_key)
    return _session_response(request, db, user, "password")


@public_router.post("/logout", status_code=status.HTTP_204_NO_CONTENT)
def logout(request: Request, db: DbSession) -> Response:
    """End this OPAL session. The identity provider's session is left alone."""
    revoke_session(db, request.cookies.get(SESSION_COOKIE))
    db.commit()
    response = Response(status_code=status.HTTP_204_NO_CONTENT)
    response.delete_cookie(SESSION_COOKIE)
    return response


class SetupRequest(BaseModel):
    name: str
    username: str
    password: str
    email: str | None = None


@public_router.post("/setup", status_code=status.HTTP_201_CREATED)
def first_run_setup(request: Request, body: SetupRequest, db: DbSession) -> Response:
    """Create the first admin account. Refused once any user exists.

    Always credentialed: an instance whose only administrator lives in an
    external identity provider has no recovery path when it is unreachable."""
    if db.query(User).count() > 0:
        raise HTTPException(status_code=409, detail="Setup is already complete")
    name = body.name.strip()
    username = body.username.strip().lower()
    if not name:
        raise HTTPException(status_code=400, detail="Name is required")
    if not username:
        raise HTTPException(status_code=400, detail="Username is required")
    if error := validate_password_strength(body.password):
        raise HTTPException(status_code=400, detail=error)
    user = User(
        name=name,
        username=generate_unique_username(db, username),
        password_hash=hash_password(body.password),
        email=(body.email or "").strip() or None,
        is_active=True,
        is_admin=True,
        needs_onboarding=True,
    )
    db.add(user)
    db.flush()
    response = _session_response(request, db, user, "password")
    response.status_code = status.HTTP_201_CREATED
    return response


def _claimable_user(db: DbSession, token: str) -> User | None:
    """The account an admin-issued claim link names, while it is still unclaimed."""
    payload = verify_payload(token)
    if not payload or payload.get("kind") != "account-claim":
        return None
    user = db.query(User).filter(User.id == payload["uid"], User.is_active.is_(True)).first()
    if user is None or user.password_hash is not None:
        return None
    return user


@public_router.get("/claim")
def claim_status(token: str, db: DbSession) -> dict:
    """Validate a claim link. Invalid, expired and claimed links are indistinguishable."""
    user = _claimable_user(db, token)
    if user is None:
        raise HTTPException(status_code=404, detail="This link is invalid or has expired")
    return {"username": user.username}


class ClaimRequest(BaseModel):
    token: str
    password: str


@public_router.post("/claim")
def claim_account(request: Request, body: ClaimRequest, db: DbSession) -> Response:
    """Set the first password on a passwordless account via an admin-issued link."""
    user = _claimable_user(db, body.token)
    if user is None:
        raise HTTPException(status_code=404, detail="This link is invalid or has expired")
    if error := validate_password_strength(body.password):
        raise HTTPException(status_code=400, detail=error)
    user.password_hash = hash_password(body.password)
    return _session_response(request, db, user, "password")


# ---------------------------------------------------------------------------
# Public: passkey login handshake
# ---------------------------------------------------------------------------


@public_router.post("/passkey/login/begin")
def passkey_login_begin(request: Request, response: Response, db: DbSession) -> dict:
    """Start usernameless passkey authentication."""
    _require_passkeys_enabled()
    rp_id = webauthn.rp_id_for_host(request.url.hostname)
    options, state = webauthn.begin_authentication(rp_id)
    nonce = webauthn.store_challenge(db, "login", rp_id, state)
    db.commit()
    response.set_cookie(
        PASSKEY_STATE_COOKIE,
        sign_payload({"kind": "login", "nonce": nonce}),
        max_age=300,
        httponly=True,
        samesite="lax",
        secure=request_is_secure(request),
    )
    return options


@public_router.post("/passkey/login/complete")
def passkey_login_complete(request: Request, body: dict, db: DbSession) -> Response:
    """Verify the assertion and mint a session."""
    _require_passkeys_enabled()
    payload = verify_payload(request.cookies.get(PASSKEY_STATE_COOKIE))
    challenge = webauthn.consume_challenge(db, payload.get("nonce"), "login") if payload else None
    # Persist the burn now so a failed assertion can't retry the same challenge.
    db.commit()
    if challenge is None:
        raise HTTPException(status_code=400, detail="Missing or expired passkey challenge")

    user = webauthn.complete_authentication(db, challenge["rp_id"], challenge["state"], body)
    if user is None:
        raise HTTPException(status_code=401, detail="Passkey authentication failed")

    token = create_session(
        db,
        user,
        auth_method="passkey",
        user_agent=request.headers.get("user-agent"),
        ip_address=client_ip(request),
    )
    db.commit()

    from fastapi.responses import JSONResponse

    response = JSONResponse({"ok": True, "user_id": user.id, "name": user.name})
    set_session_cookie(response, request, token)
    response.delete_cookie(PASSKEY_STATE_COOKIE)
    return response


# ---------------------------------------------------------------------------
# Authenticated: passkey management
# ---------------------------------------------------------------------------


class PasskeyInfo(BaseModel):
    id: int
    name: str
    created_at: str
    last_used_at: str | None
    transports: str | None


@router.get("/passkeys", response_model=list[PasskeyInfo])
def list_passkeys(db: DbSession, user: RequiredUser) -> list[PasskeyInfo]:
    rows = db.query(PasskeyCredential).filter(PasskeyCredential.user_id == user.id).all()
    return [
        PasskeyInfo(
            id=r.id,
            name=r.name,
            created_at=r.created_at.isoformat(),
            last_used_at=r.last_used_at.isoformat() if r.last_used_at else None,
            transports=r.transports,
        )
        for r in rows
    ]


@router.post("/passkey/register/begin")
def passkey_register_begin(
    request: Request, response: Response, db: DbSession, user: RequiredUser
) -> dict:
    """Start registering a new passkey for the current user."""
    _require_passkeys_enabled()
    rp_id = webauthn.rp_id_for_host(request.url.hostname)
    options, state = webauthn.begin_registration(db, user, rp_id)
    nonce = webauthn.store_challenge(db, "register", rp_id, state, user_id=user.id)
    db.commit()
    response.set_cookie(
        PASSKEY_STATE_COOKIE,
        sign_payload({"kind": "register", "nonce": nonce, "uid": user.id}),
        max_age=300,
        httponly=True,
        samesite="lax",
        secure=request_is_secure(request),
    )
    return options


class PasskeyRegisterComplete(BaseModel):
    name: str = Field(default="Passkey", max_length=100)
    credential: dict


@router.post("/passkey/register/complete")
def passkey_register_complete(
    request: Request,
    body: PasskeyRegisterComplete,
    db: DbSession,
    user: RequiredUser,
) -> dict:
    _require_passkeys_enabled()
    payload = verify_payload(request.cookies.get(PASSKEY_STATE_COOKIE))
    ok_owner = bool(payload) and payload.get("uid") == user.id
    challenge = (
        webauthn.consume_challenge(db, payload.get("nonce"), "register") if ok_owner else None
    )
    # Persist the burn now so a failed attempt can't retry the same challenge.
    db.commit()
    if challenge is None:
        raise HTTPException(status_code=400, detail="Missing or expired registration challenge")
    try:
        credential = webauthn.complete_registration(
            db, user, challenge["rp_id"], challenge["state"], body.credential, body.name
        )
    except Exception as exc:
        raise HTTPException(status_code=400, detail=f"Passkey registration failed: {exc}") from exc
    db.commit()
    return {"ok": True, "id": credential.id, "name": credential.name}


@router.delete("/passkeys/{passkey_id}", status_code=status.HTTP_204_NO_CONTENT)
def delete_passkey(passkey_id: int, db: DbSession, user: RequiredUser) -> None:
    row = (
        db.query(PasskeyCredential)
        .filter(PasskeyCredential.id == passkey_id, PasskeyCredential.user_id == user.id)
        .first()
    )
    if row is None:
        raise HTTPException(status_code=404, detail="Passkey not found")
    db.delete(row)
    db.commit()


# ---------------------------------------------------------------------------
# Authenticated: identity, password, sessions, API tokens
# ---------------------------------------------------------------------------


@router.get("/me")
def whoami(user: RequiredUser) -> dict:
    return _user_payload(user)


class ProfileUpdate(BaseModel):
    name: str = Field(..., min_length=1, max_length=255)


@router.post("/profile")
def complete_profile(body: ProfileUpdate, db: DbSession, user: RequiredUser) -> dict:
    """Set the display name and clear the profile-setup flag."""
    user.name = body.name.strip()
    user.needs_profile_setup = False
    db.commit()
    return _user_payload(user)


class PasswordChange(BaseModel):
    current_password: str
    new_password: str


@router.post("/password")
def change_password(
    request: Request, body: PasswordChange, db: DbSession, user: RequiredUser
) -> dict:
    """Change the current user's password; revokes all other sessions."""
    if user.password_hash is not None and not verify_password(
        user.password_hash, body.current_password
    ):
        raise HTTPException(status_code=403, detail="Current password is incorrect")
    if error := validate_password_strength(body.new_password):
        raise HTTPException(status_code=400, detail=error)
    user.password_hash = hash_password(body.new_password)
    revoked = revoke_all_sessions(db, user.id, except_token=request.cookies.get(SESSION_COOKIE))
    db.commit()
    return {"ok": True, "other_sessions_revoked": revoked}


class SessionInfo(BaseModel):
    id: int
    auth_method: str
    created_at: str
    last_seen_at: str | None
    user_agent: str | None
    ip_address: str | None
    current: bool


@router.get("/sessions", response_model=list[SessionInfo])
def list_sessions(request: Request, db: DbSession, user: RequiredUser) -> list[SessionInfo]:
    current_hash = None
    if raw := request.cookies.get(SESSION_COOKIE):
        current_hash = hashlib.sha256(raw.encode()).hexdigest()
    now = datetime.now(UTC)
    rows = (
        db.query(AuthSession)
        .filter(
            AuthSession.user_id == user.id,
            AuthSession.revoked_at.is_(None),
            AuthSession.expires_at > now,
        )
        .order_by(AuthSession.last_seen_at.desc())
        .all()
    )
    return [
        SessionInfo(
            id=r.id,
            auth_method=r.auth_method,
            created_at=r.created_at.isoformat(),
            last_seen_at=r.last_seen_at.isoformat() if r.last_seen_at else None,
            user_agent=r.user_agent,
            ip_address=r.ip_address,
            current=r.token_hash == current_hash,
        )
        for r in rows
    ]


@router.delete("/sessions/{session_id}", status_code=status.HTTP_204_NO_CONTENT)
def revoke_session_by_id(session_id: int, db: DbSession, user: RequiredUser) -> None:
    row = (
        db.query(AuthSession)
        .filter(AuthSession.id == session_id, AuthSession.user_id == user.id)
        .first()
    )
    if row is None:
        raise HTTPException(status_code=404, detail="Session not found")
    if row.revoked_at is None:
        row.revoked_at = datetime.now(UTC)
    db.commit()


@router.post("/sessions/revoke-others")
def revoke_other_sessions(request: Request, db: DbSession, user: RequiredUser) -> dict:
    revoked = revoke_all_sessions(db, user.id, except_token=request.cookies.get(SESSION_COOKIE))
    db.commit()
    return {"ok": True, "revoked": revoked}


class TokenInfo(BaseModel):
    id: int
    name: str
    created_at: str
    last_used_at: str | None
    expires_at: str | None


class TokenCreate(BaseModel):
    name: str = Field(min_length=1, max_length=100)
    # Optional lifetime in days; omit (or null) for a non-expiring token.
    expires_in_days: int | None = Field(default=None, ge=1, le=3650)


@router.get("/tokens", response_model=list[TokenInfo])
def list_api_tokens(db: DbSession, user: RequiredUser) -> list[TokenInfo]:
    rows = (
        db.query(ApiToken)
        .filter(ApiToken.user_id == user.id, ApiToken.revoked_at.is_(None))
        .order_by(ApiToken.created_at.desc())
        .all()
    )
    return [
        TokenInfo(
            id=r.id,
            name=r.name,
            created_at=r.created_at.isoformat(),
            last_used_at=r.last_used_at.isoformat() if r.last_used_at else None,
            expires_at=r.expires_at.isoformat() if r.expires_at else None,
        )
        for r in rows
    ]


@router.post("/tokens", status_code=status.HTTP_201_CREATED)
def create_token(body: TokenCreate, db: DbSession, user: RequiredUser) -> dict:
    """Mint an API token. The raw token appears in this response only."""
    expires_at = None
    if body.expires_in_days is not None:
        expires_at = datetime.now(UTC) + timedelta(days=body.expires_in_days)
    record, raw = create_api_token(db, user, body.name, expires_at=expires_at)
    db.commit()
    return {
        "id": record.id,
        "name": record.name,
        "token": raw,
        "expires_at": record.expires_at.isoformat() if record.expires_at else None,
    }


@router.delete("/tokens/{token_id}", status_code=status.HTTP_204_NO_CONTENT)
def revoke_token(token_id: int, db: DbSession, user: RequiredUser) -> None:
    row = db.query(ApiToken).filter(ApiToken.id == token_id, ApiToken.user_id == user.id).first()
    if row is None:
        raise HTTPException(status_code=404, detail="Token not found")
    if row.revoked_at is None:
        row.revoked_at = datetime.now(UTC)
    db.commit()
