"""Permission gates: which roles may perform which privileged actions.

The registry below lists exactly the gates that exist. Admins pass every gate
(god mode); anyone else needs a live role an admin has mapped to the gate
(``role_gate``). Buy-off slots are not gates: each template slot names its own
role.
"""

from sqlalchemy import func
from sqlalchemy.orm import Session

from opal.db.models import Role, RoleGate, User, UserRole

# key -> (label, description, default system-role keys)
GATES: dict[str, tuple[str, str, tuple[str, ...]]] = {
    "issue.disposition": (
        "Disposition issue tickets",
        "Sign the disposition of a containment-bearing issue.",
        ("engineer",),
    ),
    "issue.approve": (
        "Approve resolutions",
        "Sign off an issue in review to Done, or close an issue.",
        ("quality",),
    ),
}


class GateDenied(PermissionError):
    """The user lacks a gate; the message names the roles that pass it."""


def gate_role_ids(db: Session, key: str) -> list[int]:
    """Ids of the live roles mapped to ``key`` (Admin is implicit unless mapped)."""
    rows = (
        db.query(RoleGate.role_id)
        .join(Role, Role.id == RoleGate.role_id)
        .filter(RoleGate.gate == key, Role.deleted_at.is_(None))
        .order_by(RoleGate.role_id)
    )
    return [rid for (rid,) in rows]


def gate_allows(db: Session, user: User | int | None, key: str) -> bool:
    """True for an admin, or a user holding a live role mapped to ``key``."""
    if user is None:
        return False
    if not isinstance(user, User):
        user = db.get(User, user)
        if user is None:
            return False
    if user.is_admin:
        return True
    return (
        db.query(UserRole.id)
        .join(RoleGate, RoleGate.role_id == UserRole.role_id)
        .join(Role, Role.id == UserRole.role_id)
        .filter(
            UserRole.user_id == user.id,
            RoleGate.gate == key,
            Role.deleted_at.is_(None),
        )
        .first()
        is not None
    )


def gate_refusal(db: Session, key: str) -> str:
    """``Requires Engineer`` / ``Requires Engineer or Quality``; ``Requires Admin``
    when no role is mapped."""
    names = [
        n
        for (n,) in db.query(Role.name)
        .join(RoleGate, RoleGate.role_id == Role.id)
        .filter(RoleGate.gate == key, Role.deleted_at.is_(None))
        .order_by(func.lower(Role.name))
    ]
    return "Requires " + (" or ".join(names) if names else "Admin")


def require_gate(db: Session, user: User | int | None, key: str) -> None:
    """Raise GateDenied("Requires <roles>") unless ``user`` passes ``key``."""
    if not gate_allows(db, user, key):
        raise GateDenied(gate_refusal(db, key))
