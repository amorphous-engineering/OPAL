"""Role (qualification) management.

Admins keep the list of roles and grant them to users (``PUT /users/{id}/roles``).
A template sign-off slot names a role; only a holder (or an admin) can sign it.
Four system roles exist on every install and cannot be deleted or renamed; the
Admin role's members are the users with ``is_admin``.
"""

from typing import Any

from fastapi import APIRouter, HTTPException, status
from pydantic import BaseModel, Field, field_validator
from sqlalchemy import func
from sqlalchemy.orm import Session

from opal.api.deps import DbSession, RequiredAdmin, RequiredUser
from opal.core.audit import get_model_dict, log_create, log_delete, log_update
from opal.core.people import person_ref
from opal.core.roles import ADMIN_KEY, SYSTEM_ROLES, find_role
from opal.db.models import Role, RoleGate, User, UserRole

router = APIRouter(prefix="/roles", tags=["roles"])

MAX_NAME = 50


def _clean_name(value: str) -> str:
    value = value.strip()
    if not value:
        raise ValueError("Role name is required")
    return value


class RoleCreate(BaseModel):
    name: str = Field(..., max_length=MAX_NAME)
    description: str | None = Field(None, max_length=1000)

    _name = field_validator("name")(_clean_name)


class RoleUpdate(BaseModel):
    name: str | None = Field(None, max_length=MAX_NAME)
    description: str | None = Field(None, max_length=1000)

    @field_validator("name")
    @classmethod
    def _name(cls, value: str | None) -> str | None:
        return None if value is None else _clean_name(value)


class RoleResponse(BaseModel):
    id: int
    name: str
    description: str | None
    key: str | None = None
    is_system: bool = False
    member_count: int
    created_at: str
    updated_at: str


class RoleDetail(RoleResponse):
    members: list[dict[str, Any]]


def _member_counts(db: Session) -> dict[int, int]:
    rows = (
        db.query(UserRole.role_id, func.count(UserRole.id))
        .join(User, User.id == UserRole.user_id)
        .filter(User.is_active.is_(True))
        .group_by(UserRole.role_id)
        .all()
    )
    counts = dict(rows)
    admins = db.query(User).filter(User.is_admin.is_(True), User.is_active.is_(True)).count()
    for (rid,) in db.query(Role.id).filter(Role.key == ADMIN_KEY):
        counts[rid] = admins  # Admin membership IS the flag
    return counts


def _system_first(role: Role) -> tuple[int, int, str]:
    keys = list(SYSTEM_ROLES)
    if role.key in keys:
        return (0, keys.index(role.key), "")
    return (1, 0, role.name.lower())


def _response(role: Role, counts: dict[int, int]) -> RoleResponse:
    return RoleResponse(
        id=role.id,
        name=role.name,
        description=role.description,
        key=role.key,
        is_system=role.is_system,
        member_count=counts.get(role.id, 0),
        created_at=role.created_at.isoformat(),
        updated_at=role.updated_at.isoformat(),
    )


def _live_role(db: Session, role_id: int) -> Role:
    role = db.get(Role, role_id)
    if role is None or role.deleted_at is not None:
        raise HTTPException(status_code=404, detail=f"Role {role_id} not found")
    return role


@router.get("", response_model=list[RoleResponse])
def list_roles(db: DbSession, user: RequiredUser) -> list[RoleResponse]:
    """Live roles, system roles first (Engineer, Technician, Quality, Admin) then
    custom roles by name, each with its count of active members."""
    counts = _member_counts(db)
    roles = db.query(Role).filter(Role.deleted_at.is_(None)).all()
    roles.sort(key=_system_first)
    return [_response(r, counts) for r in roles]


@router.get("/{role_id}", response_model=RoleDetail)
def get_role(role_id: int, db: DbSession, user: RequiredUser) -> RoleDetail:
    """One role with its active members."""
    role = _live_role(db, role_id)
    if role.key == ADMIN_KEY:
        members = (
            db.query(User)
            .filter(User.is_admin.is_(True), User.is_active.is_(True))
            .order_by(User.name)
            .all()
        )
    else:
        members = (
            db.query(User)
            .join(UserRole, UserRole.user_id == User.id)
            .filter(UserRole.role_id == role.id, User.is_active.is_(True))
            .order_by(User.name)
            .all()
        )
    base = _response(role, {role.id: len(members)})
    return RoleDetail(**base.model_dump(), members=[person_ref(m) for m in members])


@router.post("", response_model=RoleResponse, status_code=status.HTTP_201_CREATED)
def create_role(data: RoleCreate, db: DbSession, admin: RequiredAdmin) -> RoleResponse:
    """Create a role. Admin only. A soft-deleted role of the same name is
    brought back (without its former members)."""
    existing = db.query(Role).filter(func.lower(Role.name) == data.name.lower()).first()
    if existing is not None and existing.deleted_at is None:
        raise HTTPException(status_code=409, detail=f"Role '{existing.name}' already exists")
    if existing is not None:
        old = get_model_dict(existing)
        existing.restore()
        existing.name = data.name
        existing.description = data.description
        db.flush()
        log_update(db, existing, old, admin.id)
        role = existing
    else:
        role = Role(name=data.name, description=data.description)
        db.add(role)
        db.flush()
        log_create(db, role, admin.id)
    db.commit()
    db.refresh(role)
    return _response(role, {})


@router.patch("/{role_id}", response_model=RoleResponse)
def update_role(
    role_id: int, data: RoleUpdate, db: DbSession, admin: RequiredAdmin
) -> RoleResponse:
    """Rename or describe a role. Admin only.

    Sign-offs already on templates keep the name they were written with; a
    rename therefore does not rewrite templates or published versions.
    """
    role = _live_role(db, role_id)
    fields = data.model_fields_set
    if "name" in fields and data.name is None:
        raise HTTPException(status_code=400, detail="Role name is required")
    if role.is_system and data.name is not None and data.name != role.name:
        raise HTTPException(
            status_code=400, detail=f"{role.name} is a system role; it cannot be renamed"
        )
    if data.name is not None:
        clash = find_role(db, data.name)
        if clash is not None and clash.id != role.id:
            raise HTTPException(status_code=409, detail=f"Role '{clash.name}' already exists")
    old = get_model_dict(role)
    if data.name is not None:
        role.name = data.name
    if "description" in fields:
        role.description = data.description
    db.flush()
    log_update(db, role, old, admin.id)
    db.commit()
    db.refresh(role)
    return _response(role, _member_counts(db))


@router.delete("/{role_id}", status_code=status.HTTP_204_NO_CONTENT)
def delete_role(role_id: int, db: DbSession, admin: RequiredAdmin) -> None:
    """Soft-delete a role and drop its grants. Admin only."""
    role = _live_role(db, role_id)
    if role.is_system:
        raise HTTPException(
            status_code=400, detail=f"{role.name} is a system role; it cannot be deleted"
        )
    for grant in db.query(UserRole).filter(UserRole.role_id == role.id).all():
        log_delete(db, grant, admin.id)
        db.delete(grant)
    for gate in db.query(RoleGate).filter(RoleGate.role_id == role.id).all():
        log_delete(db, gate, admin.id)
        db.delete(gate)
    log_delete(db, role, admin.id)
    role.soft_delete()
    db.commit()
