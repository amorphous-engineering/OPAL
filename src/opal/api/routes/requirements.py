"""Requirements endpoints: first-class Requirement CRUD + part allocations.

Two resource families share the /requirements prefix:

- First-class requirements (Requirement model): list/create at the root,
  detail/update/delete at /{id}, lifecycle actions at /{id}/baseline,
  /{id}/revise, /{id}/cancel, revision chain at /{id}/revisions.
- Part allocations (PartRequirement rows): /parts/{part_id} to list/assign,
  /allocations/{id} to update/verify/unassign. Allocation rows link to the
  Requirement table via requirement_ref_id; the legacy yaml catalog
  (/project) remains readable for one minor version.
"""

from datetime import UTC, datetime

from fastapi import APIRouter, HTTPException, status
from pydantic import BaseModel, Field

from opal.api.deps import CurrentUserId, DbSession
from opal.config import get_active_project
from opal.core.audit import get_model_dict, log_create, log_delete, log_update
from opal.core.designators import generate_requirement_number
from opal.db.base import LifecycleState
from opal.db.models import Part, PartRequirement, Requirement
from opal.se.baseline import baseline_batch, write_baseline_event
from opal.se.lifecycle import LifecycleError, baseline, cancel, ensure_mutable, revise
from opal.se.lint import lint_requirement
from opal.se.readiness import readiness, ready_requirement_ids

router = APIRouter()

VERIFICATION_METHODS = ("analysis", "inspection", "demonstration", "test")


# ============ First-class requirement schemas ============


class RequirementCreate(BaseModel):
    """Create a requirement (always starts as a draft)."""

    title: str = Field(..., min_length=1, max_length=255)
    statement: str = Field(..., min_length=1)
    rationale: str | None = None
    category: str | None = Field(None, max_length=50)
    parent_id: int | None = None
    level: int | None = Field(None, ge=0, description="Defaults to parent.level + 1, or 0")
    verification_method: str | None = None
    tbd: bool = False
    tbr: bool = False
    tbr_owner_id: int | None = None
    tbr_due: datetime | None = None


class RequirementUpdateSchema(BaseModel):
    """Update a draft/preliminary requirement in place."""

    title: str | None = Field(None, min_length=1, max_length=255)
    statement: str | None = Field(None, min_length=1)
    rationale: str | None = None
    category: str | None = Field(None, max_length=50)
    parent_id: int | None = None
    level: int | None = Field(None, ge=0)
    verification_method: str | None = None
    tbd: bool | None = None
    tbr: bool | None = None
    tbr_owner_id: int | None = None
    tbr_due: datetime | None = None
    lifecycle_state: str | None = Field(
        None, description="Only draft <-> preliminary transitions are allowed here"
    )


class RequirementResponse(BaseModel):
    """First-class requirement response."""

    id: int
    req_number: str
    revision: int
    lifecycle_state: str
    title: str
    statement: str
    rationale: str | None = None
    category: str | None = None
    parent_id: int | None = None
    level: int
    verification_method: str | None = None
    tbd: bool
    tbr: bool
    tbr_owner_id: int | None = None
    tbr_due: datetime | None = None
    stale: bool = False
    baselined_at: datetime | None = None
    baselined_by_id: int | None = None
    supersedes_id: int | None = None
    children_count: int = 0
    allocation_count: int = 0
    created_at: datetime
    updated_at: datetime

    model_config = {"from_attributes": True}


class RequirementListResponse(BaseModel):
    """Paginated requirement list."""

    items: list[RequirementResponse]
    total: int


def _req_response(db: DbSession, req: Requirement) -> RequirementResponse:
    children_count = (
        db.query(Requirement)
        .filter(Requirement.parent_id == req.id, Requirement.deleted_at.is_(None))
        .count()
    )
    allocation_count = (
        db.query(PartRequirement).filter(PartRequirement.requirement_ref_id == req.id).count()
    )
    resp = RequirementResponse.model_validate(req)
    resp.children_count = children_count
    resp.allocation_count = allocation_count
    return resp


