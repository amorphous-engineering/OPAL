"""Workcenter API routes."""

from datetime import datetime

from fastapi import APIRouter, HTTPException, Query
from pydantic import BaseModel, Field
from sqlalchemy import func

from opal.api.deps import CurrentUserId, DbSession
from opal.core.audit import get_model_dict, log_create, log_update
from opal.core.workcenters import default_steps, queued_counts, queued_steps
from opal.db.models import Workcenter
from opal.db.models.procedure import ProcedureStep

router = APIRouter(prefix="/workcenters", tags=["workcenters"])


class WorkcenterCreate(BaseModel):
    """Schema for creating a workcenter."""

    name: str = Field(..., min_length=1, max_length=255)
    code: str = Field(..., min_length=1, max_length=50)
    description: str | None = None
    location: str | None = Field(None, max_length=255)
    is_active: bool = True


class WorkcenterUpdate(BaseModel):
    """Schema for updating a workcenter."""

    name: str | None = Field(None, min_length=1, max_length=255)
    code: str | None = Field(None, min_length=1, max_length=50)
    description: str | None = None
    location: str | None = Field(None, max_length=255)
    is_active: bool | None = None


class WorkcenterResponse(BaseModel):
    """Schema for workcenter response."""

    id: int
    name: str
    code: str
    description: str | None
    location: str | None
    is_active: bool
    default_step_count: int = 0
    queued_step_count: int = 0

    model_config = {"from_attributes": True}


class DefaultStepResponse(BaseModel):
    """A master procedure step that defaults to the workcenter."""

    procedure_id: int
    procedure_name: str
    procedure_status: str
    step_number: str
    title: str


class QueuedStepResponse(BaseModel):
    """An unfinished step of an open execution that runs at the workcenter."""

    instance_id: int
    work_order_number: str | None
    procedure_id: int
    procedure_name: str
    instance_status: str
    priority: int
    target_completion_at: datetime | None
    step_number_str: str
    step_title: str | None
    step_status: str

    model_config = {"from_attributes": True}


class WorkcenterWorkResponse(BaseModel):
    """What a workcenter is for and what is waiting at it."""

    default_steps: list[DefaultStepResponse]
    queue: list[QueuedStepResponse]


def _with_counts(db: DbSession, workcenters: list[Workcenter]) -> list[WorkcenterResponse]:
    ids = [w.id for w in workcenters]
    defaults = dict(
        db.query(ProcedureStep.workcenter_id, func.count(ProcedureStep.id))
        .filter(ProcedureStep.workcenter_id.in_(ids))
        .group_by(ProcedureStep.workcenter_id)
        .all()
    )
    queued = queued_counts(db)
    return [
        WorkcenterResponse(
            id=w.id,
            name=w.name,
            code=w.code,
            description=w.description,
            location=w.location,
            is_active=w.is_active,
            default_step_count=defaults.get(w.id, 0),
            queued_step_count=queued.get(w.id, 0),
        )
        for w in workcenters
    ]


@router.get("")
def list_workcenters(
    db: DbSession,
    active_only: bool = Query(True, description="Only show active workcenters"),
    search: str | None = Query(None, description="Search by name or code"),
) -> list[WorkcenterResponse]:
    """List all workcenters."""
    query = db.query(Workcenter)

    if active_only:
        query = query.filter(Workcenter.is_active == True)  # noqa: E712

    if search:
        search_term = f"%{search}%"
        query = query.filter(
            (Workcenter.name.ilike(search_term)) | (Workcenter.code.ilike(search_term))
        )

    query = query.order_by(Workcenter.code)
    return _with_counts(db, query.all())


@router.post("", status_code=201)
def create_workcenter(
    data: WorkcenterCreate,
    db: DbSession,
    user_id: CurrentUserId,
) -> WorkcenterResponse:
    """Create a new workcenter."""
    # Check for duplicate code
    existing = db.query(Workcenter).filter(func.lower(Workcenter.code) == data.code.lower()).first()
    if existing:
        raise HTTPException(status_code=400, detail=f"Workcenter code '{data.code}' already exists")

    workcenter = Workcenter(
        name=data.name,
        code=data.code.upper(),
        description=data.description,
        location=data.location,
        is_active=data.is_active,
    )
    db.add(workcenter)
    db.commit()
    db.refresh(workcenter)

    log_create(db, workcenter, user_id)
    db.commit()

    return _with_counts(db, [workcenter])[0]


@router.get("/{workcenter_id}")
def get_workcenter(
    workcenter_id: int,
    db: DbSession,
) -> WorkcenterResponse:
    """Get a workcenter by ID."""
    workcenter = db.query(Workcenter).filter(Workcenter.id == workcenter_id).first()
    if not workcenter:
        raise HTTPException(status_code=404, detail="Workcenter not found")
    return _with_counts(db, [workcenter])[0]


@router.get("/{workcenter_id}/work")
def get_workcenter_work(workcenter_id: int, db: DbSession) -> WorkcenterWorkResponse:
    """Procedure steps that default to this workcenter and the open work queued at it."""
    workcenter = db.query(Workcenter).filter(Workcenter.id == workcenter_id).first()
    if not workcenter:
        raise HTTPException(status_code=404, detail="Workcenter not found")
    return WorkcenterWorkResponse(
        default_steps=[
            DefaultStepResponse(
                procedure_id=s.procedure_id,
                procedure_name=s.procedure.name,
                procedure_status=getattr(s.procedure.status, "value", s.procedure.status),
                step_number=s.step_number,
                title=s.title,
            )
            for s in default_steps(db, workcenter)
        ],
        queue=[QueuedStepResponse.model_validate(q) for q in queued_steps(db, workcenter_id)],
    )


@router.patch("/{workcenter_id}")
def update_workcenter(
    workcenter_id: int,
    data: WorkcenterUpdate,
    db: DbSession,
    user_id: CurrentUserId,
) -> WorkcenterResponse:
    """Update a workcenter."""
    workcenter = db.query(Workcenter).filter(Workcenter.id == workcenter_id).first()
    if not workcenter:
        raise HTTPException(status_code=404, detail="Workcenter not found")

    old_values = get_model_dict(workcenter)

    update_data = data.model_dump(exclude_unset=True)

    # Check for duplicate code if changing
    if "code" in update_data and update_data["code"].upper() != workcenter.code:
        existing = (
            db.query(Workcenter)
            .filter(
                func.lower(Workcenter.code) == update_data["code"].lower(),
                Workcenter.id != workcenter_id,
            )
            .first()
        )
        if existing:
            raise HTTPException(
                status_code=400,
                detail=f"Workcenter code '{update_data['code']}' already exists",
            )
        update_data["code"] = update_data["code"].upper()

    for field, value in update_data.items():
        setattr(workcenter, field, value)

    db.commit()
    db.refresh(workcenter)

    log_update(db, workcenter, old_values, user_id)
    db.commit()

    return _with_counts(db, [workcenter])[0]


@router.delete("/{workcenter_id}", status_code=204)
def delete_workcenter(
    workcenter_id: int,
    db: DbSession,
    user_id: CurrentUserId,
) -> None:
    """Deactivate a workcenter (soft delete)."""
    workcenter = db.query(Workcenter).filter(Workcenter.id == workcenter_id).first()
    if not workcenter:
        raise HTTPException(status_code=404, detail="Workcenter not found")

    old_values = get_model_dict(workcenter)

    # Soft delete by deactivating
    workcenter.is_active = False
    db.commit()
    db.refresh(workcenter)

    log_update(db, workcenter, old_values, user_id)
    db.commit()
