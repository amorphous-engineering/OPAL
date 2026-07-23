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
from opal.api.net import client_ip, request_is_secure
from opal.core import webauthn
from opal.core.auth import (
    SESSION_COOKIE,
    SESSION_LIFETIME,
    create_api_token,
    create_session,
    hash_password,
    revoke_all_sessions,
    sign_payload,
    validate_password_strength,
    verify_password,
    verify_payload,
)
from opal.db.models import ApiToken, AuthSession, PasskeyCredential

public_router = APIRouter(prefix="/auth", tags=["auth"])
router = APIRouter(prefix="/auth", tags=["auth"])

PASSKEY_STATE_COOKIE = "opal_webauthn_state"


def set_session_cookie(response: Response, request: Request, token: str) -> None:
    """Attach the session cookie with the right security attributes."""
    response.set_cookie(
        SESSION_COOKIE,
        token,
        max_age=int(SESSION_LIFETIME.total_seconds()),
        httponly=True,
        samesite="lax",
        secure=request_is_secure(request),
    )


def clear_session_cookie(response: Response) -> None:
    response.delete_cookie(SESSION_COOKIE)


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
    return {
        "id": user.id,
        "username": user.username,
        "name": user.name,
        "email": user.email,
        "is_admin": user.is_admin,
    }


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
