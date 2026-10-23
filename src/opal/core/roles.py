"""Roles (qualifications): lookup, membership and the sign-off check.

A sign-off slot that names a role can only be signed by a user holding it.
Matching is case-insensitive and ignores soft-deleted roles. ``is_admin`` plays
no part here.
"""

from collections.abc import Iterable

from sqlalchemy import func
from sqlalchemy.orm import Session

from opal.db.models import Role, UserRole


class UnknownRoleError(ValueError):
    """A sign-off slot names a role that does not exist."""


def find_role(db: Session, name: str | None) -> Role | None:
    """The live role called ``name`` (any casing), or None."""
    cleaned = (name or "").strip()
    if not cleaned:
        return None
    return (
        db.query(Role)
        .filter(func.lower(Role.name) == cleaned.lower(), Role.deleted_at.is_(None))
        .first()
    )


def canonical_role_name(db: Session, name: str | None) -> str | None:
    """None for a blank name; the role's canonical name for a known one.
    Raises UnknownRoleError otherwise."""
    cleaned = (name or "").strip()
    if not cleaned:
        return None
    role = find_role(db, cleaned)
    if role is None:
        raise UnknownRoleError(f"Unknown role '{cleaned}'")
    return role.name


def user_has_role(db: Session, user_id: int, role_name: str | None) -> bool:
    """True when the slot names no role, or the user holds the named live role."""
    if not (role_name or "").strip():
        return True
    role = find_role(db, role_name)
    if role is None:
        return False
    return (
        db.query(UserRole.id)
        .filter(UserRole.user_id == user_id, UserRole.role_id == role.id)
        .first()
        is not None
    )


def role_names_of(db: Session, user_id: int) -> set[str]:
    """Lower-cased names of the live roles a user holds."""
    return {r["name"].lower() for r in roles_by_user(db, [user_id]).get(user_id, [])}


def roles_by_user(db: Session, user_ids: Iterable[int]) -> dict[int, list[dict[str, object]]]:
    """``{user_id: [{id, name}, ...]}`` (by name) for live roles; one query."""
    ids = list(set(user_ids))
    if not ids:
        return {}
    rows = (
        db.query(UserRole.user_id, Role.id, Role.name)
        .join(Role, Role.id == UserRole.role_id)
        .filter(UserRole.user_id.in_(ids), Role.deleted_at.is_(None))
        .order_by(func.lower(Role.name))
        .all()
    )
    out: dict[int, list[dict[str, object]]] = {}
    for uid, rid, name in rows:
        out.setdefault(uid, []).append({"id": rid, "name": name})
    return out
