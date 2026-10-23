"""User management endpoints."""

import re
from datetime import UTC, datetime, timedelta
from typing import Annotated

from fastapi import APIRouter, HTTPException, Request, UploadFile, status
from fastapi.responses import FileResponse
from pydantic import AfterValidator, BaseModel, Field
from sqlalchemy import or_
from sqlalchemy.orm import Session

from opal.api.deps import CurrentUserId, DbSession, PaginationParams, RequiredAdmin, RequiredUser
from opal.core import avatars
from opal.core.audit import get_model_dict, log_create, log_delete, log_update
from opal.core.events import emit_user_activity
from opal.core.people import profile_fields
from opal.core.roles import ADMIN_KEY, roles_by_user
from opal.db.models import PasskeyCredential, Role, User, UserRole, Workcenter

router = APIRouter()

# Timeout for considering a user "online" (30 seconds)
PRESENCE_TIMEOUT_SECONDS = 30


def _check_email(value: str) -> str:
    """Syntax-only email check.

    Deliberately not ``EmailStr``: that rejects reserved names such as ``.local``, which
    are exactly what small local-first teams use on a LAN.
    """
    value = value.strip()
    if len(value) > 255 or not re.fullmatch(r"[^@\s]+@[^@\s.]+(\.[^@\s.]+)+", value):
        raise ValueError("Not a valid email address")
    return value


Email = Annotated[str, AfterValidator(_check_email)]


class UserCreate(BaseModel):
    """Schema for creating a user.

    When no password is given the account starts passwordless and its owner
    sets one on first login (same trust-on-first-use flow as migration).
    """

    name: str
    username: str | None = None
    password: str | None = None
    email: Email | None = None
    is_admin: bool = False


class UserUpdate(BaseModel):
    """Schema for updating a user."""

    name: str | None = None
    email: Email | None = None
    is_active: bool | None = None
    is_admin: bool | None = None
    job_title: str | None = Field(None, max_length=120)
    phone: str | None = Field(None, max_length=40)
    workcenter_id: int | None = None


class WorkcenterRef(BaseModel):
    id: int
    name: str


class RoleRef(BaseModel):
    id: int
    name: str


class UserResponse(BaseModel):
    """Schema for user response."""

    id: int
    name: str
    username: str | None = None
    email: str | None
    is_active: bool
    is_admin: bool
    created_at: str
    updated_at: str
    last_seen_at: str | None = None
    current_activity: str | None = None
    is_online: bool = False
    # Sign-in facts an admin needs to decide how to hand an account over.
    has_password: bool = False
    has_passkey: bool = False
    sso_linked: bool = False
    job_title: str | None = None
    phone: str | None = None
    workcenter: WorkcenterRef | None = None
    roles: list[RoleRef] = []
    avatar_url: str | None = None

    model_config = {"from_attributes": True}


class UserListResponse(BaseModel):
    """Schema for user list response."""

    items: list[UserResponse]
    total: int


def _is_online(user: User) -> bool:
    if not user.last_seen_at:
        return False
    cutoff = datetime.now(UTC).timestamp() - PRESENCE_TIMEOUT_SECONDS
    return user.last_seen_at.timestamp() > cutoff


def user_response(db: Session, user: User, roles: list[dict] | None = None) -> UserResponse:
    """Build the API shape for one user. ``roles`` skips the per-user role query."""
    has_passkey = (
        db.query(PasskeyCredential.id).filter(PasskeyCredential.user_id == user.id).first()
        is not None
    )
    return UserResponse(
        id=user.id,
        name=user.name,
        username=user.username,
        email=user.email,
        is_active=user.is_active,
        is_admin=user.is_admin,
        created_at=user.created_at.isoformat(),
        updated_at=user.updated_at.isoformat(),
        last_seen_at=user.last_seen_at.isoformat() if user.last_seen_at else None,
        current_activity=user.current_activity,
        is_online=_is_online(user),
        has_password=user.password_hash is not None,
        has_passkey=has_passkey,
        sso_linked=user.oidc_subject is not None,
        **profile_fields(db, user, roles),
    )


def _active_admin_count(db: Session) -> int:
    return db.query(User).filter(User.is_admin.is_(True), User.is_active.is_(True)).count()