def _get_requirement(db: DbSession, req_id: int) -> Requirement:
    req = (
        db.query(Requirement)
        .filter(Requirement.id == req_id, Requirement.deleted_at.is_(None))
        .first()
    )
    if not req:
        raise HTTPException(
            status_code=status.HTTP_404_NOT_FOUND, detail=f"Requirement {req_id} not found"
        )
    return req


def _validate_verification_method(value: str | None) -> None:
    if value is not None and value not in VERIFICATION_METHODS:
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail=f"verification_method must be one of: {', '.join(VERIFICATION_METHODS)}",
        )


class LintRequest(BaseModel):
    """Lint arbitrary requirement fields — no stored row required."""

    statement: str
    rationale: str | None = None
    verification_method: str | None = None
    tbd: bool = False
    tbr: bool = False
    tbr_owner_id: int | None = None
    tbr_due: datetime | None = None


class LintResponse(BaseModel):
    """Findings plus whether they would block baseline."""

    findings: list[dict]
    would_block_baseline: bool


# ============ First-class requirement endpoints ============


@router.post("/lint", response_model=LintResponse)
async def lint_requirement_fields(data: LintRequest) -> LintResponse:
    """Lint requirement fields as typed. Same engine the baseline gate enforces."""
    findings = lint_requirement(
        data.statement,
        rationale=data.rationale,
        verification_method=data.verification_method,
        tbd=data.tbd,
        tbr=data.tbr,
        tbr_owner_id=data.tbr_owner_id,
        tbr_due=data.tbr_due,
    )
    return LintResponse(
        findings=[f.to_dict() for f in findings],
        would_block_baseline=any(f.severity == "block_baseline" for f in findings),
    )


@router.get("", response_model=RequirementListResponse)
async def list_requirements(
    db: DbSession,
    state: str | None = None,
    category: str | None = None,
    level: int | None = None,
    parent_id: int | None = None,
    q: str | None = None,
    include_superseded: bool = False,
    page: int = 1,
    page_size: int = 100,
) -> RequirementListResponse:
    """List requirements. Superseded revisions are hidden unless requested."""
    query = db.query(Requirement).filter(Requirement.deleted_at.is_(None))

    if not include_superseded:
        query = query.filter(Requirement.lifecycle_state != LifecycleState.SUPERSEDED.value)
    if state:
        query = query.filter(Requirement.lifecycle_state == state)
    if category:
        query = query.filter(Requirement.category == category)
    if level is not None:
        query = query.filter(Requirement.level == level)
    if parent_id is not None:
        query = query.filter(Requirement.parent_id == parent_id)
    if q:
        term = f"%{q}%"
        query = query.filter(
            Requirement.req_number.ilike(term)
            | Requirement.title.ilike(term)
            | Requirement.statement.ilike(term)
        )

    total = query.count()
    reqs = (
        query.order_by(Requirement.req_number, Requirement.revision)
        .offset((page - 1) * page_size)
        .limit(page_size)
        .all()
    )
    return RequirementListResponse(items=[_req_response(db, r) for r in reqs], total=total)


@router.post("", response_model=RequirementResponse, status_code=status.HTTP_201_CREATED)
async def create_requirement(
    db: DbSession,
    data: RequirementCreate,
    user_id: CurrentUserId,
) -> RequirementResponse:
    """Create a new draft requirement with an auto-assigned REQ number."""
    _validate_verification_method(data.verification_method)

    parent = None
    if data.parent_id is not None:
        parent = (
            db.query(Requirement)
            .filter(Requirement.id == data.parent_id, Requirement.deleted_at.is_(None))
            .first()
        )
        if not parent:
            raise HTTPException(
                status_code=status.HTTP_400_BAD_REQUEST,
                detail=f"Parent requirement {data.parent_id} not found",
            )

    level = data.level
    if level is None:
        level = parent.level + 1 if parent else 0

    req = Requirement(
        req_number=generate_requirement_number(db),
        title=data.title,
        statement=data.statement,
        rationale=data.rationale,
        category=data.category,
        parent_id=data.parent_id,
        level=level,
        verification_method=data.verification_method,
        tbd=data.tbd,
        tbr=data.tbr,
        tbr_owner_id=data.tbr_owner_id,
        tbr_due=data.tbr_due,
    )
    db.add(req)
    db.flush()
    log_create(db, req, user_id)
    db.commit()
    db.refresh(req)
    return _req_response(db, req)


