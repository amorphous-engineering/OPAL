"""Procedures API routes."""

import copy
from datetime import UTC, datetime
from decimal import Decimal
from typing import Annotated, Any

from fastapi import APIRouter, Form, HTTPException, Query, Response, UploadFile
from pydantic import BaseModel, BeforeValidator, Field, model_validator
from sqlalchemy import func

from opal.api.deps import CurrentUserId, DbSession
from opal.core import procedure_tree as tree
from opal.core.audit import AuditContext, get_model_dict, log_create, log_delete, log_update
from opal.core.callouts import Callout, normalize_callouts, step_callouts
from opal.core.designators import generate_template_number
from opal.core.diff import diff_part_lists, diff_procedure_versions, snapshots_equivalent
from opal.core.part_lifecycle import DraftPartsBlocked, draft_parts_in
from opal.core.roles import UnknownRoleError, canonical_role_name
from opal.core.signoffs import (
    UNSET,
    SignoffError,
    UnknownSignoffRole,
    effective_for,
    effective_signoffs,
    write_signoff_fields,
)
from opal.db.models import InventoryRecord, Kit, Part, ProcedureOutput, Workcenter
from opal.db.models.execution import InstanceStatus, ProcedureInstance
from opal.db.models.procedure import (
    MasterProcedure,
    ProcedureStatus,
    ProcedureStep,
    ProcedureType,
    ProcedureVersion,
    StepDependency,
    StepImage,
    StepKit,
    UsageType,
)

router = APIRouter(prefix="/procedures", tags=["procedures"])


# ============ Schemas ============


class SignoffDef(BaseModel):
    """One sign-off slot of a step definition."""

    label: str = Field(..., min_length=1, max_length=100)
    role: str | None = Field(None, max_length=50)


class StepSchema(BaseModel):
    """Procedure step response."""

    id: int
    order: int
    step_number: str
    level: int
    parent_step_id: int | None = None
    title: str
    instructions: str | None = None
    required_data_schema: dict[str, Any] | None = None
    is_contingency: bool = False
    requires_signoff: bool = False
    signoffs: list[SignoffDef] = []  # the effective list (see core/signoffs)
    estimated_duration_minutes: int | None = None
    required_role: str | None = None
    callouts: Annotated[list[Callout], BeforeValidator(lambda v: [] if v is None else v)] = []
    strict_sequence: bool = False
    workcenter_id: int | None = None
    sub_steps: list["StepSchema"] = []

    model_config = {"from_attributes": True}

    @model_validator(mode="before")
    @classmethod
    def _effective_signoffs(cls, data: Any) -> Any:
        """Serve the effective sign-off list, never the raw (nullable) column."""
        if isinstance(data, ProcedureStep):
            values = {
                name: getattr(data, name)
                for name in cls.model_fields
                if name != "signoffs" and hasattr(data, name)
            }
            values["signoffs"] = effective_for(data, bool(data.sub_steps))
            return values
        return data


class ProcedureResponse(BaseModel):
    """Procedure response."""

    id: int
    template_number: str
    name: str
    description: str | None = None
    status: str
    procedure_type: str = "op"
    current_version_id: int | None = None
    created_at: datetime
    updated_at: datetime
    steps: list[StepSchema] = []
    # Computed on GET /{id} only: does the draft differ from the current
    # published version? None when nothing is published yet.
    unpublished_changes: bool | None = None

    model_config = {"from_attributes": True}


class ProcedureListItem(BaseModel):
    """One row of the procedure list: no step tree, with version and counts."""

    id: int
    template_number: str
    name: str
    description: str | None = None
    status: str
    procedure_type: str = "op"
    current_version_id: int | None = None
    current_version_number: int | None = None
    step_count: int = 0
    execution_count: int = 0
    created_at: datetime
    updated_at: datetime


class ProcedureListResponse(BaseModel):
    """Paginated procedure list."""

    items: list[ProcedureListItem]
    total: int
    page: int
    page_size: int


class ProcedureCreate(BaseModel):
    """Create procedure request."""

    name: str = Field(..., min_length=1, max_length=255)
    description: str | None = None
    procedure_type: str = "op"


class ProcedureUpdate(BaseModel):
    """Update procedure request."""

    name: str | None = Field(None, min_length=1, max_length=255)
    description: str | None = None
    status: str | None = None
    procedure_type: str | None = None


class StepCreate(BaseModel):
    """Create step request."""

    title: str = Field(..., min_length=1, max_length=255)
    instructions: str | None = None
    required_data_schema: dict[str, Any] | None = None
    is_contingency: bool = False
    requires_signoff: bool = False
    signoffs: list[SignoffDef] | None = Field(
        None,
        description="Ordered sign-off slots; the step is complete when all are signed. "
        "Omit to derive from requires_signoff / required_role.",
    )
    estimated_duration_minutes: int | None = Field(None, ge=1)
    required_role: str | None = Field(None, max_length=50)
    callouts: list[Callout] | None = None
    strict_sequence: bool = False
    workcenter_id: int | None = None
    parent_step_id: int | None = Field(None, description="Parent op ID for sub-steps")
    after_step_id: int | None = Field(
        None,
        description="Insert right after this step (a sub-step of the same OP, or the OP itself "
        "to become its first sub-step / the next OP); renumbers. Omit to append.",
    )


class StepUpdate(BaseModel):
    """Update step request."""

    title: str | None = Field(None, min_length=1, max_length=255)
    instructions: str | None = None
    required_data_schema: dict[str, Any] | None = None
    is_contingency: bool | None = None
    requires_signoff: bool | None = None
    signoffs: list[SignoffDef] | None = Field(
        None, description="Replace the sign-off slots; explicit null resets to derived"
    )
    estimated_duration_minutes: int | None = Field(None, ge=1)
    required_role: str | None = Field(None, max_length=50)
    callouts: list[Callout] | None = None
    strict_sequence: bool | None = None
    workcenter_id: int | None = None


class StepMove(BaseModel):
    """Move a step: new parent (null = top level) and index among its siblings."""

    parent_step_id: int | None = None
    index: int = Field(..., ge=0)
    is_contingency: bool | None = Field(
        None, description="Top-level only: contingency group (default: keep the step's)"
    )


class StepReorder(BaseModel):
    """Reorder steps request."""

    step_ids: list[int] = Field(..., description="Step IDs in new order")


class PublishRequest(BaseModel):
    """Optional publish payload."""

    change_note: str | None = Field(None, max_length=2000)


class VersionResponse(BaseModel):
    """Procedure version response."""

    id: int
    version_number: int
    created_at: datetime
    created_by_id: int | None = None
    created_by_name: str | None = None
    change_note: str | None = None
    step_count: int = 0

    model_config = {"from_attributes": True}


class VersionPart(BaseModel):
    """Part identity for a part id referenced by a version snapshot."""

    id: int
    internal_pn: str | None = None
    name: str


class VersionDetailResponse(BaseModel):
    """Procedure version with content."""

    id: int
    version_number: int
    content: dict[str, Any]
    created_at: datetime
    created_by_id: int | None = None
    created_by_name: str | None = None
    change_note: str | None = None
    procedure_id: int
    procedure_template_number: str
    procedure_name: str
    procedure_type: str = "op"
    is_current: bool = False
    # Parts named by kit_items / output_items / step_kit, so a snapshot view
    # can show part numbers without one lookup per row.
    parts: list[VersionPart] = []

    model_config = {"from_attributes": True}


class KitItemResponse(BaseModel):
    """Kit item response."""

    id: int
    part_id: int
    part_name: str
    part_internal_pn: str | None = None
    part_external_pn: str | None = None
    part_lifecycle_state: str | None = None
    part_on_hand: float | None = None
    quantity_required: float


class KitItemCreate(BaseModel):
    """Add part to kit request."""

    part_id: int
    quantity_required: float = Field(..., gt=0)


class KitItemUpdate(BaseModel):
    """Update kit item request."""

    quantity_required: float = Field(..., gt=0)


# ============ Helpers ============


def _build_step_hierarchy(steps: list[ProcedureStep]) -> list[StepSchema]:
    """Build a hierarchical step structure from flat list."""
    # Group steps by parent
    children_map: dict[int | None, list[ProcedureStep]] = {None: []}

    for step in steps:
        parent_id = step.parent_step_id
        if parent_id not in children_map:
            children_map[parent_id] = []
        children_map[parent_id].append(step)

    def build_schema(step: ProcedureStep) -> StepSchema:
        sub_steps = children_map.get(step.id, [])
        return StepSchema(
            id=step.id,
            order=step.order,
            step_number=step.step_number,
            level=step.level,
            parent_step_id=step.parent_step_id,
            title=step.title,
            instructions=step.instructions,
            required_data_schema=step.required_data_schema,
            is_contingency=step.is_contingency,
            requires_signoff=step.requires_signoff,
            signoffs=effective_for(step, bool(sub_steps)),
            estimated_duration_minutes=step.estimated_duration_minutes,
            required_role=step.required_role,
            callouts=step_callouts({"callouts": step.callouts}),
            strict_sequence=step.strict_sequence,
            workcenter_id=step.workcenter_id,
            sub_steps=[build_schema(s) for s in sorted(sub_steps, key=lambda x: x.order)],
        )

    # Build tree starting from top-level steps
    top_level = children_map.get(None, [])
    # Sort: normal ops first (by step_number), then contingency ops
    normal_ops = sorted(
        [s for s in top_level if not s.is_contingency],
        key=lambda x: int(x.step_number) if x.step_number.isdigit() else 0,
    )
    contingency_ops = sorted(
        [s for s in top_level if s.is_contingency], key=lambda x: x.step_number
    )

    return [build_schema(s) for s in normal_ops + contingency_ops]


def _enum_value(v: Any) -> str:
    return v.value if hasattr(v, "value") else str(v)


def _on_hand(db: DbSession, part_ids: list[int]) -> dict[int, float]:
    """Total stock per part id in one query."""
    if not part_ids:
        return {}
    rows = (
        db.query(InventoryRecord.part_id, func.coalesce(func.sum(InventoryRecord.quantity), 0))
        .filter(InventoryRecord.part_id.in_(part_ids))
        .group_by(InventoryRecord.part_id)
        .all()
    )
    return {pid: float(total) for pid, total in rows}


def _kit_response(k: Kit, on_hand: dict[int, float]) -> KitItemResponse:
    return KitItemResponse(
        id=k.id,
        part_id=k.part_id,
        part_name=k.part.name,
        part_internal_pn=k.part.internal_pn,
        part_external_pn=k.part.external_pn,
        part_lifecycle_state=k.part.lifecycle_state,
        part_on_hand=on_hand.get(k.part_id, 0.0),
        quantity_required=float(k.quantity_required),
    )


def _output_response(o: ProcedureOutput) -> "OutputResponse":
    return OutputResponse(
        id=o.id,
        part_id=o.part_id,
        part_name=o.part.name,
        part_internal_pn=o.part.internal_pn,
        part_external_pn=o.part.external_pn,
        part_lifecycle_state=o.part.lifecycle_state,
        quantity_produced=float(o.quantity_produced),
    )