@router.get("", response_model=UserListResponse)
def list_users(
    db: DbSession,
    pagination: PaginationParams,
    admin: RequiredAdmin,
    search: str | None = None,
    is_active: bool | None = None,
) -> UserListResponse:
    """List users by name. Requires admin.

    ``is_active`` filters to active or deactivated accounts; omit for both.
    ``search`` matches name, username and email.
    """
    query = db.query(User)
    if is_active is not None:
        query = query.filter(User.is_active.is_(is_active))
    if search:
        term = f"%{search.strip()}%"
        query = query.filter(
            or_(User.name.ilike(term), User.username.ilike(term), User.email.ilike(term))
        )
    total = query.count()
    users = query.order_by(User.name).offset(pagination.skip).limit(pagination.limit).all()
    roles = roles_by_user(db, [u.id for u in users])
    return UserListResponse(
        items=[user_response(db, u, roles.get(u.id, [])) for u in users], total=total
    )


class DirectoryEntry(BaseModel):
    id: int
    name: str
    username: str
    job_title: str | None = None
    phone: str | None = None
    workcenter: WorkcenterRef | None = None
    roles: list[RoleRef] = []
    avatar_url: str | None = None


@router.get("/directory", response_model=list[DirectoryEntry])
def user_directory(db: DbSession, user: RequiredUser) -> list[DirectoryEntry]:
    """Active users by name, for assignee and owner pickers. Any signed-in user.

    Carries no email: that stays behind the admin-only listing. Roles are
    qualifications, visible to everyone who works beside the holder.
    """
    rows = db.query(User).filter(User.is_active.is_(True)).order_by(User.name).all()
    roles = roles_by_user(db, [u.id for u in rows])
    return [
        DirectoryEntry(
            id=u.id, name=u.name, username=u.username, **profile_fields(db, u, roles.get(u.id, []))
        )
        for u in rows
    ]


@router.post("", response_model=UserResponse, status_code=status.HTTP_201_CREATED)
def create_user(
    db: DbSession,
    user_in: UserCreate,
    admin: RequiredAdmin,
) -> UserResponse:
    """Create a new user. Requires admin."""
    from opal.core.auth import generate_unique_username, hash_password, validate_password_strength

    password_hash = None
    if user_in.password:
        if error := validate_password_strength(user_in.password):
            raise HTTPException(status_code=status.HTTP_400_BAD_REQUEST, detail=error)
        password_hash = hash_password(user_in.password)
    if user_in.email and db.query(User).filter(User.email == user_in.email).first():
        raise HTTPException(
            status_code=status.HTTP_409_CONFLICT,
            detail=f"Email {user_in.email} already belongs to another account",
        )
    username_source = user_in.username or (user_in.email or "").split("@")[0] or user_in.name
    user = User(
        name=user_in.name,
        username=generate_unique_username(db, username_source),
        password_hash=password_hash,
        email=user_in.email,
        is_admin=user_in.is_admin,
    )
    db.add(user)
    db.flush()

    log_create(db, user, admin.id)
    db.commit()
    db.refresh(user)
    return user_response(db, user)


def _visible_user(db: Session, user_id: int, acting: User) -> User:
    """The user row, if ``acting`` may see it: admins see anyone, others only themselves."""
    if not acting.is_admin and acting.id != user_id:
        raise HTTPException(status_code=status.HTTP_403_FORBIDDEN, detail="Admin access required")
    user = db.query(User).filter(User.id == user_id).first()
    if not user:
        raise HTTPException(
            status_code=status.HTTP_404_NOT_FOUND,
            detail=f"User {user_id} not found",
        )
    return user


@router.get("/{user_id:int}", response_model=UserResponse)
def get_user(
    db: DbSession,
    user_id: int,
    acting_user: RequiredUser,
) -> UserResponse:
    """Get a specific user. Admins may read anyone; others only themselves."""
    return user_response(db, _visible_user(db, user_id, acting_user))


class ActivityEntry(BaseModel):
    timestamp: str
    table: str
    action: str
    subject: str | None