@router.get("/{req_id:int}", response_model=RequirementResponse)
async def get_requirement(db: DbSession, req_id: int) -> RequirementResponse:
    """Get a requirement by ID."""
    return _req_response(db, _get_requirement(db, req_id))


@router.patch("/{req_id:int}", response_model=RequirementResponse)
async def update_requirement(
    db: DbSession,
    req_id: int,
    data: RequirementUpdateSchema,
    user_id: CurrentUserId,
) -> RequirementResponse:
    """Update a draft/preliminary requirement. Baselined rows are immutable (409)."""
    req = _get_requirement(db, req_id)
    try:
        ensure_mutable(req)
    except LifecycleError as err:
        raise HTTPException(status_code=status.HTTP_409_CONFLICT, detail=str(err)) from err

    _validate_verification_method(data.verification_method)

    if data.lifecycle_state is not None and data.lifecycle_state not in (
        LifecycleState.DRAFT.value,
        LifecycleState.PRELIMINARY.value,
    ):
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail="Only draft <-> preliminary transitions are allowed here; "
            "use /baseline, /revise, or /cancel for the rest",
        )

    if data.parent_id is not None:
        if data.parent_id == req.id:
            raise HTTPException(
                status_code=status.HTTP_400_BAD_REQUEST,
                detail="A requirement cannot be its own parent",
            )
        parent = (
            db.query(Requirement)
            .filter(Requirement.id == data.parent_id, Requirement.deleted_at.is_(None))
            .first()
        )
        if not parent:
            raise HTTPException(
                status_code=status.HTTP_400_BAD_REQUEST,
                detail=f"Parent requirement {data.parent_id} not found",
            )

    old_values = get_model_dict(req)
    for field in (
        "title",
        "statement",
        "rationale",
        "category",
        "parent_id",
        "level",
        "verification_method",
        "tbd",
        "tbr",
        "tbr_owner_id",
        "tbr_due",
        "lifecycle_state",
    ):
        value = getattr(data, field)
        if value is not None:
            setattr(req, field, value)

    # Any edit is by definition a fresh look — clear staleness (spec §7).
    if data.model_dump(exclude_unset=True):
        req.stale = False

    log_update(db, req, old_values, user_id)
    db.commit()
    db.refresh(req)
    return _req_response(db, req)


@router.delete("/{req_id:int}", status_code=status.HTTP_204_NO_CONTENT)
async def delete_requirement(db: DbSession, req_id: int, user_id: CurrentUserId) -> None:
    """Soft-delete a requirement. Baselined rows must be cancelled first."""
    req = _get_requirement(db, req_id)
    if req.is_baselined:
        raise HTTPException(
            status_code=status.HTTP_409_CONFLICT,
            detail="Baselined requirements cannot be deleted — cancel or revise instead",
        )
    children = (
        db.query(Requirement)
        .filter(Requirement.parent_id == req.id, Requirement.deleted_at.is_(None))
        .count()
    )
    if children:
        raise HTTPException(
            status_code=status.HTTP_409_CONFLICT,
            detail=f"Requirement has {children} child requirement(s); re-parent them first",
        )
    log_delete(db, req, user_id)
    req.soft_delete()
    db.commit()


@router.post("/{req_id:int}/baseline", response_model=RequirementResponse)
async def baseline_requirement(
    db: DbSession, req_id: int, user_id: CurrentUserId
) -> RequirementResponse:
    """Baseline a requirement. Returns 409 with the list of blockers if not ready.

    Single-item baselines write a baseline event too (label null) — one
    configuration history regardless of which path locked the revision.
    """
    req = _get_requirement(db, req_id)
    old_values = get_model_dict(req)
    try:
        baseline(db, req, user_id)
    except LifecycleError as err:
        raise HTTPException(status_code=status.HTTP_409_CONFLICT, detail=str(err)) from err
    write_baseline_event(db, [req], user_id)
    log_update(db, req, old_values, user_id)
    db.commit()
    db.refresh(req)
    return _req_response(db, req)