# ============ Procedure CRUD ============


_LIST_SORTS = (
    "number",
    "name",
    "status",
    "type",
    "version",
    "steps",
    "executions",
    "created_at",
    "updated_at",
)


@router.get("", response_model=ProcedureListResponse)
def list_procedures(
    db: DbSession,
    search: str | None = Query(None),
    status: str | None = Query(None),
    procedure_type: str | None = Query(None),
    sort: str = Query("updated_at"),
    dir: str = Query("desc", pattern="^(asc|desc)$"),
    page: int = Query(1, ge=1),
    page_size: int = Query(50, ge=1, le=100),
) -> ProcedureListResponse:
    """List procedures with search, filters, sort, and per-row counts."""
    if sort not in _LIST_SORTS:
        raise HTTPException(status_code=400, detail=f"Unknown sort: {sort}")

    step_counts = (
        db.query(ProcedureStep.procedure_id.label("pid"), func.count(ProcedureStep.id).label("n"))
        .group_by(ProcedureStep.procedure_id)
        .subquery()
    )
    exec_counts = (
        db.query(
            ProcedureInstance.procedure_id.label("pid"),
            func.count(ProcedureInstance.id).label("n"),
        )
        .group_by(ProcedureInstance.procedure_id)
        .subquery()
    )
    steps_col = func.coalesce(step_counts.c.n, 0)
    execs_col = func.coalesce(exec_counts.c.n, 0)
    query = (
        db.query(MasterProcedure, ProcedureVersion.version_number, steps_col, execs_col)
        .outerjoin(ProcedureVersion, ProcedureVersion.id == MasterProcedure.current_version_id)
        .outerjoin(step_counts, step_counts.c.pid == MasterProcedure.id)
        .outerjoin(exec_counts, exec_counts.c.pid == MasterProcedure.id)
        .filter(MasterProcedure.deleted_at.is_(None))
    )

    if search:
        search_term = f"%{search}%"
        query = query.filter(
            MasterProcedure.template_number.ilike(search_term)
            | MasterProcedure.name.ilike(search_term)
            | MasterProcedure.description.ilike(search_term)
        )
    if status:
        query = query.filter(MasterProcedure.status == status)
    if procedure_type:
        query = query.filter(MasterProcedure.procedure_type == procedure_type)

    total = query.count()

    sort_cols = {
        "number": MasterProcedure.template_number,
        "name": func.lower(MasterProcedure.name),
        "status": MasterProcedure.status,
        "type": MasterProcedure.procedure_type,
        "version": ProcedureVersion.version_number,
        "steps": steps_col,
        "executions": execs_col,
        "created_at": MasterProcedure.created_at,
        "updated_at": MasterProcedure.updated_at,
    }
    col = sort_cols[sort]
    ordering = col.asc() if dir == "asc" else col.desc()
    rows = (
        query.order_by(ordering, MasterProcedure.id.desc())
        .offset((page - 1) * page_size)
        .limit(page_size)
        .all()
    )

    return ProcedureListResponse(
        items=[
            ProcedureListItem(
                id=p.id,
                template_number=p.template_number,
                name=p.name,
                description=p.description,
                status=_enum_value(p.status),
                procedure_type=_enum_value(p.procedure_type),
                current_version_id=p.current_version_id,
                current_version_number=version_number,
                step_count=step_count,
                execution_count=exec_count,
                created_at=p.created_at,
                updated_at=p.updated_at,
            )
            for p, version_number, step_count, exec_count in rows
        ],
        total=total,
        page=page,
        page_size=page_size,
    )


@router.post("", response_model=ProcedureResponse, status_code=201)
def create_procedure(
    data: ProcedureCreate,
    db: DbSession,
    user_id: CurrentUserId,
) -> ProcedureResponse:
    """Create a new procedure."""
    procedure = MasterProcedure(
        template_number=generate_template_number(db),
        name=data.name,
        description=data.description,
        procedure_type=ProcedureType(data.procedure_type).value,
        status=ProcedureStatus.DRAFT.value,
    )
    db.add(procedure)
    db.flush()

    log_create(db, procedure, user_id)
    db.commit()
    db.refresh(procedure)

    return ProcedureResponse.model_validate(procedure)


@router.get("/{procedure_id}", response_model=ProcedureResponse)
def get_procedure(
    procedure_id: int,
    db: DbSession,
) -> ProcedureResponse:
    """Get procedure by ID with hierarchical steps."""
    procedure = (
        db.query(MasterProcedure)
        .filter(MasterProcedure.id == procedure_id, MasterProcedure.deleted_at.is_(None))
        .first()
    )
    if not procedure:
        raise HTTPException(status_code=404, detail="Procedure not found")

    # Build hierarchical step structure
    steps = _build_step_hierarchy(procedure.steps)

    unpublished: bool | None = None
    if procedure.current_version_id:
        current = db.get(ProcedureVersion, procedure.current_version_id)
        if current:
            draft = _build_snapshot(db, procedure, list(procedure.steps))
            unpublished = not snapshots_equivalent(draft, current.content)

    return ProcedureResponse(
        unpublished_changes=unpublished,
        id=procedure.id,
        template_number=procedure.template_number,
        name=procedure.name,
        description=procedure.description,
        status=procedure.status.value
        if hasattr(procedure.status, "value")
        else str(procedure.status),
        procedure_type=procedure.procedure_type.value
        if hasattr(procedure.procedure_type, "value")
        else str(procedure.procedure_type),
        current_version_id=procedure.current_version_id,
        created_at=procedure.created_at,
        updated_at=procedure.updated_at,
        steps=steps,
    )


@router.patch("/{procedure_id}", response_model=ProcedureResponse)
def update_procedure(
    procedure_id: int,
    data: ProcedureUpdate,
    db: DbSession,
    user_id: CurrentUserId,
) -> ProcedureResponse:
    """Update procedure metadata."""
    procedure = (
        db.query(MasterProcedure)
        .filter(MasterProcedure.id == procedure_id, MasterProcedure.deleted_at.is_(None))
        .first()
    )
    if not procedure:
        raise HTTPException(status_code=404, detail="Procedure not found")

    old_values = get_model_dict(procedure)

    if data.name is not None:
        procedure.name = data.name
    if data.description is not None:
        procedure.description = data.description
    if data.status is not None:
        try:
            new_status = ProcedureStatus(data.status).value
        except ValueError as err:
            raise HTTPException(status_code=400, detail=f"Invalid status: {data.status}") from err
        if new_status == ProcedureStatus.ACTIVE.value and not procedure.current_version_id:
            raise HTTPException(
                status_code=400, detail="Publish a version before activating this template"
            )
        procedure.status = new_status
    if data.procedure_type is not None:
        try:
            procedure.procedure_type = ProcedureType(data.procedure_type).value
        except ValueError as err:
            raise HTTPException(
                status_code=400, detail=f"Invalid procedure type: {data.procedure_type}"
            ) from err

    log_update(db, procedure, old_values, user_id)
    db.commit()
    db.refresh(procedure)

    return ProcedureResponse.model_validate(procedure)


@router.delete("/{procedure_id}", status_code=204)
def delete_procedure(
    procedure_id: int,
    db: DbSession,
    user_id: CurrentUserId,
) -> None:
    """Soft delete a procedure."""
    procedure = (
        db.query(MasterProcedure)
        .filter(MasterProcedure.id == procedure_id, MasterProcedure.deleted_at.is_(None))
        .first()
    )
    if not procedure:
        raise HTTPException(status_code=404, detail="Procedure not found")

    open_executions = (
        db.query(ProcedureInstance)
        .filter(
            ProcedureInstance.procedure_id == procedure_id,
            ProcedureInstance.status.in_([InstanceStatus.CUT.value, InstanceStatus.IN_WORK.value]),
        )
        .count()
    )
    if open_executions:
        raise HTTPException(
            status_code=409,
            detail=f"{open_executions} execution(s) are still open against this template",
        )

    procedure.deleted_at = datetime.now(UTC)
    log_delete(db, procedure, user_id)
    db.commit()


# ============ Steps ============


def _calculate_step_number(
    db: DbSession, procedure_id: int, parent_step_id: int | None, is_contingency: bool
) -> str:
    """Calculate the next step number based on hierarchy and contingency status."""
    if parent_step_id:
        # Sub-step: get parent's step_number and add sub-number
        parent = db.query(ProcedureStep).filter(ProcedureStep.id == parent_step_id).first()
        if not parent:
            raise HTTPException(status_code=404, detail="Parent step not found")

        # Count existing sub-steps under this parent
        sub_count = (
            db.query(func.count(ProcedureStep.id))
            .filter(ProcedureStep.parent_step_id == parent_step_id)
            .scalar()
        )
        return f"{parent.step_number}.{sub_count + 1}"
    else:
        # Top-level op
        if is_contingency:
            # Count existing contingency ops (C1, C2, C3...)
            contingency_count = (
                db.query(func.count(ProcedureStep.id))
                .filter(
                    ProcedureStep.procedure_id == procedure_id,
                    ProcedureStep.parent_step_id.is_(None),
                    ProcedureStep.is_contingency.is_(True),
                )
                .scalar()
            )
            return f"C{contingency_count + 1}"
        else:
            # Count existing normal ops (1, 2, 3...)
            normal_count = (
                db.query(func.count(ProcedureStep.id))
                .filter(
                    ProcedureStep.procedure_id == procedure_id,
                    ProcedureStep.parent_step_id.is_(None),
                    ProcedureStep.is_contingency.is_(False),
                )
                .scalar()
            )
            return str(normal_count + 1)


def _check_workcenter(db: DbSession, workcenter_id: int | None) -> None:
    if workcenter_id is None:
        return
    if not db.get(Workcenter, workcenter_id):
        raise HTTPException(status_code=404, detail="Workcenter not found")


def _procedure_steps(db: DbSession, procedure_id: int) -> list[ProcedureStep]:
    return db.query(ProcedureStep).filter(ProcedureStep.procedure_id == procedure_id).all()


def _insert_after(
    db: DbSession,
    procedure_id: int,
    step: ProcedureStep,
    after: ProcedureStep,
    parent_step_id: int | None,
) -> None:
    """Place a freshly added step right after ``after`` and renumber."""
    steps = _procedure_steps(db, procedure_id)
    others = [s for s in steps if s.id != step.id]
    if after.parent_step_id is not None:
        # After a sub-step: same OP, next position.
        parent_id: int | None = after.parent_step_id
        siblings = tree.children_map(others).get(parent_id, [])
        index = next(i for i, s in enumerate(siblings) if s.id == after.id) + 1
        tree.place(steps, step, parent_id, index)
    elif parent_step_id == after.id:
        # After an OP, inside it: its first sub-step.
        tree.place(steps, step, after.id, 0)
    else:
        # After an OP, beside it: the next OP of the same group.
        group = [
            s
            for s in tree.children_map(others).get(None, [])
            if s.is_contingency == after.is_contingency
        ]
        index = next(i for i, s in enumerate(group) if s.id == after.id) + 1
        tree.place(steps, step, None, index, after.is_contingency)
    db.flush()