_SUBJECT_KEYS = (
    "internal_pn",
    "opal_number",
    "req_number",
    "risk_number",
    "issue_number",
    "po_number",
    "work_order_number",
    "name",
    "title",
    "label",
)


def _subject_for(db: Session, table: str, record_id: int, values: dict) -> str | None:
    """Human identifier of an audited record: from the change itself, else the live row."""
    for key in _SUBJECT_KEYS:
        if values.get(key):
            return str(values[key])
    from opal.db.base import Base

    for mapper in Base.registry.mappers:
        if getattr(mapper.class_, "__tablename__", None) == table:
            row = db.get(mapper.class_, record_id)
            if row is None:
                return None
            for key in _SUBJECT_KEYS:
                if getattr(row, key, None):
                    return str(getattr(row, key))
            return None
    return None


@router.get("/{user_id:int}/activity", response_model=list[ActivityEntry])
def user_activity(
    db: DbSession,
    user_id: int,
    acting_user: RequiredUser,
    limit: int = 15,
) -> list[ActivityEntry]:
    """The user's most recent audited changes, newest first."""
    from opal.db.models.audit import AuditLog

    _visible_user(db, user_id, acting_user)
    rows = (
        db.query(AuditLog)
        .filter(AuditLog.user_id == user_id)
        .order_by(AuditLog.timestamp.desc(), AuditLog.id.desc())
        .limit(max(1, min(limit, 100)))
        .all()
    )
    entries = []
    for row in rows:
        values = row.new_values or row.old_values or {}
        subject = _subject_for(db, row.table_name, row.record_id, values)
        entries.append(
            ActivityEntry(
                timestamp=row.timestamp.isoformat(),
                table=row.table_name,
                action=str(getattr(row.action, "value", row.action)),
                subject=subject,
            )
        )
    return entries


@router.patch("/{user_id:int}", response_model=UserResponse)
def update_user(
    db: DbSession,
    user_id: int,
    user_in: UserUpdate,
    acting_user: RequiredUser,
) -> UserResponse:
    """Update a user.

    Non-admins can only edit their own name, email, job title, phone and workcenter.
    Admins can edit any user, including is_admin and is_active.
    Cannot remove admin from, or deactivate, the last active admin.
    """
    user = db.query(User).filter(User.id == user_id).first()
    if not user:
        raise HTTPException(
            status_code=status.HTTP_404_NOT_FOUND,
            detail=f"User {user_id} not found",
        )

    update_data = user_in.model_dump(exclude_unset=True)

    # Non-admin restrictions
    if not acting_user.is_admin:
        # Can only edit self
        if user_id != acting_user.id:
            raise HTTPException(
                status_code=status.HTTP_403_FORBIDDEN,
                detail="Cannot edit other users",
            )
        allowed_fields = {"name", "email", "job_title", "phone", "workcenter_id"}
        disallowed = set(update_data.keys()) - allowed_fields
        if disallowed:
            raise HTTPException(
                status_code=status.HTTP_403_FORBIDDEN,
                detail=f"Cannot change fields: {', '.join(disallowed)}",
            )

    if "name" in update_data:
        update_data["name"] = (update_data["name"] or "").strip()
        if not update_data["name"]:
            raise HTTPException(status_code=status.HTTP_400_BAD_REQUEST, detail="Name is required")

    for key in ("job_title", "phone"):
        if key in update_data:
            update_data[key] = (update_data[key] or "").strip() or None
    wc_id = update_data.get("workcenter_id")
    if wc_id is not None and db.get(Workcenter, wc_id) is None:
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST, detail=f"Workcenter {wc_id} not found"
        )

    if update_data.get("email") and update_data["email"] != user.email:
        clash = (
            db.query(User).filter(User.email == update_data["email"], User.id != user.id).first()
        )
        if clash:
            raise HTTPException(
                status_code=status.HTTP_409_CONFLICT,
                detail=f"Email {update_data['email']} already belongs to another account",
            )

    # Prevent removing the last admin, by demotion or by deactivation
    loses_admin = (update_data.get("is_admin") is False and user.is_admin) or (
        update_data.get("is_active") is False and user.is_admin and user.is_active
    )
    if loses_admin and _active_admin_count(db) <= 1:
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail="Cannot remove the last admin",
        )

    old_data = get_model_dict(user)

    for field, value in update_data.items():
        setattr(user, field, value)

    if update_data.get("is_active") is False:
        from opal.core.auth import revoke_all_sessions

        revoke_all_sessions(db, user.id)

    db.flush()
    log_update(db, user, old_data, acting_user.id)
    db.commit()
    db.refresh(user)
    return user_response(db, user)