class BaselineBatchRequest(BaseModel):
    """Commit a staged queue session in one transaction."""

    ids: list[int] = Field(..., min_length=1)
    label: str | None = Field(None, max_length=100)
    note: str | None = None


@router.post("/baseline-batch")
async def baseline_batch_endpoint(
    db: DbSession, data: BaselineBatchRequest, user_id: CurrentUserId
) -> dict:
    """Baseline a set atomically: every item re-validates at commit time;
    any failure aborts the whole batch and returns the offenders."""
    reqs = []
    for req_id in data.ids:
        reqs.append(_get_requirement(db, req_id))

    old_values = {req.id: get_model_dict(req) for req in reqs}
    event, offenders = baseline_batch(db, reqs, user_id, label=data.label, note=data.note)
    if offenders:
        # baseline_batch validates before any lifecycle flip — nothing to roll back.
        raise HTTPException(
            status_code=status.HTTP_409_CONFLICT,
            detail={"message": "batch aborted — items no longer ready", "offenders": offenders},
        )
    for req in reqs:
        log_update(db, req, old_values[req.id], user_id)
    db.commit()
    return {
        "event_id": event.id,
        "label": event.label,
        "baselined": [
            {"id": r.id, "req_number": r.req_number, "revision": r.revision} for r in reqs
        ],
    }


@router.get("/queue")
async def baseline_queue(db: DbSession) -> dict:
    """The ready set — draft/preliminary rows whose hard checks all pass."""
    ids = ready_requirement_ids(db)
    return {"count": len(ids), "ids": ids}


@router.post(
    "/{req_id:int}/revise",
    response_model=RequirementResponse,
    status_code=status.HTTP_201_CREATED,
)
async def revise_requirement(
    db: DbSession, req_id: int, user_id: CurrentUserId
) -> RequirementResponse:
    """Create the next draft revision of a baselined requirement."""
    req = _get_requirement(db, req_id)
    try:
        new_req = revise(db, req)
    except LifecycleError as err:
        raise HTTPException(status_code=status.HTTP_409_CONFLICT, detail=str(err)) from err
    log_create(db, new_req, user_id)
    db.commit()
    db.refresh(new_req)
    return _req_response(db, new_req)


@router.post("/{req_id:int}/cancel", response_model=RequirementResponse)
async def cancel_requirement(
    db: DbSession, req_id: int, user_id: CurrentUserId
) -> RequirementResponse:
    """Cancel a requirement (terminal state)."""
    req = _get_requirement(db, req_id)
    old_values = get_model_dict(req)
    try:
        cancel(db, req)
    except LifecycleError as err:
        raise HTTPException(status_code=status.HTTP_409_CONFLICT, detail=str(err)) from err
    log_update(db, req, old_values, user_id)
    db.commit()
    db.refresh(req)
    return _req_response(db, req)


@router.post("/{req_id:int}/reaffirm", response_model=RequirementResponse)
async def reaffirm_requirement(
    db: DbSession, req_id: int, user_id: CurrentUserId
) -> RequirementResponse:
    """Clear staleness without an edit: 'the parent's change doesn't invalidate this'.

    Signature semantics — audit-logged with the session user. Works on
    baselined rows too; staleness is metadata, not content.
    """
    req = _get_requirement(db, req_id)
    if not req.stale:
        raise HTTPException(
            status_code=status.HTTP_409_CONFLICT, detail="Requirement is not stale"
        )
    old_values = get_model_dict(req)
    req.stale = False
    log_update(db, req, old_values, user_id)
    db.commit()
    db.refresh(req)
    return _req_response(db, req)


@router.get("/{req_id:int}/readiness")
async def requirement_readiness(db: DbSession, req_id: int) -> dict:
    """Structured baseline-readiness checks — what the baseline panel renders."""
    return readiness(db, _get_requirement(db, req_id))


@router.get("/{req_id:int}/revisions", response_model=list[RequirementResponse])
async def list_revisions(db: DbSession, req_id: int) -> list[RequirementResponse]:
    """All revisions sharing this requirement's number, oldest first."""
    req = _get_requirement(db, req_id)
    revisions = (
        db.query(Requirement)
        .filter(Requirement.req_number == req.req_number, Requirement.deleted_at.is_(None))
        .order_by(Requirement.revision)
        .all()
    )
    return [_req_response(db, r) for r in revisions]