@router.post("/{procedure_id}/steps", response_model=StepSchema, status_code=201)
def add_step(
    procedure_id: int,
    data: StepCreate,
    db: DbSession,
    user_id: CurrentUserId,
) -> StepSchema:
    """Add a step to a procedure.

    - Without parent_step_id: creates a top-level OP
    - With parent_step_id: creates a sub-step under that OP
    - Contingency ops are numbered C1, C2, C3 (separate from normal ops)
    """
    procedure = (
        db.query(MasterProcedure)
        .filter(MasterProcedure.id == procedure_id, MasterProcedure.deleted_at.is_(None))
        .first()
    )
    if not procedure:
        raise HTTPException(status_code=404, detail="Procedure not found")

    # Validate parent_step_id if provided
    if data.parent_step_id:
        parent = (
            db.query(ProcedureStep)
            .filter(
                ProcedureStep.id == data.parent_step_id,
                ProcedureStep.procedure_id == procedure_id,
            )
            .first()
        )
        if not parent:
            raise HTTPException(status_code=404, detail="Parent step not found")
        # Sub-steps inherit contingency status from parent
        is_contingency = parent.is_contingency
        level = 1
    else:
        is_contingency = data.is_contingency
        level = 0

    _check_workcenter(db, data.workcenter_id)
    after: ProcedureStep | None = None
    if data.after_step_id is not None:
        after = (
            db.query(ProcedureStep)
            .filter(
                ProcedureStep.id == data.after_step_id,
                ProcedureStep.procedure_id == procedure_id,
            )
            .first()
        )
        if not after:
            raise HTTPException(status_code=404, detail="Step to insert after not found")

    # Calculate step number
    step_number = _calculate_step_number(db, procedure_id, data.parent_step_id, is_contingency)

    # Get next order number (global across all steps in procedure)
    max_order = (
        db.query(func.max(ProcedureStep.order))
        .filter(ProcedureStep.procedure_id == procedure_id)
        .scalar()
    )
    next_order = (max_order or 0) + 1

    try:
        required_role = canonical_role_name(db, data.required_role)
    except UnknownRoleError as err:
        raise HTTPException(status_code=400, detail=str(err)) from err

    step = ProcedureStep(
        procedure_id=procedure_id,
        parent_step_id=data.parent_step_id,
        order=next_order,
        step_number=step_number,
        level=level,
        title=data.title,
        instructions=data.instructions,
        required_data_schema=data.required_data_schema,
        is_contingency=is_contingency,
        requires_signoff=data.requires_signoff,
        estimated_duration_minutes=data.estimated_duration_minutes,
        required_role=required_role,
        callouts=normalize_callouts(data.callouts),
        strict_sequence=data.strict_sequence,
        workcenter_id=data.workcenter_id,
    )
    if data.signoffs is not None:
        try:
            write_signoff_fields(
                step, False, signoffs=[s.model_dump() for s in data.signoffs], db=db
            )
        except UnknownSignoffRole as err:
            raise HTTPException(status_code=400, detail=str(err)) from err
        except SignoffError as err:
            raise HTTPException(status_code=422, detail=str(err)) from err
    db.add(step)
    db.flush()

    if after is not None:
        _insert_after(db, procedure_id, step, after, data.parent_step_id)
    else:
        # Append at the end of its siblings; keeps `order` in document order.
        tree.place(
            _procedure_steps(db, procedure_id),
            step,
            data.parent_step_id,
            10**6,
            is_contingency,
        )
        db.flush()

    log_create(db, step, user_id)
    db.commit()
    db.refresh(step)

    return StepSchema.model_validate(step)


@router.patch("/{procedure_id}/steps/{step_id}", response_model=StepSchema)
def update_step(
    procedure_id: int,
    step_id: int,
    data: StepUpdate,
    db: DbSession,
    user_id: CurrentUserId,
) -> StepSchema:
    """Update a step."""
    _require_live_procedure(db, procedure_id)
    step = (
        db.query(ProcedureStep)
        .filter(ProcedureStep.id == step_id, ProcedureStep.procedure_id == procedure_id)
        .first()
    )
    if not step:
        raise HTTPException(status_code=404, detail="Step not found")

    old_values = get_model_dict(step)
    regroup = False

    if data.title is not None:
        step.title = data.title
    # Explicit null clears these: an author must be able to empty a field
    if "instructions" in data.model_fields_set:
        step.instructions = data.instructions
    if "required_data_schema" in data.model_fields_set:
        step.required_data_schema = data.required_data_schema
    if "estimated_duration_minutes" in data.model_fields_set:
        step.estimated_duration_minutes = data.estimated_duration_minutes
    if "workcenter_id" in data.model_fields_set:
        _check_workcenter(db, data.workcenter_id)
        step.workcenter_id = data.workcenter_id
    if data.is_contingency is not None and data.is_contingency != step.is_contingency:
        if step.parent_step_id is not None:
            raise HTTPException(
                status_code=400, detail="A sub-step follows its OP; set contingency on the OP"
            )
        step.is_contingency = data.is_contingency
        regroup = True
    # Sign-offs: an explicit list wins and derives the legacy fields; legacy-only
    # writes still work and are carried into an existing explicit list.
    try:
        write_signoff_fields(
            step,
            bool(step.sub_steps),
            signoffs=(None if data.signoffs is None else [s.model_dump() for s in data.signoffs])
            if "signoffs" in data.model_fields_set
            else UNSET,
            requires_signoff=data.requires_signoff if data.requires_signoff is not None else UNSET,
            # Explicit null clears the role: a stale callout must be removable
            required_role=data.required_role if "required_role" in data.model_fields_set else UNSET,
            db=db,
        )
    except UnknownSignoffRole as err:
        raise HTTPException(status_code=400, detail=str(err)) from err
    except SignoffError as err:
        raise HTTPException(status_code=422, detail=str(err)) from err
    if "callouts" in data.model_fields_set:
        step.callouts = normalize_callouts(data.callouts)
    if data.strict_sequence is not None:
        step.strict_sequence = data.strict_sequence

    if regroup:
        # Toggling contingency moves the OP between numbering groups (1, 2 / C1, C2).
        all_steps = db.query(ProcedureStep).filter(ProcedureStep.procedure_id == procedure_id).all()
        tree.normalize(all_steps)

    log_update(db, step, old_values, user_id)
    db.commit()
    db.refresh(step)

    return StepSchema.model_validate(step)


@router.delete("/{procedure_id}/steps/{step_id}", status_code=204)
def delete_step(
    procedure_id: int,
    step_id: int,
    db: DbSession,
    user_id: CurrentUserId,
) -> None:
    """Delete a step."""
    _require_live_procedure(db, procedure_id)
    step = (
        db.query(ProcedureStep)
        .filter(ProcedureStep.id == step_id, ProcedureStep.procedure_id == procedure_id)
        .first()
    )
    if not step:
        raise HTTPException(status_code=404, detail="Step not found")

    log_delete(db, step, user_id)
    db.delete(step)
    db.flush()

    # Numbering and order close up over the gap (sub-steps went with their OP).
    tree.normalize(_procedure_steps(db, procedure_id))

    db.commit()


@router.post(
    "/{procedure_id}/steps/{step_id}/duplicate", response_model=StepSchema, status_code=201
)
def duplicate_step(
    procedure_id: int,
    step_id: int,
    db: DbSession,
    user_id: CurrentUserId,
) -> StepSchema:
    """Copy a step (an OP takes its sub-steps along) to right after the original.

    Kit lines and images are copied too; images share the same attachment files.
    Op-level dependencies are not copied: a copy starts unconstrained.
    """
    source = _get_procedure_step(db, procedure_id, step_id)

    def clone(src: ProcedureStep, parent_id: int | None) -> ProcedureStep:
        dup = ProcedureStep(
            procedure_id=procedure_id,
            parent_step_id=parent_id,
            order=src.order,
            step_number=src.step_number,
            level=src.level,
            title=src.title,
            instructions=src.instructions,
            required_data_schema=copy.deepcopy(src.required_data_schema),
            is_contingency=src.is_contingency,
            requires_signoff=src.requires_signoff,
            signoffs=copy.deepcopy(src.signoffs),
            estimated_duration_minutes=src.estimated_duration_minutes,
            required_role=src.required_role,
            callouts=copy.deepcopy(src.callouts),
            strict_sequence=src.strict_sequence,
            workcenter_id=src.workcenter_id,
        )
        db.add(dup)
        db.flush()
        log_create(db, dup, user_id)
        for sk in src.step_kits:
            kit = StepKit(
                step_id=dup.id,
                part_id=sk.part_id,
                quantity_required=sk.quantity_required,
                usage_type=sk.usage_type,
                notes=sk.notes,
            )
            db.add(kit)
            db.flush()
            log_create(db, kit, user_id)
        for img in src.images:
            link = StepImage(
                step_id=dup.id,
                attachment_id=img.attachment_id,
                caption=img.caption,
                position=img.position,
            )
            db.add(link)
            db.flush()
            log_create(db, link, user_id)
        return dup

    dup = clone(source, source.parent_step_id)
    if source.parent_step_id is None:
        for sub in sorted(source.sub_steps, key=lambda s: (s.order, s.id)):
            clone(sub, dup.id)
    db.flush()

    steps = _procedure_steps(db, procedure_id)
    siblings = tree.children_map([s for s in steps if s.id != dup.id]).get(
        source.parent_step_id, []
    )
    if source.parent_step_id is None:
        siblings = [s for s in siblings if s.is_contingency == source.is_contingency]
    index = next(i for i, s in enumerate(siblings) if s.id == source.id) + 1
    tree.place(steps, dup, source.parent_step_id, index, source.is_contingency)
    db.commit()
    db.refresh(dup)
    return StepSchema.model_validate(dup)