@router.delete("/{user_id:int}", status_code=status.HTTP_204_NO_CONTENT)
def delete_user(
    db: DbSession,
    user_id: int,
    acting_user: RequiredUser,
) -> None:
    """Deactivate a user account.

    Non-admins can only deactivate themselves.
    Cannot deactivate the last admin.
    """
    user = db.query(User).filter(User.id == user_id).first()
    if not user:
        raise HTTPException(
            status_code=status.HTTP_404_NOT_FOUND,
            detail=f"User {user_id} not found",
        )

    # Non-admins can only deactivate self
    if not acting_user.is_admin and user_id != acting_user.id:
        raise HTTPException(
            status_code=status.HTTP_403_FORBIDDEN,
            detail="Cannot deactivate other users",
        )

    # Prevent deactivating last admin
    if user.is_admin and user.is_active and _active_admin_count(db) <= 1:
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail="Cannot deactivate the last admin",
        )

    from opal.core.auth import revoke_all_sessions

    old_data = get_model_dict(user)
    user.is_active = False
    revoke_all_sessions(db, user.id)
    db.flush()
    log_update(db, user, old_data, acting_user.id)
    db.commit()


@router.post("/{user_id:int}/reset-password")
def reset_password(
    db: DbSession,
    user_id: int,
    admin: RequiredAdmin,
) -> dict:
    """Clear a user's password and revoke their sessions. Requires admin.

    The owner then claims the account through an admin-issued claim link
    (see ``issue_claim_link``). Resetting your own password here would lock
    you out, so that goes through ``POST /auth/password`` instead.
    """
    from opal.core.auth import revoke_all_sessions

    user = db.query(User).filter(User.id == user_id).first()
    if not user:
        raise HTTPException(
            status_code=status.HTTP_404_NOT_FOUND,
            detail=f"User {user_id} not found",
        )
    if user.id == admin.id:
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail="Change your own password instead of resetting it",
        )

    old_data = get_model_dict(user)
    user.password_hash = None
    revoked = revoke_all_sessions(db, user.id)
    db.flush()
    log_update(db, user, old_data, admin.id)
    db.commit()
    return {"ok": True, "sessions_revoked": revoked}


# ============ Presence Tracking ============


class HeartbeatRequest(BaseModel):
    """Heartbeat request to update presence."""

    activity: str | None = None  # e.g., "executing:123", "viewing:parts:45"


class HeartbeatResponse(BaseModel):
    """Heartbeat response."""

    user_id: int
    last_seen_at: str
    current_activity: str | None


class OnlineUserResponse(BaseModel):
    """Online user info."""

    id: int
    name: str
    last_seen_at: str
    current_activity: str | None
    is_online: bool
    job_title: str | None = None
    phone: str | None = None
    workcenter: WorkcenterRef | None = None
    roles: list[RoleRef] = []
    avatar_url: str | None = None


CLAIM_LINK_TTL = timedelta(days=7)


class ClaimLinkResponse(BaseModel):
    url: str
    expires_at: datetime


@router.post("/{user_id:int}/claim-link", response_model=ClaimLinkResponse)
def issue_claim_link(
    user_id: int, request: Request, db: DbSession, admin: RequiredAdmin
) -> ClaimLinkResponse:
    """Mint an out-of-band account-claim link for a passwordless user. Admin only.

    Instead of letting whoever reaches the login form seize a migrated account,
    an admin generates this time-limited link and delivers it to the real
    person over a trusted channel. Valid only while the account has no password.
    """
    from opal.core.auth import sign_payload

    user = db.query(User).filter(User.id == user_id).first()
    if user is None:
        raise HTTPException(status_code=404, detail="User not found")
    if not user.is_active or user.password_hash is not None:
        raise HTTPException(
            status_code=400, detail="This account already has a password; no claim link is needed"
        )
    token = sign_payload({"kind": "account-claim", "uid": user.id}, max_age=CLAIM_LINK_TTL)
    return ClaimLinkResponse(
        url=f"{request.base_url}claim?token={token}",
        expires_at=datetime.now(UTC) + CLAIM_LINK_TTL,
    )