# ============ Part allocation schemas (PartRequirement) ============


class RequirementAssign(BaseModel):
    """Schema for assigning a requirement to a part."""

    requirement_id: str
    notes: str | None = None


class AllocationUpdate(BaseModel):
    """Schema for updating a part requirement allocation."""

    status: str | None = None  # open, verified, waived, not_applicable
    notes: str | None = None


class RequirementVerify(BaseModel):
    """Schema for verifying a requirement allocation."""

    notes: str | None = None


class PartRequirementResponse(BaseModel):
    """Schema for part requirement response."""

    id: int
    part_id: int
    requirement_id: str
    requirement_ref_id: int | None = None
    requirement_title: str | None = None
    requirement_description: str | None = None
    requirement_category: str | None = None
    status: str
    notes: str | None
    verified_at: str | None
    verified_by_id: int | None
    created_at: str
    updated_at: str

    model_config = {"from_attributes": True}


class ProjectRequirementResponse(BaseModel):
    """Schema for project requirement from config (deprecated yaml catalog)."""

    id: str
    title: str
    description: str
    category: str


def get_requirement_response(db: DbSession, pr: PartRequirement) -> PartRequirementResponse:
    """Convert PartRequirement to response, preferring the first-class row."""
    req_title = None
    req_desc = None
    req_cat = None

    if pr.requirement_ref_id:
        req = db.query(Requirement).filter(Requirement.id == pr.requirement_ref_id).first()
        if req:
            req_title = req.title
            req_desc = req.statement
            req_cat = req.category

    if req_title is None:
        project = get_active_project()
        if project:
            req_config = project.get_requirement(pr.requirement_id)
            if req_config:
                req_title = req_config.title
                req_desc = req_config.description
                req_cat = req_config.category

    return PartRequirementResponse(
        id=pr.id,
        part_id=pr.part_id,
        requirement_id=pr.requirement_id,
        requirement_ref_id=pr.requirement_ref_id,
        requirement_title=req_title,
        requirement_description=req_desc,
        requirement_category=req_cat,
        status=pr.status,
        notes=pr.notes,
        verified_at=pr.verified_at.isoformat() if pr.verified_at else None,
        verified_by_id=pr.verified_by_id,
        created_at=pr.created_at.isoformat(),
        updated_at=pr.updated_at.isoformat(),
    )


# ============ Part allocation endpoints ============


@router.get("/project", response_model=list[ProjectRequirementResponse])
async def list_project_requirements() -> list[ProjectRequirementResponse]:
    """List requirements from the deprecated yaml catalog (use GET /requirements)."""
    project = get_active_project()
    if not project:
        return []

    return [
        ProjectRequirementResponse(
            id=req.id,
            title=req.title,
            description=req.description,
            category=req.category,
        )
        for req in project.requirements
    ]


@router.get("/parts/{part_id}", response_model=list[PartRequirementResponse])
async def list_part_requirements(
    db: DbSession,
    part_id: int,
) -> list[PartRequirementResponse]:
    """List all requirements assigned to a part."""
    part = db.query(Part).filter(Part.id == part_id, Part.deleted_at.is_(None)).first()
    if not part:
        raise HTTPException(
            status_code=status.HTTP_404_NOT_FOUND,
            detail=f"Part {part_id} not found",
        )

    reqs = db.query(PartRequirement).filter(PartRequirement.part_id == part_id).all()
    return [get_requirement_response(db, pr) for pr in reqs]