@router.post("/{procedure_id}/steps/{step_id}/move", response_model=StepSchema)
def move_step(
    procedure_id: int,
    step_id: int,
    data: StepMove,
    db: DbSession,
    user_id: CurrentUserId,
) -> StepSchema:
    """Move a step to ``index`` among the children of ``parent_step_id`` (null = top level).

    An OP that holds sub-steps stays top-level. Moving an OP under another OP
    drops its op-level dependencies and those pointing at it. An OP changes
    between the normal and contingency groups through ``is_contingency``.
    """
    step = _get_procedure_step(db, procedure_id, step_id)
    steps = _procedure_steps(db, procedure_id)

    if data.parent_step_id is not None:
        parent = next((s for s in steps if s.id == data.parent_step_id), None)
        if parent is None:
            raise HTTPException(status_code=404, detail="Parent step not found")
        if parent.parent_step_id is not None:
            raise HTTPException(status_code=400, detail="Sub-steps cannot hold sub-steps")
        if parent.id == step.id:
            raise HTTPException(status_code=400, detail="A step cannot move into itself")
        if any(s.parent_step_id == step.id for s in steps):
            raise HTTPException(status_code=400, detail="An OP with sub-steps stays top-level")

    old_values = get_model_dict(step)
    if step.parent_step_id is None and data.parent_step_id is not None:
        for dep in (
            db.query(StepDependency)
            .filter(
                (StepDependency.step_id == step.id) | (StepDependency.depends_on_step_id == step.id)
            )
            .all()
        ):
            log_delete(db, dep, user_id)
            db.delete(dep)
        step.strict_sequence = False
    contingency = step.is_contingency if data.is_contingency is None else data.is_contingency
    tree.place(steps, step, data.parent_step_id, data.index, contingency)
    log_update(db, step, old_values, user_id)
    db.commit()
    db.refresh(step)
    return StepSchema.model_validate(step)


# ============ Draft (authoring view) ============


class DraftKitLine(BaseModel):
    """A step kit line with the part identity an author needs."""

    id: int
    part_id: int
    part_name: str
    part_internal_pn: str | None = None
    quantity_required: float
    usage_type: str
    notes: str | None = None


class DraftImage(BaseModel):
    """A step reference image."""

    id: int
    attachment_id: int
    caption: str | None = None
    position: int


class DraftStep(BaseModel):
    """One step of the draft, flat, with everything the editor shows."""

    id: int
    order: int
    step_number: str
    level: int
    parent_step_id: int | None = None
    title: str
    instructions: str | None = None
    required_data_schema: dict[str, Any] | None = None
    is_contingency: bool = False
    requires_signoff: bool = False
    signoffs: list[SignoffDef] = []  # the effective list
    estimated_duration_minutes: int | None = None
    required_role: str | None = None
    callouts: Annotated[list[Callout], BeforeValidator(lambda v: [] if v is None else v)] = []
    strict_sequence: bool = False
    workcenter_id: int | None = None
    depends_on: list[int] = []
    images: list[DraftImage] = []
    step_kit: list[DraftKitLine] = []


class DraftResponse(BaseModel):
    """The whole draft in document order, in one request."""

    procedure_id: int
    steps: list[DraftStep]


@router.get("/{procedure_id}/draft", response_model=DraftResponse)
def get_draft(procedure_id: int, db: DbSession) -> DraftResponse:
    """The procedure's steps in document order with images, kit lines and
    op dependencies, for the template editor. Bulk-loaded: a handful of queries."""
    _require_live_procedure(db, procedure_id)
    steps = tree.document_order(_procedure_steps(db, procedure_id))
    ids = [s.id for s in steps]
    parent_ids = {s.parent_step_id for s in steps if s.parent_step_id is not None}

    images: dict[int, list[StepImage]] = {}
    kits: dict[int, list[StepKit]] = {}
    deps: dict[int, list[int]] = {}
    if ids:
        for img in (
            db.query(StepImage)
            .filter(StepImage.step_id.in_(ids))
            .order_by(StepImage.position, StepImage.id)
            .all()
        ):
            images.setdefault(img.step_id, []).append(img)
        for sk in db.query(StepKit).filter(StepKit.step_id.in_(ids)).order_by(StepKit.id).all():
            kits.setdefault(sk.step_id, []).append(sk)
        for d in db.query(StepDependency).filter(StepDependency.step_id.in_(ids)).all():
            deps.setdefault(d.step_id, []).append(d.depends_on_step_id)

    return DraftResponse(
        procedure_id=procedure_id,
        steps=[
            DraftStep(
                id=s.id,
                order=s.order,
                step_number=s.step_number,
                level=s.level,
                parent_step_id=s.parent_step_id,
                title=s.title,
                instructions=s.instructions,
                required_data_schema=s.required_data_schema,
                is_contingency=s.is_contingency,
                requires_signoff=s.requires_signoff,
                signoffs=effective_for(s, s.id in parent_ids),
                estimated_duration_minutes=s.estimated_duration_minutes,
                required_role=s.required_role,
                callouts=step_callouts({"callouts": s.callouts}),
                strict_sequence=s.strict_sequence,
                workcenter_id=s.workcenter_id,
                depends_on=sorted(deps.get(s.id, [])),
                images=[
                    DraftImage(
                        id=i.id,
                        attachment_id=i.attachment_id,
                        caption=i.caption,
                        position=i.position,
                    )
                    for i in images.get(s.id, [])
                ],
                step_kit=[
                    DraftKitLine(
                        id=k.id,
                        part_id=k.part_id,
                        part_name=k.part.name,
                        part_internal_pn=k.part.internal_pn,
                        quantity_required=float(k.quantity_required),
                        usage_type=_enum_value(k.usage_type),
                        notes=k.notes,
                    )
                    for k in kits.get(s.id, [])
                ],
            )
            for s in steps
        ],
    )


# ============ Step images (authored reference imagery) ============


class StepImageResponse(BaseModel):
    """Authored step image."""

    id: int
    step_id: int
    attachment_id: int
    caption: str | None = None
    position: int

    model_config = {"from_attributes": True}


class StepImageUpdate(BaseModel):
    """Update a step image's caption."""

    caption: str | None = None


def _require_live_procedure(db: DbSession, procedure_id: int) -> None:
    """Reject operations whose parent procedure is soft-deleted (or absent).

    Child lookups (steps, kits, outputs) filter only on procedure_id, so
    without this guard a soft-deleted procedure's children stay readable and
    mutable — the top-level procedure routes filter deleted_at, the leaf
    handlers historically did not.
    """
    live = (
        db.query(MasterProcedure.id)
        .filter(MasterProcedure.id == procedure_id, MasterProcedure.deleted_at.is_(None))
        .first()
    )
    if not live:
        raise HTTPException(status_code=404, detail="Procedure not found")


def _get_procedure_step(db: DbSession, procedure_id: int, step_id: int) -> ProcedureStep:
    _require_live_procedure(db, procedure_id)
    step = (
        db.query(ProcedureStep)
        .filter(ProcedureStep.id == step_id, ProcedureStep.procedure_id == procedure_id)
        .first()
    )
    if not step:
        raise HTTPException(status_code=404, detail="Step not found")
    return step


@router.get("/{procedure_id}/steps/{step_id}/images", response_model=list[StepImageResponse])
def list_step_images(
    procedure_id: int,
    step_id: int,
    db: DbSession,
) -> list[StepImageResponse]:
    """List a step's authored reference images, in display order."""
    step = _get_procedure_step(db, procedure_id, step_id)
    return [StepImageResponse.model_validate(img) for img in step.images]


@router.post(
    "/{procedure_id}/steps/{step_id}/images",
    response_model=StepImageResponse,
    status_code=201,
)
async def add_step_image(
    procedure_id: int,
    step_id: int,
    db: DbSession,
    user_id: CurrentUserId,
    file: UploadFile,
    caption: str | None = Form(default=None),
) -> StepImageResponse:
    """Attach an authored reference image to a step.

    Stored as an attachment (kind='step_image', procedure scope) plus a
    StepImage link carrying caption and position. Published versions
    snapshot the attachment id — the file outlives the link.
    """
    step = _get_procedure_step(db, procedure_id, step_id)

    if not (file.content_type or "").startswith("image/"):
        raise HTTPException(status_code=400, detail="Step images must be image files")

    from opal.api.routes.attachments import store_attachment

    attachment = await store_attachment(
        db, user_id, file, procedure_id=procedure_id, kind="step_image"
    )

    max_position = (
        db.query(func.max(StepImage.position)).filter(StepImage.step_id == step.id).scalar()
    )
    image = StepImage(
        step_id=step.id,
        attachment_id=attachment.id,
        caption=caption,
        position=(max_position if max_position is not None else -1) + 1,
    )
    db.add(image)
    db.flush()
    log_create(db, image, user_id)
    db.commit()
    db.refresh(image)
    return StepImageResponse.model_validate(image)


@router.patch(
    "/{procedure_id}/steps/{step_id}/images/{image_id}",
    response_model=StepImageResponse,
)
def update_step_image(
    procedure_id: int,
    step_id: int,
    image_id: int,
    data: StepImageUpdate,
    db: DbSession,
    user_id: CurrentUserId,
) -> StepImageResponse:
    """Update a step image's caption."""
    _get_procedure_step(db, procedure_id, step_id)
    image = (
        db.query(StepImage).filter(StepImage.id == image_id, StepImage.step_id == step_id).first()
    )
    if not image:
        raise HTTPException(status_code=404, detail="Step image not found")

    old_values = get_model_dict(image)
    if "caption" in data.model_fields_set:
        image.caption = data.caption
    log_update(db, image, old_values, user_id)
    db.commit()
    db.refresh(image)
    return StepImageResponse.model_validate(image)


@router.delete("/{procedure_id}/steps/{step_id}/images/{image_id}", status_code=204)
def delete_step_image(
    procedure_id: int,
    step_id: int,
    image_id: int,
    db: DbSession,
    user_id: CurrentUserId,
) -> None:
    """Unlink an authored image from the step.

    The attachment row and file persist — published versions reference the
    attachment id and must keep resolving.
    """
    _get_procedure_step(db, procedure_id, step_id)
    image = (
        db.query(StepImage).filter(StepImage.id == image_id, StepImage.step_id == step_id).first()
    )
    if not image:
        raise HTTPException(status_code=404, detail="Step image not found")

    log_delete(db, image, user_id)
    db.delete(image)
    db.commit()


class StepImageReorder(BaseModel):
    """Image ids in their new display order."""

    image_ids: list[int]


@router.post(
    "/{procedure_id}/steps/{step_id}/images/reorder", response_model=list[StepImageResponse]
)
def reorder_step_images(
    procedure_id: int,
    step_id: int,
    data: StepImageReorder,
    db: DbSession,
    user_id: CurrentUserId,
) -> list[StepImageResponse]:
    """Set the display order of a step's reference images."""
    step = _get_procedure_step(db, procedure_id, step_id)
    images = {img.id: img for img in step.images}
    if set(data.image_ids) != set(images) or len(data.image_ids) != len(images):
        raise HTTPException(status_code=400, detail="Image ids don't match the step's images")
    for position, image_id in enumerate(data.image_ids):
        img = images[image_id]
        if img.position != position:
            old_values = get_model_dict(img)
            img.position = position
            log_update(db, img, old_values, user_id)
    db.commit()
    db.refresh(step)
    return [StepImageResponse.model_validate(img) for img in step.images]