@router.post("/heartbeat", response_model=HeartbeatResponse)
async def heartbeat(
    data: HeartbeatRequest,
    db: DbSession,
    user_id: CurrentUserId,
) -> HeartbeatResponse:
    """Update user presence (heartbeat).

    Call this periodically (every 10-15 seconds) to maintain online status.
    Include current activity to show what the user is doing.
    """
    user = db.query(User).filter(User.id == user_id).first()
    if not user:
        raise HTTPException(status_code=404, detail="User not found")

    now = datetime.now(UTC)
    user.last_seen_at = now

    # Track activity change for event emission
    old_activity = user.current_activity
    if data.activity is not None:
        user.current_activity = data.activity

    db.commit()
    db.refresh(user)

    # Emit activity event if activity changed
    if data.activity is not None and data.activity != old_activity:
        await emit_user_activity(user.id, user.name, data.activity)

    return HeartbeatResponse(
        user_id=user.id,
        last_seen_at=user.last_seen_at.isoformat(),
        current_activity=user.current_activity,
    )


@router.get("/online", response_model=list[OnlineUserResponse])
def get_online_users(
    db: DbSession,
) -> list[OnlineUserResponse]:
    """Get list of currently online users.

    Users are considered online if they've sent a heartbeat within the timeout window.
    """
    cutoff = datetime.now(UTC).timestamp() - PRESENCE_TIMEOUT_SECONDS

    users = db.query(User).filter(User.is_active == True, User.last_seen_at.isnot(None)).all()  # noqa: E712

    roles = roles_by_user(db, [u.id for u in users])
    result = []
    for user in users:
        if user.last_seen_at:
            is_online = user.last_seen_at.timestamp() > cutoff
            result.append(
                OnlineUserResponse(
                    id=user.id,
                    name=user.name,
                    last_seen_at=user.last_seen_at.isoformat(),
                    current_activity=user.current_activity,
                    is_online=is_online,
                    **profile_fields(db, user, roles.get(user.id, [])),
                )
            )

    # Sort by online status (online first) then by name
    result.sort(key=lambda x: (not x.is_online, x.name))
    return result


@router.get("/{user_id:int}/presence", response_model=OnlineUserResponse)
def get_user_presence(
    user_id: int,
    db: DbSession,
) -> OnlineUserResponse:
    """Get presence status for a specific user."""
    user = db.query(User).filter(User.id == user_id).first()
    if not user:
        raise HTTPException(status_code=404, detail="User not found")

    is_online = _is_online(user)

    return OnlineUserResponse(
        id=user.id,
        name=user.name,
        last_seen_at=user.last_seen_at.isoformat() if user.last_seen_at else "",
        current_activity=user.current_activity,
        is_online=is_online,
        **profile_fields(db, user),
    )


# ============ Roles ============


class UserRolesSet(BaseModel):
    role_ids: list[int]