@router.post(
    "/parts/{part_id}", response_model=PartRequirementResponse, status_code=status.HTTP_201_CREATED
)
async def assign_requirement(
    db: DbSession,
    part_id: int,
    req_in: RequirementAssign,
    user_id: CurrentUserId,
) -> PartRequirementResponse:
    """Assign a requirement to a part by REQ number (first-class or yaml)."""
    part = db.query(Part).filter(Part.id == part_id, Part.deleted_at.is_(None)).first()
    if not part:
        raise HTTPException(
            status_code=status.HTTP_404_NOT_FOUND,
            detail=f"Part {part_id} not found",
        )

    # Resolve against the first-class table (current revision), then yaml.
    req_row = (
        db.query(Requirement)
        .filter(
            Requirement.req_number == req_in.requirement_id,
            Requirement.deleted_at.is_(None),
            Requirement.lifecycle_state != LifecycleState.SUPERSEDED.value,
        )
        .order_by(Requirement.revision.desc())
        .first()
    )
    if not req_row:
        project = get_active_project()
        if not project or not project.get_requirement(req_in.requirement_id):
            raise HTTPException(
                status_code=status.HTTP_400_BAD_REQUEST,
                detail=f"Requirement {req_in.requirement_id} not found",
            )

    existing = (
        db.query(PartRequirement)
        .filter(
            PartRequirement.part_id == part_id,
            PartRequirement.requirement_id == req_in.requirement_id,
        )
        .first()
    )
    if existing:
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail=f"Requirement {req_in.requirement_id} already assigned to part {part_id}",
        )

    pr = PartRequirement(
        part_id=part_id,
        requirement_id=req_in.requirement_id,
        requirement_ref_id=req_row.id if req_row else None,
        notes=req_in.notes,
    )
    db.add(pr)
    db.commit()
    db.refresh(pr)

    log_create(db, pr, user_id)
    db.commit()

    return get_requirement_response(db, pr)


@router.patch("/allocations/{allocation_id}", response_model=PartRequirementResponse)
async def update_part_requirement(
    db: DbSession,
    allocation_id: int,
    req_in: AllocationUpdate,
    user_id: CurrentUserId,
) -> PartRequirementResponse:
    """Update a part requirement allocation."""
    pr = db.query(PartRequirement).filter(PartRequirement.id == allocation_id).first()
    if not pr:
        raise HTTPException(
            status_code=status.HTTP_404_NOT_FOUND,
            detail=f"Part requirement {allocation_id} not found",
        )

    old_values = get_model_dict(pr)

    if req_in.status is not None:
        if req_in.status not in ("open", "verified", "waived", "not_applicable"):
            raise HTTPException(
                status_code=status.HTTP_400_BAD_REQUEST,
                detail="Status must be one of: open, verified, waived, not_applicable",
            )
        pr.status = req_in.status

    if req_in.notes is not None:
        pr.notes = req_in.notes

    db.commit()
    db.refresh(pr)

    log_update(db, pr, old_values, user_id)
    db.commit()

    return get_requirement_response(db, pr)


@router.post("/allocations/{allocation_id}/verify", response_model=PartRequirementResponse)
async def verify_requirement(
    db: DbSession,
    allocation_id: int,
    verify_in: RequirementVerify,
    user_id: CurrentUserId,
) -> PartRequirementResponse:
    """Mark a requirement allocation as verified."""
    pr = db.query(PartRequirement).filter(PartRequirement.id == allocation_id).first()
    if not pr:
        raise HTTPException(
            status_code=status.HTTP_404_NOT_FOUND,
            detail=f"Part requirement {allocation_id} not found",
        )

    old_values = get_model_dict(pr)

    pr.status = "verified"
    pr.verified_at = datetime.now(UTC)
    pr.verified_by_id = user_id
    if verify_in.notes:
        pr.notes = verify_in.notes

    db.commit()
    db.refresh(pr)

    log_update(db, pr, old_values, user_id)
    db.commit()

    return get_requirement_response(db, pr)


@router.delete("/allocations/{allocation_id}", status_code=status.HTTP_204_NO_CONTENT)
async def unassign_requirement(
    db: DbSession,
    allocation_id: int,
    user_id: CurrentUserId,
) -> None:
    """Remove a requirement assignment from a part."""
    pr = db.query(PartRequirement).filter(PartRequirement.id == allocation_id).first()
    if not pr:
        raise HTTPException(
            status_code=status.HTTP_404_NOT_FOUND,
            detail=f"Part requirement {allocation_id} not found",
        )

    log_delete(db, pr, user_id)
    db.delete(pr)
    db.commit()