def _renumber_procedure_steps(steps: list[ProcedureStep]) -> None:
    """Recompute every step.step_number for a procedure based on the current
    `order` values. Normal top-level ops → "1", "2", ...; contingency top-level
    ops → "C1", "C2", ...; sub-steps → "<parent_step_number>.<sub_index>".
    Mutates the steps in place; caller is responsible for committing."""
    top_level = sorted([s for s in steps if s.parent_step_id is None], key=lambda s: s.order)
    normal_idx = 0
    contingency_idx = 0
    for op in top_level:
        if op.is_contingency:
            contingency_idx += 1
            op.step_number = f"C{contingency_idx}"
        else:
            normal_idx += 1
            op.step_number = str(normal_idx)
    # Sub-steps inherit their parent's new prefix.
    children_by_parent: dict[int, list[ProcedureStep]] = {}
    for s in steps:
        if s.parent_step_id is not None:
            children_by_parent.setdefault(s.parent_step_id, []).append(s)
    for parent_id, kids in children_by_parent.items():
        parent = next((s for s in steps if s.id == parent_id), None)
        if parent is None:
            continue
        kids.sort(key=lambda s: s.order)
        for i, kid in enumerate(kids, start=1):
            kid.step_number = f"{parent.step_number}.{i}"


@router.post("/{procedure_id}/steps/reorder", response_model=list[StepSchema])
def reorder_steps(
    procedure_id: int,
    data: StepReorder,
    db: DbSession,
    user_id: CurrentUserId,
) -> list[StepSchema]:
    """Reorder steps."""
    procedure = (
        db.query(MasterProcedure)
        .filter(MasterProcedure.id == procedure_id, MasterProcedure.deleted_at.is_(None))
        .first()
    )
    if not procedure:
        raise HTTPException(status_code=404, detail="Procedure not found")

    # Verify all step IDs belong to this procedure
    steps = db.query(ProcedureStep).filter(ProcedureStep.procedure_id == procedure_id).all()
    step_map = {s.id: s for s in steps}

    if set(data.step_ids) != set(step_map.keys()):
        raise HTTPException(status_code=400, detail="Step IDs don't match procedure steps")

    # Update order
    for i, step_id in enumerate(data.step_ids, start=1):
        step_map[step_id].order = i

    # Renumber step_number labels to follow the new order.
    _renumber_procedure_steps(steps)

    db.commit()

    # Return updated steps in order
    steps = (
        db.query(ProcedureStep)
        .filter(ProcedureStep.procedure_id == procedure_id)
        .order_by(ProcedureStep.order)
        .all()
    )
    return [StepSchema.model_validate(s) for s in steps]


# ============ Operation dependencies ============


class StepDependencyPayload(BaseModel):
    """Replace a step's full prerequisite list (step.ids of other ops)."""

    depends_on: list[int] = Field(default_factory=list)


@router.get("/{procedure_id}/dependencies")
def list_dependencies(procedure_id: int, db: DbSession) -> list[dict]:
    """Return all op-level dependency edges for a procedure as
    [{step_id, depends_on_step_id}, ...]."""
    procedure = (
        db.query(MasterProcedure)
        .filter(MasterProcedure.id == procedure_id, MasterProcedure.deleted_at.is_(None))
        .first()
    )
    if not procedure:
        raise HTTPException(status_code=404, detail="Procedure not found")

    rows = (
        db.query(StepDependency)
        .join(ProcedureStep, StepDependency.step_id == ProcedureStep.id)
        .filter(ProcedureStep.procedure_id == procedure_id)
        .all()
    )
    return [{"step_id": d.step_id, "depends_on_step_id": d.depends_on_step_id} for d in rows]


@router.put("/{procedure_id}/steps/{step_id}/dependencies")
def set_step_dependencies(
    procedure_id: int,
    step_id: int,
    data: StepDependencyPayload,
    db: DbSession,
    user_id: CurrentUserId,
) -> dict:
    """Replace the prerequisite set for an operation atomically. Validates
    same-procedure scope, op-level only, no self-loops, no cycles."""
    procedure = (
        db.query(MasterProcedure)
        .filter(MasterProcedure.id == procedure_id, MasterProcedure.deleted_at.is_(None))
        .first()
    )
    if not procedure:
        raise HTTPException(status_code=404, detail="Procedure not found")

    target = (
        db.query(ProcedureStep)
        .filter(ProcedureStep.id == step_id, ProcedureStep.procedure_id == procedure_id)
        .first()
    )
    if not target:
        raise HTTPException(status_code=404, detail="Step not found")
    if target.parent_step_id is not None:
        raise HTTPException(
            status_code=400, detail="Dependencies are only allowed on top-level operations"
        )

    requested = list(dict.fromkeys(data.depends_on))  # dedupe, preserve order
    if step_id in requested:
        raise HTTPException(status_code=400, detail="A step cannot depend on itself")

    if requested:
        prereqs = db.query(ProcedureStep).filter(ProcedureStep.id.in_(requested)).all()
        prereq_map = {p.id: p for p in prereqs}
        for pid in requested:
            p = prereq_map.get(pid)
            if p is None or p.procedure_id != procedure_id:
                raise HTTPException(status_code=400, detail=f"Step {pid} is not in this procedure")
            if p.parent_step_id is not None:
                raise HTTPException(
                    status_code=400,
                    detail=f"Step {pid} is a sub-step; only operations can be prerequisites",
                )

    # Cycle check: simulate the new edge set, then DFS from target reaching itself.
    # Existing edges (excluding outgoing-from-step_id which we're replacing).
    existing = db.query(StepDependency).all()
    # In the dependency graph, an edge A->B means "B depends on A".
    # We model it as adjacency from prereq -> dependent so we walk reachability forward.
    adj: dict[int, set[int]] = {}
    for d in existing:
        if d.step_id == step_id:
            continue
        adj.setdefault(d.depends_on_step_id, set()).add(d.step_id)
    for pid in requested:
        adj.setdefault(pid, set()).add(step_id)

    # If we can reach any prereq from step_id, a cycle exists.
    def reachable_from(start: int) -> set[int]:
        seen = {start}
        stack = [start]
        while stack:
            cur = stack.pop()
            for nxt in adj.get(cur, ()):
                if nxt not in seen:
                    seen.add(nxt)
                    stack.append(nxt)
        return seen

    downstream = reachable_from(step_id)
    cycle_prereqs = downstream & set(requested)
    if cycle_prereqs:
        raise HTTPException(
            status_code=400,
            detail=f"Cycle: step {step_id} already gates {sorted(cycle_prereqs)}; "
            "cannot depend on them.",
        )

    # Apply: delete current deps for step_id, insert new ones, audit log each.
    current = db.query(StepDependency).filter(StepDependency.step_id == step_id).all()
    for d in current:
        log_delete(db, d, user_id)
        db.delete(d)
    db.flush()
    for pid in requested:
        new_dep = StepDependency(step_id=step_id, depends_on_step_id=pid)
        db.add(new_dep)
        db.flush()
        log_create(db, new_dep, user_id)
    db.commit()
    return {"step_id": step_id, "depends_on": requested}


# ============ Versions ============


def _build_snapshot(
    db: DbSession, procedure: MasterProcedure, steps: list[ProcedureStep]
) -> dict[str, Any]:
    """The immutable content a publish would freeze, built from the live draft."""
    steps = sorted(steps, key=lambda s: s.order)
    # Bulk-load step kit items for all steps in this procedure
    step_ids = [s.id for s in steps]
    parent_ids = {s.parent_step_id for s in steps if s.parent_step_id is not None}
    all_step_kits = db.query(StepKit).filter(StepKit.step_id.in_(step_ids)).all()
    step_kit_map: dict[int, list[StepKit]] = {}
    for sk in all_step_kits:
        step_kit_map.setdefault(sk.step_id, []).append(sk)

    # Bulk-load step dependencies; emit deps as a list of prerequisite `order`
    # values per step so the execution engine can resolve them against the
    # frozen snapshot without joining tables.
    all_deps = db.query(StepDependency).filter(StepDependency.step_id.in_(step_ids)).all()
    step_id_to_order = {s.id: s.order for s in steps}
    depends_on_map: dict[int, list[int]] = {}
    for d in all_deps:
        prereq_order = step_id_to_order.get(d.depends_on_step_id)
        if prereq_order is not None:
            depends_on_map.setdefault(d.step_id, []).append(prereq_order)

    # Bulk-load authored step images; snapshotted by attachment id (files are
    # immutable on disk and StepImage deletion only unlinks).
    all_images = (
        db.query(StepImage)
        .filter(StepImage.step_id.in_(step_ids))
        .order_by(StepImage.position)
        .all()
    )
    images_map: dict[int, list[StepImage]] = {}
    for img in all_images:
        images_map.setdefault(img.step_id, []).append(img)

    # Create snapshot with hierarchical structure
    def step_to_dict(step: ProcedureStep) -> dict:
        return {
            "id": step.id,
            "order": step.order,
            "step_number": step.step_number,
            "level": step.level,
            "parent_step_id": step.parent_step_id,
            "title": step.title,
            "instructions": step.instructions,
            "required_data_schema": step.required_data_schema,
            "is_contingency": step.is_contingency,
            "requires_signoff": step.requires_signoff,
            "signoffs": effective_for(step, step.id in parent_ids),
            "estimated_duration_minutes": step.estimated_duration_minutes,
            "required_role": step.required_role,
            "callouts": normalize_callouts(step.callouts),
            "strict_sequence": step.strict_sequence,
            "workcenter_id": step.workcenter_id,
            "depends_on": sorted(depends_on_map.get(step.id, [])),
            "images": [
                {"attachment_id": img.attachment_id, "caption": img.caption}
                for img in images_map.get(step.id, [])
            ],
            "step_kit": [
                {
                    "part_id": sk.part_id,
                    "part_name": sk.part.name,
                    "quantity_required": float(sk.quantity_required),
                    "usage_type": sk.usage_type.value
                    if hasattr(sk.usage_type, "value")
                    else sk.usage_type,
                    "notes": sk.notes,
                }
                for sk in step_kit_map.get(step.id, [])
            ],
        }

    # Snapshot kit and output items alongside steps
    kit_items = db.query(Kit).filter(Kit.procedure_id == procedure.id).all()
    output_items = (
        db.query(ProcedureOutput).filter(ProcedureOutput.procedure_id == procedure.id).all()
    )

    content = {
        "procedure_name": procedure.name,
        "procedure_description": procedure.description,
        "steps": [step_to_dict(s) for s in steps],
        "kit_items": [
            {"part_id": k.part_id, "quantity_required": float(k.quantity_required)}
            for k in kit_items
        ],
        "output_items": [
            {"part_id": o.part_id, "quantity_produced": float(o.quantity_produced)}
            for o in output_items
        ],
    }

    return content


