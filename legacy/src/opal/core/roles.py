"""Roles (qualifications): lookup, membership and the sign-off check.

A sign-off slot that names a role can only be signed by a user holding it, or
by an admin (god mode). Matching is case-insensitive and ignores soft-deleted
roles.

Four system roles (Engineer, Technician, Quality, Admin) exist on every
install. The Admin role is not stored as a grant: its membership IS
``User.is_admin``, so ``roles_by_user`` derives it from the flag.
"""

from collections.abc import Iterable

from sqlalchemy import func
from sqlalchemy.orm import Session

from opal.db.models import Role, RoleGate, User, UserRole

ADMIN_KEY = "admin"

# key -> (name, description, gates passed by default). Order is display order.
SYSTEM_ROLES: dict[str, tuple[str, str, tuple[str, ...]]] = {
    "engineer": (
        "Engineer",
        "Dispositions issue tickets and verifies engineering-critical steps.",
        ("issue.disposition",),
    ),
    "technician": ("Technician", "Performs build and assembly steps.", ()),
    "quality": (
        "Quality",
        "Approves issue resolutions and buys off quality-critical steps.",
        ("issue.approve",),
    ),
    "admin": ("Admin", "Administers the application and passes every gate.", ()),
}


class UnknownRoleError(ValueError):
    """A sign-off slot names a role that does not exist."""


def ensure_system_roles(db: Session) -> list[Role]:
    """Create the system roles that are missing, and return all four in display order.

    A role whose name matches a system role case-insensitively (soft-deleted
    included) is converted in place, keeping its id, grants and gate mappings.
    The default gate mappings are added only when a role becomes a system role
    here, never re-added afterwards, so an admin's edits stick. Does not commit."""
    from opal.core.gates import GATES

    out: list[Role] = []
    for key, (name, description, gates) in SYSTEM_ROLES.items():
        role = db.query(Role).filter(Role.key == key).first()
        if role is None:
            role = db.query(Role).filter(func.lower(Role.name) == name.lower()).first()
            if role is None:
                role = Role(name=name, description=description)
                db.add(role)
            elif role.deleted_at is not None:
                role.restore()
            role.key = key
            role.is_system = True
            role.name = name
            if not (role.description or "").strip():
                role.description = description
            db.flush()
            for gate in gates:
                if gate in GATES:
                    db.add(RoleGate(role_id=role.id, gate=gate))
            db.flush()
        out.append(role)
    return out


def admin_role(db: Session) -> Role | None:
    """The live Admin system role, if the install has it."""
    return db.query(Role).filter(Role.key == ADMIN_KEY, Role.deleted_at.is_(None)).first()


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
    if db.query(User.id).filter(User.id == user_id, User.is_admin.is_(True)).first():
        return True  # god mode
    if role.key == ADMIN_KEY:
        return False
    return (
        db.query(UserRole.id)
        .filter(UserRole.user_id == user_id, UserRole.role_id == role.id)
        .first()
        is not None
    )


def role_names_of(db: Session, user_id: int) -> set[str]:
    """Lower-cased names of the live roles a user holds; ``admin`` when the user
    is an admin. Slot checks accept ``admin`` as holding every role."""
    names = {str(r["name"]).lower() for r in roles_by_user(db, [user_id]).get(user_id, [])}
    if db.query(User.id).filter(User.id == user_id, User.is_admin.is_(True)).first():
        names.add(ADMIN_KEY)  # god mode even before the Admin role row exists
    return names


def roles_by_user(db: Session, user_ids: Iterable[int]) -> dict[int, list[dict[str, object]]]:
    """``{user_id: [{id, name}, ...]}`` (by name) for live roles, the Admin role
    included for admins (derived from ``is_admin``); two queries."""
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
    admin = admin_role(db)
    if admin is not None:
        admins = [
            uid for (uid,) in db.query(User.id).filter(User.id.in_(ids), User.is_admin.is_(True))
        ]
        for uid in admins:
            out.setdefault(uid, []).append({"id": admin.id, "name": admin.name})
            out[uid].sort(key=lambda r: str(r["name"]).lower())
    return out


def holds_slot_role(holder_roles: set[str], role: str | None) -> bool:
    """True when a slot naming ``role`` (None: open to all) can be signed by a
    user whose ``role_names_of`` is ``holder_roles``. Admins hold every role."""
    if not (role or "").strip():
        return True
    return "admin" in holder_roles or role.strip().lower() in holder_roles
