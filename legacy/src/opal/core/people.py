"""How a person is shown in API payloads: the one place profile, role and
avatar fields are assembled."""

from typing import Any

from sqlalchemy.orm import Session

from opal.core.avatars import avatar_url
from opal.core.roles import roles_by_user
from opal.db.models import User


def person_ref(user: User | None) -> dict[str, Any] | None:
    """``{id, name, avatar_url}``: a person wherever one appears."""
    if user is None:
        return None
    return {"id": user.id, "name": user.name, "avatar_url": avatar_url(user)}


def profile_fields(
    db: Session, user: User, roles: list[dict[str, Any]] | None = None
) -> dict[str, Any]:
    """job_title, phone, workcenter, roles and avatar_url of a user. Pass
    ``roles`` (from ``roles_by_user``) when rendering many users."""
    if roles is None:
        roles = roles_by_user(db, [user.id]).get(user.id, [])
    wc = user.workcenter
    return {
        "job_title": user.job_title,
        "phone": user.phone,
        "workcenter": {"id": wc.id, "name": wc.name} if wc else None,
        "roles": roles,
        "avatar_url": avatar_url(user),
    }