@router.post("/{procedure_id}/publish", response_model=VersionResponse, status_code=201)
def publish_version(
    procedure_id: int,
    db: DbSession,
    user_id: CurrentUserId,
    data: PublishRequest | None = None,
) -> VersionResponse:
    """Publish current steps as a new immutable version."""
    procedure = (
        db.query(MasterProcedure)
        .filter(MasterProcedure.id == procedure_id, MasterProcedure.deleted_at.is_(None))
        .first()
    )
    if not procedure:
        raise HTTPException(status_code=404, detail="Procedure not found")

    # Get current steps
    steps = (
        db.query(ProcedureStep)
        .filter(ProcedureStep.procedure_id == procedure_id)
        .order_by(ProcedureStep.order)
        .all()
    )

    if not steps:
        raise HTTPException(status_code=400, detail="Cannot publish procedure with no steps")

    # Publish is the procedure's commitment moment — its kit and outputs
    # must not hold draft parts (authoring with drafts is legal; executing
    # isn't). Raises DraftPartsBlocked -> 409 with the draft list.
    publish_step_ids = [s.id for s in steps]
    referenced_parts = [
        k.part for k in db.query(Kit).filter(Kit.procedure_id == procedure_id).all()
    ]
    referenced_parts += [
        sk.part for sk in db.query(StepKit).filter(StepKit.step_id.in_(publish_step_ids)).all()
    ]
    referenced_parts += [
        o.part
        for o in db.query(ProcedureOutput).filter(ProcedureOutput.procedure_id == procedure_id)
    ]
    drafts = draft_parts_in(referenced_parts)
    if drafts:
        raise DraftPartsBlocked(f"publish of procedure {procedure_id}", drafts)

    # Get next version number
    max_version = (
        db.query(func.max(ProcedureVersion.version_number))
        .filter(ProcedureVersion.procedure_id == procedure_id)
        .scalar()
    )
    next_version = (max_version or 0) + 1

    content = _build_snapshot(db, procedure, steps)
    if data and data.change_note and data.change_note.strip():
        content["change_note"] = data.change_note.strip()

    version = ProcedureVersion(
        procedure_id=procedure_id,
        version_number=next_version,
        content=content,
        created_by_id=user_id,
    )
    db.add(version)
    db.flush()

    # Update procedure to point to this version and set to active
    procedure.current_version_id = version.id
    procedure.status = ProcedureStatus.ACTIVE

    log_create(db, version, user_id)
    db.commit()
    db.refresh(version)

    return _version_response(version)


def _version_response(v: ProcedureVersion) -> VersionResponse:
    return VersionResponse(
        id=v.id,
        version_number=v.version_number,
        created_at=v.created_at,
        created_by_id=v.created_by_id,
        created_by_name=v.created_by_user.name if v.created_by_user else None,
        change_note=v.content.get("change_note"),
        step_count=len(v.content.get("steps", [])),
    )


@router.get("/{procedure_id}/versions", response_model=list[VersionResponse])
def list_versions(
    procedure_id: int,
    db: DbSession,
) -> list[VersionResponse]:
    """List all published versions of a procedure."""
    procedure = (
        db.query(MasterProcedure)
        .filter(MasterProcedure.id == procedure_id, MasterProcedure.deleted_at.is_(None))
        .first()
    )
    if not procedure:
        raise HTTPException(status_code=404, detail="Procedure not found")

    versions = (
        db.query(ProcedureVersion)
        .filter(ProcedureVersion.procedure_id == procedure_id)
        .order_by(ProcedureVersion.version_number.desc())
        .all()
    )

    return [_version_response(v) for v in versions]


@router.get("/versions/{version_id}", response_model=VersionDetailResponse)
def get_version(
    version_id: int,
    db: DbSession,
) -> VersionDetailResponse:
    """Get specific version with full content."""
    version = db.query(ProcedureVersion).filter(ProcedureVersion.id == version_id).first()
    if not version:
        raise HTTPException(status_code=404, detail="Version not found")
    procedure = version.procedure

    part_ids = {
        i["part_id"]
        for key in ("kit_items", "output_items")
        for i in version.content.get(key, [])
        if "part_id" in i
    }
    part_ids |= {
        sk["part_id"]
        for s in version.content.get("steps", [])
        for sk in s.get("step_kit", [])
        if "part_id" in sk
    }
    parts = (
        db.query(Part).filter(Part.id.in_(part_ids)).order_by(Part.internal_pn).all()
        if part_ids
        else []
    )
    base = _version_response(version)
    steps = version.content.get("steps", [])
    parent_ids = {s.get("parent_step_id") for s in steps if s.get("parent_step_id") is not None}
    content = {
        **version.content,
        "steps": [
            {**s, "signoffs": effective_signoffs(s, s.get("id") in parent_ids)} for s in steps
        ],
    }
    return VersionDetailResponse(
        id=version.id,
        version_number=version.version_number,
        content=content,
        created_at=version.created_at,
        created_by_id=version.created_by_id,
        created_by_name=base.created_by_name,
        change_note=base.change_note,
        procedure_id=procedure.id,
        procedure_template_number=procedure.template_number,
        procedure_name=procedure.name,
        procedure_type=_enum_value(procedure.procedure_type),
        is_current=procedure.current_version_id == version.id,
        parts=[VersionPart(id=p.id, internal_pn=p.internal_pn, name=p.name) for p in parts],
    )


@router.get("/versions/{version_id}/qr")
def version_qr(version_id: int, db: DbSession, url: str = Query(..., max_length=2000)) -> Response:
    """QR code (SVG) for a traveler. The client passes the URL to encode: it is the one
    that knows which origin the shop floor reaches the app on."""
    import io

    import segno

    if not db.query(ProcedureVersion.id).filter(ProcedureVersion.id == version_id).first():
        raise HTTPException(status_code=404, detail="Version not found")
    buf = io.BytesIO()
    segno.make(url).save(buf, kind="svg", scale=3, border=1, xmldecl=False)
    return Response(content=buf.getvalue(), media_type="image/svg+xml")


class StepDiffSchema(BaseModel):
    status: str
    step_number: str
    title_a: str | None = None
    title_b: str | None = None
    changed_fields: list[str] = []
    # Old/new value for each changed field, keyed by field name.
    changes: dict[str, dict[str, Any]] = {}


class PartDiffSchema(BaseModel):
    part_id: int
    internal_pn: str | None = None
    name: str | None = None
    status: str
    quantity_a: float | None = None
    quantity_b: float | None = None


class VersionDiffResponse(BaseModel):
    procedure_id: int
    procedure_name: str
    version_a: VersionResponse
    version_b: VersionResponse
    procedure_changes: list[dict[str, Any]]
    steps: list[StepDiffSchema]
    kit: list[PartDiffSchema]
    outputs: list[PartDiffSchema]
    added: int
    removed: int
    modified: int
    unchanged: int


@router.get("/{procedure_id}/versions/{v1_id}/diff/{v2_id}", response_model=VersionDiffResponse)
def diff_versions(procedure_id: int, v1_id: int, v2_id: int, db: DbSession) -> VersionDiffResponse:
    """Step-, kit- and output-level diff between two published versions of a procedure."""
    procedure = (
        db.query(MasterProcedure)
        .filter(MasterProcedure.id == procedure_id, MasterProcedure.deleted_at.is_(None))
        .first()
    )
    if not procedure:
        raise HTTPException(status_code=404, detail="Procedure not found")
    versions = {
        v.id: v
        for v in db.query(ProcedureVersion)
        .filter(
            ProcedureVersion.procedure_id == procedure_id,
            ProcedureVersion.id.in_([v1_id, v2_id]),
        )
        .all()
    }
    va, vb = versions.get(v1_id), versions.get(v2_id)
    if not va or not vb:
        raise HTTPException(status_code=404, detail="Version not found for this procedure")

    proc_changes, step_diffs = diff_procedure_versions(va.content, vb.content)
    kit = diff_part_lists(va.content.get("kit_items", []), vb.content.get("kit_items", []))
    outs = diff_part_lists(
        va.content.get("output_items", []),
        vb.content.get("output_items", []),
        qty_key="quantity_produced",
    )
    part_ids = {d["part_id"] for d in kit + outs}
    part_map = (
        {p.id: p for p in db.query(Part).filter(Part.id.in_(part_ids)).all()} if part_ids else {}
    )

    def part_rows(rows: list[dict[str, Any]]) -> list[PartDiffSchema]:
        out = []
        for d in rows:
            part = part_map.get(d["part_id"])
            out.append(
                PartDiffSchema(
                    **d,
                    internal_pn=part.internal_pn if part else None,
                    name=part.name if part else None,
                )
            )
        return out

    steps_out = []
    for d in step_diffs:
        sa, sb = d.step_a, d.step_b
        steps_out.append(
            StepDiffSchema(
                status=d.status,
                step_number=(sa or sb)["step_number"],  # type: ignore[index]
                title_a=sa["title"] if sa else None,
                title_b=sb["title"] if sb else None,
                changed_fields=d.changed_fields,
                changes={
                    f: {"a": sa.get(f) if sa else None, "b": sb.get(f) if sb else None}
                    for f in d.changed_fields
                },
            )
        )
    counts = {
        k: sum(1 for d in step_diffs if d.status == k)
        for k in ("added", "removed", "modified", "unchanged")
    }
    return VersionDiffResponse(
        procedure_id=procedure.id,
        procedure_name=procedure.name,
        version_a=_version_response(va),
        version_b=_version_response(vb),
        procedure_changes=[
            {"field": f, "a": va.content.get(f), "b": vb.content.get(f)} for f in proc_changes
        ],
        steps=steps_out,
        kit=part_rows(kit),
        outputs=part_rows(outs),
        **counts,
    )