@router.put("/{user_id:int}/roles", response_model=UserResponse)
def set_user_roles(
    user_id: int, data: UserRolesSet, db: DbSession, admin: RequiredAdmin
) -> UserResponse:
    """Replace the roles a user holds with exactly ``role_ids``. Admin only.

    The Admin role is not a stored grant: including or excluding its id sets or
    clears ``is_admin``. Removing the last active admin is refused."""
    user = db.get(User, user_id)
    if user is None:
        raise HTTPException(status_code=404, detail=f"User {user_id} not found")
    wanted = set(data.role_ids)
    live = {
        r.id: r for r in db.query(Role).filter(Role.id.in_(wanted), Role.deleted_at.is_(None)).all()
    }
    missing = wanted - set(live)
    if missing:
        raise HTTPException(
            status_code=400, detail=f"Unknown role id(s): {', '.join(map(str, sorted(missing)))}"
        )
    admin_ids = {rid for rid, r in live.items() if r.key == ADMIN_KEY}
    want_admin = bool(admin_ids)
    wanted -= admin_ids
    if user.is_admin and not want_admin and user.is_active and _active_admin_count(db) <= 1:
        raise HTTPException(status_code=400, detail="Cannot remove the last admin")
    if user.is_admin != want_admin:
        old_user = get_model_dict(user)
        user.is_admin = want_admin
        db.flush()
        log_update(db, user, old_user, admin.id)
    grants = db.query(UserRole).filter(UserRole.user_id == user.id).all()
    held = {g.role_id for g in grants}
    for grant in grants:
        if grant.role_id not in wanted:
            log_delete(db, grant, admin.id)
            db.delete(grant)
    for role_id in sorted(wanted - held):
        grant = UserRole(user_id=user.id, role_id=role_id, granted_by_id=admin.id)
        db.add(grant)
        db.flush()
        log_create(db, grant, admin.id)
    db.commit()
    return user_response(db, user)


# ============ Avatars ============

AVATAR_TYPES = ("image/png", "image/jpeg", "image/webp", "image/gif")


def _self_or_admin(user_id: int, acting: User) -> None:
    if acting.id != user_id and not acting.is_admin:
        raise HTTPException(status_code=403, detail="Cannot change another user's avatar")


@router.post("/{user_id:int}/avatar", response_model=UserResponse)
async def upload_avatar(
    user_id: int, file: UploadFile, db: DbSession, acting_user: RequiredUser
) -> UserResponse:
    """Set the user's photo (PNG, JPEG, WebP or GIF, at most 2 MB). The user
    themself or an admin. The client sends a 256x256 square."""
    _self_or_admin(user_id, acting_user)
    user = db.get(User, user_id)
    if user is None:
        raise HTTPException(status_code=404, detail=f"User {user_id} not found")
    if file.content_type not in AVATAR_TYPES:
        raise HTTPException(
            status_code=400,
            detail=f"File type '{file.content_type}' is not allowed. Allowed: "
            + ", ".join(AVATAR_TYPES),
        )
    data = await file.read(avatars.MAX_AVATAR_BYTES + 1)
    if len(data) > avatars.MAX_AVATAR_BYTES:
        raise HTTPException(
            status_code=413, detail=f"Avatar too large. Max: {avatars.MAX_AVATAR_BYTES} bytes"
        )
    mime = avatars.sniff_image(data)
    if mime is None:
        raise HTTPException(status_code=400, detail="File is not a PNG, JPEG, WebP or GIF image")
    old = get_model_dict(user)
    avatars.store_avatar(user, data, mime, "upload")
    db.flush()
    log_update(db, user, old, acting_user.id)
    db.commit()
    db.refresh(user)
    return user_response(db, user)


@router.delete("/{user_id:int}/avatar", response_model=UserResponse)
def delete_avatar(user_id: int, db: DbSession, acting_user: RequiredUser) -> UserResponse:
    """Remove the user's photo; initials show instead and the OIDC provider's
    picture will not refill it. The user themself or an admin."""
    _self_or_admin(user_id, acting_user)
    user = db.get(User, user_id)
    if user is None:
        raise HTTPException(status_code=404, detail=f"User {user_id} not found")
    old = get_model_dict(user)
    avatars.remove_avatar(user)
    db.flush()
    log_update(db, user, old, acting_user.id)
    db.commit()
    db.refresh(user)
    return user_response(db, user)


@router.get("/{user_id:int}/avatar")
def get_avatar(user_id: int, db: DbSession, acting_user: RequiredUser) -> FileResponse:
    """The photo. The URL carries a version (``?v=``) so it caches for a year."""
    user = db.get(User, user_id)
    path = avatars.avatar_path(user) if user and user.avatar_source != "removed" else None
    if user is None or path is None or not path.is_file():
        raise HTTPException(status_code=404, detail="No avatar")
    return FileResponse(
        path,
        media_type=user.avatar_mime or "application/octet-stream",
        headers={
            "Cache-Control": "private, max-age=31536000",
            "X-Content-Type-Options": "nosniff",
        },
    )
