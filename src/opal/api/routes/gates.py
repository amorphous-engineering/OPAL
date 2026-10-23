"""Permission gates: which roles may pass which privileged actions.

``GET /gates`` is readable by any signed-in user (the UI renders inert controls
with a reason); ``PUT /gates/{key}`` is admin only. Admin passes every gate and
need not be listed.
"""

from fastapi import APIRouter, HTTPException
from pydantic import BaseModel

from opal.api.deps import DbSession, RequiredAdmin, RequiredUser
from opal.core.audit import log_create, log_delete
from opal.core.gates import GATES, gate_role_ids
from opal.db.models import Role, RoleGate

router = APIRouter(prefix="/gates", tags=["gates"])


class GateResponse(BaseModel):
    key: str
    label: str
    description: str
    role_ids: list[int]


class GateSet(BaseModel):
    role_ids: list[int]


def _response(db: DbSession, key: str) -> GateResponse:
    label, description, _ = GATES[key]
    return GateResponse(
        key=key, label=label, description=description, role_ids=gate_role_ids(db, key)
    )


@router.get("", response_model=list[GateResponse])
def list_gates(db: DbSession, user: RequiredUser) -> list[GateResponse]:
    """Every gate with the ids of the roles that pass it (Admin always passes)."""
    return [_response(db, key) for key in GATES]


@router.put("/{key}", response_model=GateResponse)
def set_gate(key: str, data: GateSet, db: DbSession, admin: RequiredAdmin) -> GateResponse:
    """Replace the roles that pass a gate with exactly ``role_ids``. Admin only."""
    if key not in GATES:
        raise HTTPException(status_code=404, detail=f"Unknown gate '{key}'")
    wanted = set(data.role_ids)
    live = {r.id for r in db.query(Role).filter(Role.id.in_(wanted), Role.deleted_at.is_(None))}
    missing = wanted - live
    if missing:
        raise HTTPException(
            status_code=400, detail=f"Unknown role id(s): {', '.join(map(str, sorted(missing)))}"
        )
    rows = db.query(RoleGate).filter(RoleGate.gate == key).all()
    held = {r.role_id for r in rows}
    for row in rows:
        if row.role_id not in wanted:
            log_delete(db, row, admin.id)
            db.delete(row)
    for role_id in sorted(wanted - held):
        row = RoleGate(role_id=role_id, gate=key)
        db.add(row)
        db.flush()
        log_create(db, row, admin.id)
    db.commit()
    return _response(db, key)