@router.post("/{procedure_id}/versions/{version_id}/restore", response_model=ProcedureResponse)
def restore_from_version(
    procedure_id: int,
    version_id: int,
    db: DbSession,
    user_id: CurrentUserId,
) -> ProcedureResponse:
    """Replace master steps, kit, and outputs with a published version's snapshot.

    Deletes all current ProcedureStep, Kit, and ProcedureOutput rows for this
    procedure and recreates them from the version's content snapshot.
    Does NOT change current_version_id or procedure status.
    """
    procedure = (
        db.query(MasterProcedure)
        .filter(MasterProcedure.id == procedure_id, MasterProcedure.deleted_at.is_(None))
        .first()
    )
    if not procedure:
        raise HTTPException(status_code=404, detail="Procedure not found")

    version = (
        db.query(ProcedureVersion)
        .filter(ProcedureVersion.id == version_id, ProcedureVersion.procedure_id == procedure_id)
        .first()
    )
    if not version:
        raise HTTPException(status_code=404, detail="Version not found for this procedure")

    # Delete all current steps, kit items, and outputs
    db.query(ProcedureStep).filter(ProcedureStep.procedure_id == procedure_id).delete()
    db.query(Kit).filter(Kit.procedure_id == procedure_id).delete()
    db.query(ProcedureOutput).filter(ProcedureOutput.procedure_id == procedure_id).delete()
    db.flush()

    # Recreate steps from version snapshot (two-pass for parent ID mapping)
    version_steps = version.content.get("steps", [])
    old_id_to_new_id: dict[int, int] = {}

    # First pass: create parent ops (no parent_step_id)
    for step_data in version_steps:
        if step_data.get("parent_step_id") is None:
            new_step = ProcedureStep(
                procedure_id=procedure_id,
                order=step_data["order"],
                step_number=step_data["step_number"],
                level=step_data["level"],
                title=step_data["title"],
                instructions=step_data.get("instructions"),
                required_data_schema=step_data.get("required_data_schema"),
                is_contingency=step_data.get("is_contingency", False),
                requires_signoff=step_data.get("requires_signoff", False),
                signoffs=copy.deepcopy(step_data.get("signoffs")),
                estimated_duration_minutes=step_data.get("estimated_duration_minutes"),
                required_role=step_data.get("required_role"),
                callouts=step_callouts(step_data) or None,
                strict_sequence=step_data.get("strict_sequence", False),
                workcenter_id=step_data.get("workcenter_id"),
            )
            db.add(new_step)
            db.flush()
            old_id_to_new_id[step_data["id"]] = new_step.id

    # Second pass: create child steps (with parent_step_id)
    for step_data in version_steps:
        if step_data.get("parent_step_id") is not None:
            new_parent_id = old_id_to_new_id.get(step_data["parent_step_id"])
            new_step = ProcedureStep(
                procedure_id=procedure_id,
                order=step_data["order"],
                step_number=step_data["step_number"],
                level=step_data["level"],
                parent_step_id=new_parent_id,
                title=step_data["title"],
                instructions=step_data.get("instructions"),
                required_data_schema=step_data.get("required_data_schema"),
                is_contingency=step_data.get("is_contingency", False),
                requires_signoff=step_data.get("requires_signoff", False),
                signoffs=copy.deepcopy(step_data.get("signoffs")),
                estimated_duration_minutes=step_data.get("estimated_duration_minutes"),
                required_role=step_data.get("required_role"),
                callouts=step_callouts(step_data) or None,
                strict_sequence=step_data.get("strict_sequence", False),
                workcenter_id=step_data.get("workcenter_id"),
            )
            db.add(new_step)
            db.flush()
            old_id_to_new_id[step_data["id"]] = new_step.id

    # Recreate kit items (graceful for old versions without kit data)
    for kit_data in version.content.get("kit_items", []):
        new_kit = Kit(
            procedure_id=procedure_id,
            part_id=kit_data["part_id"],
            quantity_required=Decimal(str(kit_data["quantity_required"])),
        )
        db.add(new_kit)

    # Recreate output items (graceful for old versions without output data)
    for output_data in version.content.get("output_items", []):
        new_output = ProcedureOutput(
            procedure_id=procedure_id,
            part_id=output_data["part_id"],
            quantity_produced=Decimal(str(output_data["quantity_produced"])),
        )
        db.add(new_output)

    db.commit()
    db.refresh(procedure)

    return ProcedureResponse.model_validate(procedure)


# ============ Kit ============


@router.get("/{procedure_id}/kit", response_model=list[KitItemResponse])
def get_kit(
    procedure_id: int,
    db: DbSession,
) -> list[KitItemResponse]:
    """Get kit (bill of materials) for a procedure."""
    procedure = (
        db.query(MasterProcedure)
        .filter(MasterProcedure.id == procedure_id, MasterProcedure.deleted_at.is_(None))
        .first()
    )
    if not procedure:
        raise HTTPException(status_code=404, detail="Procedure not found")

    kit_items = (
        db.query(Kit).join(Part).filter(Kit.procedure_id == procedure_id).order_by(Part.name).all()
    )

    on_hand = _on_hand(db, [k.part_id for k in kit_items])
    return [_kit_response(k, on_hand) for k in kit_items]


@router.post("/{procedure_id}/kit", response_model=KitItemResponse, status_code=201)
def add_kit_item(
    procedure_id: int,
    data: KitItemCreate,
    db: DbSession,
    user_id: CurrentUserId,
) -> KitItemResponse:
    """Add a part to the kit."""
    procedure = (
        db.query(MasterProcedure)
        .filter(MasterProcedure.id == procedure_id, MasterProcedure.deleted_at.is_(None))
        .first()
    )
    if not procedure:
        raise HTTPException(status_code=404, detail="Procedure not found")

    part = db.query(Part).filter(Part.id == data.part_id, Part.deleted_at.is_(None)).first()
    if not part:
        raise HTTPException(status_code=404, detail="Part not found")

    # Check if already in kit
    existing = (
        db.query(Kit).filter(Kit.procedure_id == procedure_id, Kit.part_id == data.part_id).first()
    )
    if existing:
        raise HTTPException(status_code=400, detail="Part already in kit")

    kit_item = Kit(
        procedure_id=procedure_id,
        part_id=data.part_id,
        quantity_required=Decimal(str(data.quantity_required)),
    )
    db.add(kit_item)
    db.flush()

    log_create(db, kit_item, user_id)
    db.commit()
    db.refresh(kit_item)

    return _kit_response(kit_item, _on_hand(db, [kit_item.part_id]))


@router.patch("/{procedure_id}/kit/{kit_id}", response_model=KitItemResponse)
def update_kit_item(
    procedure_id: int,
    kit_id: int,
    data: KitItemUpdate,
    db: DbSession,
    user_id: CurrentUserId,
) -> KitItemResponse:
    """Update kit item quantity."""
    kit_item = db.query(Kit).filter(Kit.id == kit_id, Kit.procedure_id == procedure_id).first()
    if not kit_item:
        raise HTTPException(status_code=404, detail="Kit item not found")

    with AuditContext(db, kit_item, user_id):
        kit_item.quantity_required = Decimal(str(data.quantity_required))

    db.commit()
    db.refresh(kit_item)

    return _kit_response(kit_item, _on_hand(db, [kit_item.part_id]))


@router.delete("/{procedure_id}/kit/{part_id}", status_code=204)
def remove_kit_item(
    procedure_id: int,
    part_id: int,
    db: DbSession,
    user_id: CurrentUserId,
) -> None:
    """Remove a part from the kit."""
    kit_item = (
        db.query(Kit).filter(Kit.procedure_id == procedure_id, Kit.part_id == part_id).first()
    )
    if not kit_item:
        raise HTTPException(status_code=404, detail="Kit item not found")

    log_delete(db, kit_item, user_id)
    db.delete(kit_item)
    db.commit()


# ============ Procedure Output (Assembly) Management ============


class OutputResponse(BaseModel):
    """Procedure output item response."""

    id: int
    part_id: int
    part_name: str
    part_internal_pn: str | None = None
    part_external_pn: str | None
    part_lifecycle_state: str | None = None
    quantity_produced: float

    model_config = {"from_attributes": True}


class OutputCreate(BaseModel):
    """Create output item request."""

    part_id: int
    quantity_produced: float = 1.0


class OutputUpdate(BaseModel):
    """Update output item request."""

    quantity_produced: float


@router.get("/{procedure_id}/outputs", response_model=list[OutputResponse])
def get_outputs(
    procedure_id: int,
    db: DbSession,
) -> list[OutputResponse]:
    """Get all output parts for a procedure (what it produces)."""
    procedure = (
        db.query(MasterProcedure)
        .filter(MasterProcedure.id == procedure_id, MasterProcedure.deleted_at.is_(None))
        .first()
    )
    if not procedure:
        raise HTTPException(status_code=404, detail="Procedure not found")

    return [_output_response(o) for o in procedure.outputs]


@router.post("/{procedure_id}/outputs", response_model=OutputResponse, status_code=201)
def add_output(
    procedure_id: int,
    data: OutputCreate,
    db: DbSession,
    user_id: CurrentUserId,
) -> OutputResponse:
    """Add an output part to a procedure (what it produces)."""
    procedure = (
        db.query(MasterProcedure)
        .filter(MasterProcedure.id == procedure_id, MasterProcedure.deleted_at.is_(None))
        .first()
    )
    if not procedure:
        raise HTTPException(status_code=404, detail="Procedure not found")

    # Verify part exists
    part = db.query(Part).filter(Part.id == data.part_id, Part.deleted_at.is_(None)).first()
    if not part:
        raise HTTPException(status_code=404, detail="Part not found")

    # Check if already in outputs
    existing = (
        db.query(ProcedureOutput)
        .filter(
            ProcedureOutput.procedure_id == procedure_id, ProcedureOutput.part_id == data.part_id
        )
        .first()
    )
    if existing:
        raise HTTPException(status_code=400, detail="Part already in outputs")

    output = ProcedureOutput(
        procedure_id=procedure_id,
        part_id=data.part_id,
        quantity_produced=Decimal(str(data.quantity_produced)),
    )
    db.add(output)
    db.flush()
    log_create(db, output, user_id)

    # Auto-populate kit from output part's BOM (single-level, direct children only)
    from opal.db.models.part import BOMLine

    bom_lines = db.query(BOMLine).filter(BOMLine.assembly_id == data.part_id).all()
    for bom_line in bom_lines:
        kit_qty = Decimal(str(bom_line.quantity)) * output.quantity_produced
        existing_kit = (
            db.query(Kit)
            .filter(Kit.procedure_id == procedure_id, Kit.part_id == bom_line.component_id)
            .first()
        )
        if existing_kit:
            old_values = get_model_dict(existing_kit)
            existing_kit.quantity_required += kit_qty
            log_update(db, existing_kit, old_values, user_id)
        else:
            kit_item = Kit(
                procedure_id=procedure_id,
                part_id=bom_line.component_id,
                quantity_required=kit_qty,
            )
            db.add(kit_item)
            db.flush()
            log_create(db, kit_item, user_id)

    db.commit()
    db.refresh(output)

    return _output_response(output)


@router.patch("/{procedure_id}/outputs/{part_id}", response_model=OutputResponse)
def update_output(
    procedure_id: int,
    part_id: int,
    data: OutputUpdate,
    db: DbSession,
    user_id: CurrentUserId,
) -> OutputResponse:
    """Update an output item quantity."""
    _require_live_procedure(db, procedure_id)
    output = (
        db.query(ProcedureOutput)
        .filter(ProcedureOutput.procedure_id == procedure_id, ProcedureOutput.part_id == part_id)
        .first()
    )
    if not output:
        raise HTTPException(status_code=404, detail="Output item not found")

    old_values = get_model_dict(output)
    output.quantity_produced = Decimal(str(data.quantity_produced))

    log_update(db, output, old_values, user_id)
    db.commit()
    db.refresh(output)

    return _output_response(output)


@router.delete("/{procedure_id}/outputs/{part_id}", status_code=204)
def remove_output(
    procedure_id: int,
    part_id: int,
    db: DbSession,
    user_id: CurrentUserId,
) -> None:
    """Remove a part from the outputs."""
    _require_live_procedure(db, procedure_id)
    output = (
        db.query(ProcedureOutput)
        .filter(ProcedureOutput.procedure_id == procedure_id, ProcedureOutput.part_id == part_id)
        .first()
    )
    if not output:
        raise HTTPException(status_code=404, detail="Output item not found")

    log_delete(db, output, user_id)
    db.delete(output)
    db.commit()


# ============ Step Kit (Step-Level Parts) ============


class StepKitResponse(BaseModel):
    """Step kit item response."""

    id: int
    step_id: int
    part_id: int
    part_name: str
    part_external_pn: str | None
    quantity_required: float
    usage_type: str
    notes: str | None = None

    model_config = {"from_attributes": True}


class StepKitCreate(BaseModel):
    """Add part to step kit."""

    part_id: int
    quantity_required: float = Field(..., gt=0)
    usage_type: str = "consume"  # "consume" or "tooling"
    notes: str | None = None


class StepKitUpdate(BaseModel):
    """Update step kit item."""

    quantity_required: float | None = Field(None, gt=0)
    usage_type: str | None = None
    notes: str | None = None


@router.get("/{procedure_id}/steps/{step_id}/kit", response_model=list[StepKitResponse])
def get_step_kit(
    procedure_id: int,
    step_id: int,
    db: DbSession,
) -> list[StepKitResponse]:
    """Get parts required for a specific step."""
    _require_live_procedure(db, procedure_id)
    step = (
        db.query(ProcedureStep)
        .filter(ProcedureStep.id == step_id, ProcedureStep.procedure_id == procedure_id)
        .first()
    )
    if not step:
        raise HTTPException(status_code=404, detail="Step not found")

    return [
        StepKitResponse(
            id=sk.id,
            step_id=sk.step_id,
            part_id=sk.part_id,
            part_name=sk.part.name,
            part_external_pn=sk.part.external_pn,
            quantity_required=float(sk.quantity_required),
            usage_type=sk.usage_type.value if hasattr(sk.usage_type, "value") else sk.usage_type,
            notes=sk.notes,
        )
        for sk in step.step_kits
    ]


@router.post("/{procedure_id}/steps/{step_id}/kit", response_model=StepKitResponse, status_code=201)
def add_step_kit_item(
    procedure_id: int,
    step_id: int,
    data: StepKitCreate,
    db: DbSession,
    user_id: CurrentUserId,
) -> StepKitResponse:
    """Add a part to a step's kit."""
    _require_live_procedure(db, procedure_id)
    step = (
        db.query(ProcedureStep)
        .filter(ProcedureStep.id == step_id, ProcedureStep.procedure_id == procedure_id)
        .first()
    )
    if not step:
        raise HTTPException(status_code=404, detail="Step not found")

    part = db.query(Part).filter(Part.id == data.part_id, Part.deleted_at.is_(None)).first()
    if not part:
        raise HTTPException(status_code=404, detail="Part not found")

    # Check if already in step kit
    existing = (
        db.query(StepKit)
        .filter(StepKit.step_id == step_id, StepKit.part_id == data.part_id)
        .first()
    )
    if existing:
        raise HTTPException(status_code=400, detail="Part already in step kit")

    # Validate usage type
    try:
        usage = UsageType(data.usage_type)
    except ValueError as err:
        raise HTTPException(
            status_code=400, detail=f"Invalid usage type: {data.usage_type}"
        ) from err

    step_kit = StepKit(
        step_id=step_id,
        part_id=data.part_id,
        quantity_required=Decimal(str(data.quantity_required)),
        usage_type=usage,
        notes=data.notes,
    )
    db.add(step_kit)
    db.flush()

    log_create(db, step_kit, user_id)
    db.commit()
    db.refresh(step_kit)

    return StepKitResponse(
        id=step_kit.id,
        step_id=step_kit.step_id,
        part_id=step_kit.part_id,
        part_name=part.name,
        part_external_pn=part.external_pn,
        quantity_required=float(step_kit.quantity_required),
        usage_type=step_kit.usage_type.value
        if hasattr(step_kit.usage_type, "value")
        else step_kit.usage_type,
        notes=step_kit.notes,
    )


@router.patch("/{procedure_id}/steps/{step_id}/kit/{kit_id}", response_model=StepKitResponse)
def update_step_kit_item(
    procedure_id: int,
    step_id: int,
    kit_id: int,
    data: StepKitUpdate,
    db: DbSession,
    user_id: CurrentUserId,
) -> StepKitResponse:
    """Update a step kit item."""
    _require_live_procedure(db, procedure_id)
    step_kit = (
        db.query(StepKit)
        .join(ProcedureStep)
        .filter(
            StepKit.id == kit_id,
            StepKit.step_id == step_id,
            ProcedureStep.procedure_id == procedure_id,
        )
        .first()
    )
    if not step_kit:
        raise HTTPException(status_code=404, detail="Step kit item not found")

    old_values = get_model_dict(step_kit)

    if data.quantity_required is not None:
        step_kit.quantity_required = Decimal(str(data.quantity_required))
    if data.usage_type is not None:
        try:
            step_kit.usage_type = UsageType(data.usage_type)
        except ValueError as err:
            raise HTTPException(
                status_code=400, detail=f"Invalid usage type: {data.usage_type}"
            ) from err
    if data.notes is not None:
        step_kit.notes = data.notes

    log_update(db, step_kit, old_values, user_id)
    db.commit()
    db.refresh(step_kit)

    return StepKitResponse(
        id=step_kit.id,
        step_id=step_kit.step_id,
        part_id=step_kit.part_id,
        part_name=step_kit.part.name,
        part_external_pn=step_kit.part.external_pn,
        quantity_required=float(step_kit.quantity_required),
        usage_type=step_kit.usage_type.value
        if hasattr(step_kit.usage_type, "value")
        else step_kit.usage_type,
        notes=step_kit.notes,
    )


@router.delete("/{procedure_id}/steps/{step_id}/kit/{part_id}", status_code=204)
def remove_step_kit_item(
    procedure_id: int,
    step_id: int,
    part_id: int,
    db: DbSession,
    user_id: CurrentUserId,
) -> None:
    """Remove a part from a step's kit."""
    _require_live_procedure(db, procedure_id)
    step_kit = (
        db.query(StepKit)
        .join(ProcedureStep)
        .filter(
            StepKit.step_id == step_id,
            StepKit.part_id == part_id,
            ProcedureStep.procedure_id == procedure_id,
        )
        .first()
    )
    if not step_kit:
        raise HTTPException(status_code=404, detail="Step kit item not found")

    log_delete(db, step_kit, user_id)
    db.delete(step_kit)
    db.commit()


# ============ Procedure Cloning ============


class CloneProcedureRequest(BaseModel):
    """Request to clone a procedure."""

    new_name: str | None = None
    copy_kit: bool = True
    copy_outputs: bool = True


@router.post("/{procedure_id}/clone", response_model=ProcedureResponse, status_code=201)
def clone_procedure(
    procedure_id: int,
    data: CloneProcedureRequest,
    db: DbSession,
    user_id: CurrentUserId,
) -> ProcedureResponse:
    """Clone an existing procedure to create a new one.

    Creates a copy of the procedure including:
    - All steps (with hierarchy preserved)
    - Step-level kit items (if copy_kit=True)
    - Procedure-level kit items (if copy_kit=True)
    - Output definitions (if copy_outputs=True)

    The new procedure starts in DRAFT status with version 0.
    """
    # Get source procedure
    source = (
        db.query(MasterProcedure)
        .filter(MasterProcedure.id == procedure_id, MasterProcedure.deleted_at.is_(None))
        .first()
    )
    if not source:
        raise HTTPException(status_code=404, detail="Procedure not found")

    # Create new procedure
    clone_name = data.new_name or f"Copy of {source.name}"
    new_procedure = MasterProcedure(
        template_number=generate_template_number(db),
        name=clone_name,
        description=source.description,
        procedure_type=source.procedure_type,
        status=ProcedureStatus.DRAFT,
        current_version_id=None,
    )
    db.add(new_procedure)
    db.flush()

    # Map old step IDs to new step IDs (for parent references)
    step_id_map: dict[int, int] = {}

    # Get source steps ordered by hierarchy
    source_steps = (
        db.query(ProcedureStep)
        .filter(ProcedureStep.procedure_id == source.id)
        .order_by(ProcedureStep.order)
        .all()
    )

    # Clone steps (first pass - create all steps without parent references)
    for source_step in source_steps:
        new_step = ProcedureStep(
            procedure_id=new_procedure.id,
            order=source_step.order,
            step_number=source_step.step_number,
            level=source_step.level,
            parent_step_id=None,  # Set in second pass
            title=source_step.title,
            instructions=source_step.instructions,
            required_data_schema=source_step.required_data_schema,
            is_contingency=source_step.is_contingency,
            requires_signoff=source_step.requires_signoff,
            signoffs=copy.deepcopy(source_step.signoffs),
            estimated_duration_minutes=source_step.estimated_duration_minutes,
            required_role=source_step.required_role,
            callouts=copy.deepcopy(source_step.callouts),
            strict_sequence=source_step.strict_sequence,
            workcenter_id=source_step.workcenter_id,
        )
        db.add(new_step)
        db.flush()
        step_id_map[source_step.id] = new_step.id

    # Second pass - set parent references
    for source_step in source_steps:
        if source_step.parent_step_id and source_step.parent_step_id in step_id_map:
            new_step = (
                db.query(ProcedureStep)
                .filter(ProcedureStep.id == step_id_map[source_step.id])
                .first()
            )
            if new_step:
                new_step.parent_step_id = step_id_map[source_step.parent_step_id]

    # Clone step dependencies (remapped to the new step ids)
    for dep in db.query(StepDependency).filter(StepDependency.step_id.in_(list(step_id_map))):
        if dep.depends_on_step_id in step_id_map:
            db.add(
                StepDependency(
                    step_id=step_id_map[dep.step_id],
                    depends_on_step_id=step_id_map[dep.depends_on_step_id],
                )
            )

    # Clone step-level kit items
    if data.copy_kit:
        for source_step in source_steps:
            source_step_kits = db.query(StepKit).filter(StepKit.step_id == source_step.id).all()
            for sk in source_step_kits:
                new_step_kit = StepKit(
                    step_id=step_id_map[source_step.id],
                    part_id=sk.part_id,
                    quantity_required=sk.quantity_required,
                    usage_type=sk.usage_type,
                    notes=sk.notes,
                )
                db.add(new_step_kit)

        # Clone procedure-level kit items
        source_kits = db.query(Kit).filter(Kit.procedure_id == source.id).all()
        for kit in source_kits:
            new_kit = Kit(
                procedure_id=new_procedure.id,
                part_id=kit.part_id,
                quantity_required=kit.quantity_required,
            )
            db.add(new_kit)

    # Clone output definitions
    if data.copy_outputs:
        source_outputs = (
            db.query(ProcedureOutput).filter(ProcedureOutput.procedure_id == source.id).all()
        )
        for output in source_outputs:
            new_output = ProcedureOutput(
                procedure_id=new_procedure.id,
                part_id=output.part_id,
                quantity_produced=output.quantity_produced,
            )
            db.add(new_output)

    log_create(db, new_procedure, user_id)
    db.commit()
    db.refresh(new_procedure)

    return ProcedureResponse.model_validate(new_procedure)
