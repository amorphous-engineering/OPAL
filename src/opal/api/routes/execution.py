"""Execution API routes - procedure instances and step execution."""

from datetime import UTC, datetime
from decimal import Decimal
from typing import Any

from fastapi import APIRouter, HTTPException, Query
from pydantic import BaseModel, Field

from opal.api.deps import CurrentUserId, DbSession
from opal.core.audit import get_model_dict, log_create, log_update
from opal.core.designators import (
    generate_issue_number,
    generate_opal_number,
    generate_serial_number,
    generate_work_order_number,
)
from opal.core.events import (
    emit_cursor_moved,
    emit_instance_completed,
    emit_instance_started,
    emit_step_completed,
    emit_user_joined,
    emit_user_left,
)
from opal.core.execution_flow import (
    FlowError,
    build_execution_state,
    check_instance_completion,
    clear_focus,
    complete_blockers,
    complete_step_flow,
    focus_step,
    held_scope_blockers,
    mark_instance_in_work,
    maybe_resume_step_after_nc_update,
    touch_user_presence,
)
from opal.core.genealogy import record_assembly_genealogy
from opal.core.part_lifecycle import ensure_parts_active
from opal.db.models import InventoryRecord, Kit, Part, ProcedureOutput
from opal.db.models.execution import (
    InstanceStatus,
    ProcedureInstance,
    StepExecution,
    StepStatus,
)
from opal.db.models.inventory import (
    ConsumptionType,
    InventoryConsumption,
    InventoryProduction,
    ProductionStatus,
    SourceType,
    UsageType,
)
from opal.db.models.issue import Issue, IssuePriority, IssueStatus, IssueType
from opal.db.models.procedure import MasterProcedure, ProcedureType, ProcedureVersion

router = APIRouter(prefix="/procedure-instances", tags=["execution"])


# ============ Schemas ============


class StepExecutionResponse(BaseModel):
    """Step execution response."""

    id: int
    step_number: int
    step_number_str: str  # Display number like "1", "1.1", "C1"
    level: int  # 0=parent OP, 1+=sub-step
    parent_step_order: int | None = None
    status: str
    data_captured: dict[str, Any] | None = None
    started_at: datetime | None = None
    completed_at: datetime | None = None
    completed_by_id: int | None = None
    notes: str | None = None
    signed_off_at: datetime | None = None
    signed_off_by_id: int | None = None
    duration_seconds: int | None = None

    model_config = {"from_attributes": True}


class InstanceResponse(BaseModel):
    """Procedure instance response."""

    id: int
    procedure_id: int
    procedure_name: str
    version_id: int
    version_number: int
    work_order_number: str | None = None
    status: str
    started_at: datetime | None = None
    completed_at: datetime | None = None
    started_by_id: int | None = None
    duration_seconds: int | None = None
    scheduled_start_at: datetime | None = None
    target_completion_at: datetime | None = None
    priority: int = 0
    target_entity: dict[str, Any] | None = None
    created_at: datetime
    step_executions: list[StepExecutionResponse] = []

    model_config = {"from_attributes": True}


class InstanceListResponse(BaseModel):
    """Paginated instance list."""

    items: list[InstanceResponse]
    total: int
    page: int
    page_size: int


class InstanceCreate(BaseModel):
    """Create procedure instance request."""

    procedure_id: int
    version_id: int | None = Field(None, description="If not provided, uses current version")
    work_order_number: str | None = None
    quantity: int = Field(
        1, ge=1, le=100, description="Number of identical work orders to cut (batch cut)"
    )
    scheduled_start_at: datetime | None = None
    target_completion_at: datetime | None = None
    priority: int = 0
    target_entity: dict[str, Any] | None = Field(
        None,
        description="Entity this execution targets, e.g. "
        '{"entity_type": "part", "entity_id": 42, "entity_label": "SN-00042"}',
    )


class InstanceUpdate(BaseModel):
    """Update instance request."""

    status: str | None = None
    work_order_number: str | None = None
    scheduled_start_at: datetime | None = None
    target_completion_at: datetime | None = None
    priority: int | None = None


class StepStart(BaseModel):
    """Start step request."""

    pass  # No fields needed, just marks step as started


class StepComplete(BaseModel):
    """Complete step request."""

    data_captured: dict[str, Any] | None = None
    notes: str | None = None


class NonConformanceCreate(BaseModel):
    """Anomaly capture during step execution (creates an Issue).

    containment 'step' holds the raised step (and its OP) until disposition;
    'advisory' records the anomaly without holding anything.
    blocks_step_numbers binds additional hold points: those steps cannot
    COMPLETE while this issue is undispositioned.
    """

    title: str = Field(..., min_length=1, max_length=255)
    description: str | None = None
    priority: str = "medium"
    should_be: str | None = Field(None, description="Expected condition")
    is_condition: str | None = Field(None, description="Actual condition")
    containment: str = Field("step", description="step | advisory")
    blocks_step_numbers: list[int] = Field(
        default_factory=list,
        description="Snapshot step orders this issue blocks from starting",
    )


# ============ Instance CRUD ============


@router.get("", response_model=InstanceListResponse)
def list_instances(
    db: DbSession,
    procedure_id: int | None = Query(None),
    status: str | None = Query(None),
    work_order: str | None = Query(None),
    page: int = Query(1, ge=1),
    page_size: int = Query(50, ge=1, le=100),
) -> InstanceListResponse:
    """List procedure instances with optional filters."""
    query = db.query(ProcedureInstance)

    if procedure_id:
        query = query.filter(ProcedureInstance.procedure_id == procedure_id)
    if status:
        query = query.filter(ProcedureInstance.status == status)
    if work_order:
        query = query.filter(ProcedureInstance.work_order_number.ilike(f"%{work_order}%"))

    total = query.count()

    instances = (
        query.order_by(ProcedureInstance.id.desc())
        .offset((page - 1) * page_size)
        .limit(page_size)
        .all()
    )

    items = []
    for inst in instances:
        version = db.query(ProcedureVersion).filter(ProcedureVersion.id == inst.version_id).first()
        items.append(
            InstanceResponse(
                id=inst.id,
                procedure_id=inst.procedure_id,
                procedure_name=inst.procedure.name,
                version_id=inst.version_id,
                version_number=version.version_number if version else 0,
                work_order_number=inst.work_order_number,
                status=inst.status.value if hasattr(inst.status, "value") else inst.status,
                started_at=inst.started_at,
                completed_at=inst.completed_at,
                started_by_id=inst.started_by_id,
                duration_seconds=inst.duration_seconds,
                scheduled_start_at=inst.scheduled_start_at,
                target_completion_at=inst.target_completion_at,
                priority=inst.priority,
                target_entity=inst.target_entity,
                created_at=inst.created_at,
                step_executions=[
                    StepExecutionResponse(
                        id=se.id,
                        step_number=se.step_number,
                        step_number_str=se.step_number_str,
                        level=se.level,
                        parent_step_order=se.parent_step_order,
                        status=se.status.value if hasattr(se.status, "value") else se.status,
                        data_captured=se.data_captured,
                        started_at=se.started_at,
                        completed_at=se.completed_at,
                        completed_by_id=se.completed_by_id,
                        signed_off_at=se.signed_off_at,
                        notes=se.notes,
                        signed_off_by_id=se.signed_off_by_id,
                        duration_seconds=se.duration_seconds,
                    )
                    for se in inst.step_executions
                ],
            )
        )

    return InstanceListResponse(
        items=items,
        total=total,
        page=page,
        page_size=page_size,
    )


@router.post("", response_model=InstanceResponse, status_code=201)
def create_instance(
    data: InstanceCreate,
    db: DbSession,
    user_id: CurrentUserId,
) -> InstanceResponse:
    """Cut work order(s) from a procedure version.

    quantity > 1 cuts a batch of identical work orders, each with its own
    generated WO number; the response carries the first cut.
    """
    # Validate procedure exists
    procedure = (
        db.query(MasterProcedure)
        .filter(MasterProcedure.id == data.procedure_id, MasterProcedure.deleted_at.is_(None))
        .first()
    )
    if not procedure:
        raise HTTPException(status_code=404, detail="Procedure not found")

    # Get version
    if data.version_id:
        version = db.query(ProcedureVersion).filter(ProcedureVersion.id == data.version_id).first()
        if not version or version.procedure_id != data.procedure_id:
            raise HTTPException(status_code=404, detail="Version not found for this procedure")
    else:
        # Use current version
        if not procedure.current_version_id:
            raise HTTPException(status_code=400, detail="Procedure has no published version")
        version = (
            db.query(ProcedureVersion)
            .filter(ProcedureVersion.id == procedure.current_version_id)
            .first()
        )

    if data.work_order_number and data.quantity > 1:
        raise HTTPException(
            status_code=400,
            detail="Explicit work order number only applies to a single cut",
        )

    # Step hierarchy from the version snapshot — shared by every cut.
    steps = version.content.get("steps", [])
    order_to_parent: dict[int, int | None] = {}
    for step in steps:
        parent_id = step.get("parent_step_id")
        if parent_id:
            parent_step = next((s for s in steps if s.get("id") == parent_id), None)
            order_to_parent[step["order"]] = parent_step["order"] if parent_step else None
        else:
            order_to_parent[step["order"]] = None

    # BUILD procedures auto-allocate output assemblies. An as-built
    # allocation is a physical reference — draft output parts block the
    # whole cut (raises DraftPartsBlocked -> 409) before anything exists.
    proc_type = procedure.procedure_type
    if hasattr(proc_type, "value"):
        proc_type = proc_type.value
    outputs = []
    if proc_type == ProcedureType.BUILD.value:
        outputs = (
            db.query(ProcedureOutput)
            .filter(ProcedureOutput.procedure_id == data.procedure_id)
            .all()
        )
        ensure_parts_active(
            db,
            [output.part_id for output in outputs],
            f"{procedure.name} as-built allocation",
        )

    first_instance: ProcedureInstance | None = None
    for _ in range(data.quantity):
        work_order_number = data.work_order_number or generate_work_order_number(db)

        instance = ProcedureInstance(
            procedure_id=data.procedure_id,
            version_id=version.id,
            work_order_number=work_order_number,
            status=InstanceStatus.CUT,
            started_by_id=user_id,
            scheduled_start_at=data.scheduled_start_at,
            target_completion_at=data.target_completion_at,
            priority=data.priority,
            target_entity=data.target_entity,
        )
        db.add(instance)
        db.flush()

        for step in steps:
            step_exec = StepExecution(
                instance_id=instance.id,
                step_number=step["order"],
                step_number_str=step.get("step_number", str(step["order"])),
                level=step.get("level", 0),
                parent_step_order=order_to_parent.get(step["order"]),
                status=StepStatus.PENDING,
            )
            db.add(step_exec)

        for output in outputs:
            output_part = db.query(Part).filter(Part.id == output.part_id).first()
            if not output_part:
                continue

            serial = generate_serial_number(db, output_part)
            opal_num = generate_opal_number(db)

            # Create inventory record (qty=0 until finalized)
            inv_record = InventoryRecord(
                part_id=output.part_id,
                quantity=0,
                location="",
                lot_number=work_order_number,
                opal_number=opal_num,
                source_type=SourceType.PRODUCTION,
            )
            db.add(inv_record)
            db.flush()

            # Create production record in PLANNED status
            production = InventoryProduction(
                inventory_record_id=inv_record.id,
                quantity=output.quantity_produced,
                procedure_instance_id=instance.id,
                serial_number=serial,
                produced_opal_number=opal_num,
                status=ProductionStatus.PLANNED,
                produced_by_id=user_id,
            )
            db.add(production)
            db.flush()

            # Link inventory record to its production
            inv_record.source_production_id = production.id

        log_create(db, instance, user_id)
        if first_instance is None:
            first_instance = instance

    instance = first_instance
    db.commit()
    db.refresh(instance)

    return InstanceResponse(
        id=instance.id,
        procedure_id=instance.procedure_id,
        procedure_name=procedure.name,
        version_id=instance.version_id,
        version_number=version.version_number,
        work_order_number=instance.work_order_number,
        status=instance.status.value if hasattr(instance.status, "value") else instance.status,
        started_at=instance.started_at,
        completed_at=instance.completed_at,
        started_by_id=instance.started_by_id,
        duration_seconds=instance.duration_seconds,
        scheduled_start_at=instance.scheduled_start_at,
        target_completion_at=instance.target_completion_at,
        priority=instance.priority,
        target_entity=instance.target_entity,
        created_at=instance.created_at,
        step_executions=[
            StepExecutionResponse(
                id=se.id,
                step_number=se.step_number,
                step_number_str=se.step_number_str,
                level=se.level,
                parent_step_order=se.parent_step_order,
                status=se.status.value if hasattr(se.status, "value") else se.status,
                data_captured=se.data_captured,
                started_at=se.started_at,
                completed_at=se.completed_at,
                completed_by_id=se.completed_by_id,
                signed_off_at=se.signed_off_at,
                signed_off_by_id=se.signed_off_by_id,
                duration_seconds=se.duration_seconds,
            )
            for se in instance.step_executions
        ],
    )


@router.get("/{instance_id}", response_model=InstanceResponse)
def get_instance(
    instance_id: int,
    db: DbSession,
) -> InstanceResponse:
    """Get procedure instance by ID."""
    instance = db.query(ProcedureInstance).filter(ProcedureInstance.id == instance_id).first()
    if not instance:
        raise HTTPException(status_code=404, detail="Instance not found")

    version = db.query(ProcedureVersion).filter(ProcedureVersion.id == instance.version_id).first()

    return InstanceResponse(
        id=instance.id,
        procedure_id=instance.procedure_id,
        procedure_name=instance.procedure.name,
        version_id=instance.version_id,
        version_number=version.version_number if version else 0,
        work_order_number=instance.work_order_number,
        status=instance.status.value if hasattr(instance.status, "value") else instance.status,
        started_at=instance.started_at,
        completed_at=instance.completed_at,
        started_by_id=instance.started_by_id,
        duration_seconds=instance.duration_seconds,
        scheduled_start_at=instance.scheduled_start_at,
        target_completion_at=instance.target_completion_at,
        priority=instance.priority,
        target_entity=instance.target_entity,
        created_at=instance.created_at,
        step_executions=[
            StepExecutionResponse(
                id=se.id,
                step_number=se.step_number,
                step_number_str=se.step_number_str,
                level=se.level,
                parent_step_order=se.parent_step_order,
                status=se.status.value if hasattr(se.status, "value") else se.status,
                data_captured=se.data_captured,
                started_at=se.started_at,
                completed_at=se.completed_at,
                completed_by_id=se.completed_by_id,
                signed_off_at=se.signed_off_at,
                signed_off_by_id=se.signed_off_by_id,
                duration_seconds=se.duration_seconds,
            )
            for se in instance.step_executions
        ],
    )


@router.patch("/{instance_id}", response_model=InstanceResponse)
def update_instance(
    instance_id: int,
    data: InstanceUpdate,
    db: DbSession,
    user_id: CurrentUserId,
) -> InstanceResponse:
    """Update instance (status, work order, scheduling)."""
    instance = db.query(ProcedureInstance).filter(ProcedureInstance.id == instance_id).first()
    if not instance:
        raise HTTPException(status_code=404, detail="Instance not found")

    old_values = get_model_dict(instance)

    if data.status is not None:
        try:
            new_status = InstanceStatus(data.status)
        except ValueError as err:
            raise HTTPException(status_code=400, detail=f"Invalid status: {data.status}") from err

        # Status is derived from events (first COMPLETE/SKIP starts, last
        # completion completes); the only settable transition is the abort.
        current = instance.status.value if hasattr(instance.status, "value") else instance.status
        if new_status != instance.status:
            if new_status != InstanceStatus.ABORTED or current not in (
                InstanceStatus.CUT.value,
                InstanceStatus.IN_WORK.value,
            ):
                raise HTTPException(
                    status_code=400,
                    detail=f"Cannot set status {current} -> {new_status.value}; "
                    "status is derived from events, only an active work order can be aborted",
                )
            instance.status = new_status
            instance.completed_at = datetime.now(UTC)

    if data.work_order_number is not None:
        instance.work_order_number = data.work_order_number

    # Handle scheduling field updates
    if data.scheduled_start_at is not None:
        instance.scheduled_start_at = data.scheduled_start_at
    if data.target_completion_at is not None:
        instance.target_completion_at = data.target_completion_at
    if data.priority is not None:
        instance.priority = data.priority

    log_update(db, instance, old_values, user_id)
    db.commit()
    db.refresh(instance)

    version = db.query(ProcedureVersion).filter(ProcedureVersion.id == instance.version_id).first()

    return InstanceResponse(
        id=instance.id,
        procedure_id=instance.procedure_id,
        procedure_name=instance.procedure.name,
        version_id=instance.version_id,
        version_number=version.version_number if version else 0,
        work_order_number=instance.work_order_number,
        status=instance.status.value if hasattr(instance.status, "value") else instance.status,
        started_at=instance.started_at,
        completed_at=instance.completed_at,
        started_by_id=instance.started_by_id,
        duration_seconds=instance.duration_seconds,
        scheduled_start_at=instance.scheduled_start_at,
        target_completion_at=instance.target_completion_at,
        priority=instance.priority,
        target_entity=instance.target_entity,
        created_at=instance.created_at,
        step_executions=[
            StepExecutionResponse(
                id=se.id,
                step_number=se.step_number,
                step_number_str=se.step_number_str,
                level=se.level,
                parent_step_order=se.parent_step_order,
                status=se.status.value if hasattr(se.status, "value") else se.status,
                data_captured=se.data_captured,
                started_at=se.started_at,
                completed_at=se.completed_at,
                completed_by_id=se.completed_by_id,
                signed_off_at=se.signed_off_at,
                signed_off_by_id=se.signed_off_by_id,
                duration_seconds=se.duration_seconds,
            )
            for se in instance.step_executions
        ],
    )


# ============ Step Execution ============


class FocusMove(BaseModel):
    """Move the caller's cursor to a step. Presence, not an event."""

    step_number: int


@router.post("/{instance_id}/focus")
async def move_focus(
    instance_id: int,
    data: FocusMove,
    db: DbSession,
    user_id: CurrentUserId,
) -> dict:
    """Move the caller's cursor. Broadcast to the document; never recorded."""
    instance = db.query(ProcedureInstance).filter(ProcedureInstance.id == instance_id).first()
    if not instance:
        raise HTTPException(status_code=404, detail="Instance not found")

    step_exec = (
        db.query(StepExecution)
        .filter(
            StepExecution.instance_id == instance_id,
            StepExecution.step_number == data.step_number,
        )
        .first()
    )
    if not step_exec:
        raise HTTPException(status_code=404, detail="Step not found")

    from opal.db.models import User

    user = db.query(User).filter(User.id == user_id).first()
    if not user:
        raise HTTPException(status_code=401, detail="Unknown user")

    user.last_seen_at = datetime.now(UTC)
    focus = focus_step(db, instance, step_exec, user)
    db.commit()

    await emit_cursor_moved(instance_id, data.step_number, user_id, user.name)

    return {
        "step_number": data.step_number,
        "focused_at": focus.focused_at.isoformat(),
    }


@router.get("/{instance_id}/state")
def get_execution_state(
    instance_id: int,
    db: DbSession,
    user_id: CurrentUserId,
) -> dict:
    """Full document state: steps, presence, holds — the controller's view.

    Polled by the execution document every 5s; identical payload to the MCP
    get_execution_state tool. The poll doubles as the presence heartbeat.
    """
    instance = db.query(ProcedureInstance).filter(ProcedureInstance.id == instance_id).first()
    if not instance:
        raise HTTPException(status_code=404, detail="Instance not found")
    touch_user_presence(db, user_id)
    return build_execution_state(db, instance)


@router.post("/{instance_id}/steps/{step_number}/complete", response_model=StepExecutionResponse)
async def complete_step(
    instance_id: int,
    step_number: int,
    data: StepComplete,
    db: DbSession,
    user_id: CurrentUserId,
) -> StepExecutionResponse:
    """Complete a step execution with optional data capture."""
    instance = db.query(ProcedureInstance).filter(ProcedureInstance.id == instance_id).first()
    if not instance:
        raise HTTPException(status_code=404, detail="Instance not found")

    step_exec = (
        db.query(StepExecution)
        .filter(StepExecution.instance_id == instance_id, StepExecution.step_number == step_number)
        .first()
    )
    if not step_exec:
        raise HTTPException(status_code=404, detail="Step not found")

    try:
        result = complete_step_flow(
            db,
            instance,
            step_exec,
            user_id,
            data_captured=data.data_captured,
            notes=data.notes,
        )
    except FlowError as err:
        raise HTTPException(status_code=err.status_code, detail=err.message) from err
    if result.validation_errors:
        raise HTTPException(status_code=422, detail=result.validation_errors)

    from opal.db.models import User

    user = db.query(User).filter(User.id == user_id).first()
    user_name = user.name if user else None

    db.commit()
    db.refresh(step_exec)
    db.refresh(instance)

    # Emit real-time events
    await emit_step_completed(instance_id, step_number, user_id, user_name)
    if result.instance_started:
        await emit_instance_started(instance_id, instance.procedure_id, user_id, user_name)
    if result.instance_completed:
        await emit_instance_completed(
            instance_id, instance.procedure_id, InstanceStatus.COMPLETED.value
        )

    return StepExecutionResponse(
        id=step_exec.id,
        step_number=step_exec.step_number,
        step_number_str=step_exec.step_number_str,
        level=step_exec.level,
        parent_step_order=step_exec.parent_step_order,
        status=step_exec.status.value if hasattr(step_exec.status, "value") else step_exec.status,
        data_captured=step_exec.data_captured,
        started_at=step_exec.started_at,
        completed_at=step_exec.completed_at,
        completed_by_id=step_exec.completed_by_id,
        signed_off_at=step_exec.signed_off_at,
        notes=step_exec.notes,
        signed_off_by_id=step_exec.signed_off_by_id,
        duration_seconds=step_exec.duration_seconds,
    )


class StepNotesUpdate(BaseModel):
    """Update step notes."""

    notes: str | None = None


@router.patch("/{instance_id}/steps/{step_number}/notes", response_model=StepExecutionResponse)
def update_step_notes(
    instance_id: int,
    step_number: int,
    data: StepNotesUpdate,
    db: DbSession,
    user_id: CurrentUserId,
) -> StepExecutionResponse:
    """Update notes on a step execution (while in progress or after completion)."""
    instance = db.query(ProcedureInstance).filter(ProcedureInstance.id == instance_id).first()
    if not instance:
        raise HTTPException(status_code=404, detail="Instance not found")

    step_exec = (
        db.query(StepExecution)
        .filter(StepExecution.instance_id == instance_id, StepExecution.step_number == step_number)
        .first()
    )
    if not step_exec:
        raise HTTPException(status_code=404, detail="Step not found")

    step_exec.notes = data.notes
    db.commit()
    db.refresh(step_exec)

    return StepExecutionResponse(
        id=step_exec.id,
        step_number=step_exec.step_number,
        step_number_str=step_exec.step_number_str,
        level=step_exec.level,
        parent_step_order=step_exec.parent_step_order,
        status=step_exec.status.value if hasattr(step_exec.status, "value") else step_exec.status,
        data_captured=step_exec.data_captured,
        started_at=step_exec.started_at,
        completed_at=step_exec.completed_at,
        completed_by_id=step_exec.completed_by_id,
        signed_off_at=step_exec.signed_off_at,
        notes=step_exec.notes,
        signed_off_by_id=step_exec.signed_off_by_id,
        duration_seconds=step_exec.duration_seconds,
    )


class StepSkip(BaseModel):
    """Skip step request."""

    reason: str | None = None


@router.post("/{instance_id}/steps/{step_number}/skip", response_model=StepExecutionResponse)
async def skip_step(
    instance_id: int,
    step_number: int,
    data: StepSkip,
    db: DbSession,
    user_id: CurrentUserId,
) -> StepExecutionResponse:
    """Skip a step (mark as N/A or intentionally skipped)."""
    instance = db.query(ProcedureInstance).filter(ProcedureInstance.id == instance_id).first()
    if not instance:
        raise HTTPException(status_code=404, detail="Instance not found")

    inst_status = instance.status.value if hasattr(instance.status, "value") else instance.status
    if inst_status not in (InstanceStatus.CUT.value, InstanceStatus.IN_WORK.value):
        raise HTTPException(status_code=400, detail="Instance is not active")

    step_exec = (
        db.query(StepExecution)
        .filter(StepExecution.instance_id == instance_id, StepExecution.step_number == step_number)
        .first()
    )
    if not step_exec:
        raise HTTPException(status_code=404, detail="Step not found")

    step_status = step_exec.status.value if hasattr(step_exec.status, "value") else step_exec.status
    if step_status in (StepStatus.COMPLETED.value, StepStatus.SIGNED_OFF.value):
        raise HTTPException(status_code=400, detail="Cannot skip completed step")
    if step_status == StepStatus.ON_HOLD.value:
        raise HTTPException(
            status_code=400,
            detail="Cannot skip a step that is on hold for an open NC; "
            "resolve the NC disposition first.",
        )

    # Skip is a commitment moment too — held work cannot be skipped around.
    holds = held_scope_blockers(db, instance, step_exec)
    if holds:
        raise HTTPException(
            status_code=400,
            detail="Cannot skip: " + "; ".join(b.message for b in holds),
        )

    instance_started = mark_instance_in_work(db, instance)

    step_exec.status = StepStatus.SKIPPED
    step_exec.completed_at = datetime.now(UTC)
    step_exec.completed_by_id = user_id
    if data.reason:
        step_exec.data_captured = {"skip_reason": data.reason}

    # Check if procedure is complete (considering contingency rules)
    check_instance_completion(db, instance)

    db.commit()
    db.refresh(step_exec)

    if instance_started:
        await emit_instance_started(instance_id, instance.procedure_id, user_id, None)

    return StepExecutionResponse(
        id=step_exec.id,
        step_number=step_exec.step_number,
        step_number_str=step_exec.step_number_str,
        level=step_exec.level,
        parent_step_order=step_exec.parent_step_order,
        status=step_exec.status.value if hasattr(step_exec.status, "value") else step_exec.status,
        data_captured=step_exec.data_captured,
        started_at=step_exec.started_at,
        completed_at=step_exec.completed_at,
        completed_by_id=step_exec.completed_by_id,
        signed_off_at=step_exec.signed_off_at,
        notes=step_exec.notes,
        signed_off_by_id=step_exec.signed_off_by_id,
        duration_seconds=step_exec.duration_seconds,
    )


@router.post("/{instance_id}/steps/{step_number}/signoff", response_model=StepExecutionResponse)
async def signoff_step(
    instance_id: int,
    step_number: int,
    db: DbSession,
    user_id: CurrentUserId,
) -> StepExecutionResponse:
    """Sign off on a step in AWAITING_SIGNOFF status.

    This applies to parent OPs (after all sub-steps complete) and any step
    with requires_signoff=True. Only steps in AWAITING_SIGNOFF status
    can be signed off.
    """
    instance = db.query(ProcedureInstance).filter(ProcedureInstance.id == instance_id).first()
    if not instance:
        raise HTTPException(status_code=404, detail="Instance not found")

    inst_status = instance.status.value if hasattr(instance.status, "value") else instance.status
    if inst_status not in (InstanceStatus.CUT.value, InstanceStatus.IN_WORK.value):
        raise HTTPException(status_code=400, detail="Instance is not active")

    step_exec = (
        db.query(StepExecution)
        .filter(StepExecution.instance_id == instance_id, StepExecution.step_number == step_number)
        .first()
    )
    if not step_exec:
        raise HTTPException(status_code=404, detail="Step not found")

    step_status = step_exec.status.value if hasattr(step_exec.status, "value") else step_exec.status

    # Can only sign off steps that are awaiting sign-off
    if step_status != StepStatus.AWAITING_SIGNOFF.value:
        if step_status == StepStatus.SIGNED_OFF.value:
            raise HTTPException(status_code=400, detail="Step already signed off")
        elif step_status in [StepStatus.PENDING.value, StepStatus.IN_PROGRESS.value]:
            raise HTTPException(
                status_code=400, detail="Step has sub-steps that are not yet complete"
            )
        else:
            raise HTTPException(
                status_code=400, detail=f"Cannot sign off step in {step_status} status"
            )

    # Sign-off is the OP's COMPLETE — undispositioned issues in scope gate it.
    holds = complete_blockers(db, instance, step_exec)
    if holds:
        raise HTTPException(
            status_code=400,
            detail="Cannot sign off: " + "; ".join(b.message for b in holds),
        )

    step_exec.status = StepStatus.SIGNED_OFF
    step_exec.signed_off_at = datetime.now(UTC)
    step_exec.signed_off_by_id = user_id

    # Track old status to detect completion
    old_instance_status = (
        instance.status.value if hasattr(instance.status, "value") else instance.status
    )

    # Check if procedure is complete
    check_instance_completion(db, instance)

    # If this signoff terminates a redline step, re-evaluate the held host
    # step's auto-resume — it may now be unblocked.
    if step_exec.ad_hoc_issue_id is not None:
        redline_issue = (
            db.query(Issue)
            .filter(Issue.id == step_exec.ad_hoc_issue_id, Issue.deleted_at.is_(None))
            .first()
        )
        if redline_issue is not None:
            maybe_resume_step_after_nc_update(db, redline_issue, user_id)

    db.commit()
    db.refresh(step_exec)
    db.refresh(instance)

    # Check if instance just completed
    new_instance_status = (
        instance.status.value if hasattr(instance.status, "value") else instance.status
    )
    if (
        old_instance_status != InstanceStatus.COMPLETED.value
        and new_instance_status == InstanceStatus.COMPLETED.value
    ):
        await emit_instance_completed(instance_id, instance.procedure_id, new_instance_status)

    return StepExecutionResponse(
        id=step_exec.id,
        step_number=step_exec.step_number,
        step_number_str=step_exec.step_number_str,
        level=step_exec.level,
        parent_step_order=step_exec.parent_step_order,
        status=step_exec.status.value if hasattr(step_exec.status, "value") else step_exec.status,
        data_captured=step_exec.data_captured,
        started_at=step_exec.started_at,
        completed_at=step_exec.completed_at,
        completed_by_id=step_exec.completed_by_id,
        signed_off_at=step_exec.signed_off_at,
        notes=step_exec.notes,
        signed_off_by_id=step_exec.signed_off_by_id,
        duration_seconds=step_exec.duration_seconds,
    )


@router.post("/{instance_id}/steps/{step_number}/nc", status_code=201)
def log_non_conformance(
    instance_id: int,
    step_number: int,
    data: NonConformanceCreate,
    db: DbSession,
    user_id: CurrentUserId,
) -> dict:
    """Log a non-conformance during step execution, creates an Issue."""
    instance = db.query(ProcedureInstance).filter(ProcedureInstance.id == instance_id).first()
    if not instance:
        raise HTTPException(status_code=404, detail="Instance not found")

    step_exec = (
        db.query(StepExecution)
        .filter(StepExecution.instance_id == instance_id, StepExecution.step_number == step_number)
        .first()
    )
    if not step_exec:
        raise HTTPException(status_code=404, detail="Step not found")

    # Create issue
    try:
        priority = IssuePriority(data.priority)
    except ValueError:
        priority = IssuePriority.MEDIUM

    if data.containment not in ("step", "advisory"):
        raise HTTPException(status_code=400, detail=f"Invalid containment: {data.containment}")
    holds_step = data.containment == "step"

    issue = Issue(
        issue_number=generate_issue_number(db),
        title=data.title,
        description=data.description,
        should_be=data.should_be,
        is_condition=data.is_condition,
        issue_type=IssueType.NON_CONFORMANCE,
        status=IssueStatus.OPEN,
        priority=priority,
        procedure_id=instance.procedure_id,
        procedure_instance_id=instance_id,
        # Advisory anomalies record the WO link only — a step binding would
        # derive a hold (the binding IS the containment fact).
        step_execution_id=step_exec.id if holds_step else None,
    )
    db.add(issue)
    db.flush()

    log_create(db, issue, user_id)

    if holds_step:
        # Put the step on hold until the NC disposition is approved or the
        # issue closed.
        step_status_now = (
            step_exec.status.value if hasattr(step_exec.status, "value") else step_exec.status
        )
        if step_status_now != StepStatus.ON_HOLD.value:
            step_old = get_model_dict(step_exec)
            step_exec.status = StepStatus.ON_HOLD
            log_update(db, step_exec, step_old, user_id)

        # Propagate hold to the parent op so the whole operation stalls — not
        # just the offending sub-step. Other sub-steps in the same op must not
        # be startable while an NC is open anywhere inside it.
        if step_exec.level > 0 and step_exec.parent_step_order is not None:
            parent_exec = (
                db.query(StepExecution)
                .filter(
                    StepExecution.instance_id == instance_id,
                    StepExecution.step_number == step_exec.parent_step_order,
                    StepExecution.level == 0,
                )
                .first()
            )
            if parent_exec is not None:
                parent_status = (
                    parent_exec.status.value
                    if hasattr(parent_exec.status, "value")
                    else parent_exec.status
                )
                if parent_status != StepStatus.ON_HOLD.value:
                    parent_old = get_model_dict(parent_exec)
                    parent_exec.status = StepStatus.ON_HOLD
                    log_update(db, parent_exec, parent_old, user_id)

    # Bind hold points: the named steps cannot COMPLETE while this issue is
    # undispositioned.
    from opal.db.models.issue import IssueStepBlock

    bound_numbers: list[str] = []
    for block_order in dict.fromkeys(data.blocks_step_numbers):
        target = (
            db.query(StepExecution)
            .filter(
                StepExecution.instance_id == instance_id,
                StepExecution.step_number == block_order,
            )
            .first()
        )
        if target is None:
            raise HTTPException(status_code=404, detail=f"Blocked step {block_order} not found")
        block = IssueStepBlock(issue_id=issue.id, step_execution_id=target.id)
        db.add(block)
        db.flush()
        log_create(db, block, user_id)
        bound_numbers.append(target.step_number_str or str(target.step_number))

    db.commit()
    db.refresh(issue)

    return {
        "id": issue.id,
        "issue_number": issue.issue_number,
        "title": issue.title,
        "issue_type": issue.issue_type.value
        if hasattr(issue.issue_type, "value")
        else issue.issue_type,
        "status": issue.status.value if hasattr(issue.status, "value") else issue.status,
        "priority": issue.priority.value if hasattr(issue.priority, "value") else issue.priority,
        "containment": data.containment,
        "blocks": bound_numbers,
        "procedure_instance_id": instance_id,
        "step_number": step_number,
    }


@router.get("/{instance_id}/version-content")
def get_instance_version_content(
    instance_id: int,
    db: DbSession,
) -> dict:
    """Get the version content (steps) for an instance."""
    instance = db.query(ProcedureInstance).filter(ProcedureInstance.id == instance_id).first()
    if not instance:
        raise HTTPException(status_code=404, detail="Instance not found")

    version = db.query(ProcedureVersion).filter(ProcedureVersion.id == instance.version_id).first()
    if not version:
        raise HTTPException(status_code=404, detail="Version not found")

    return version.content


# ============ Kit and Consumption ============


class KitAvailabilityItem(BaseModel):
    """Kit item availability check."""

    part_id: int
    part_name: str
    quantity_required: float
    quantity_available: float
    is_available: bool
    available_locations: list[dict]


class KitAvailabilityResponse(BaseModel):
    """Kit availability response."""

    procedure_id: int
    all_available: bool
    items: list[KitAvailabilityItem]


class ConsumptionItem(BaseModel):
    """Single item to consume."""

    inventory_record_id: int
    quantity: float


class ConsumeKitRequest(BaseModel):
    """Request to consume kit parts."""

    items: list[ConsumptionItem]
    notes: str | None = None


class ConsumptionResponse(BaseModel):
    """Consumption record response."""

    id: int
    part_id: int
    part_name: str
    quantity: float
    location: str
    lot_number: str | None


@router.get("/{instance_id}/kit-availability", response_model=KitAvailabilityResponse)
def check_kit_availability(
    instance_id: int,
    db: DbSession,
) -> KitAvailabilityResponse:
    """Check if kit parts are available in inventory for this procedure.

    Returns availability status for each kit item with available locations.
    """
    instance = db.query(ProcedureInstance).filter(ProcedureInstance.id == instance_id).first()
    if not instance:
        raise HTTPException(status_code=404, detail="Instance not found")

    # Get kit for this procedure
    kit_items = db.query(Kit).filter(Kit.procedure_id == instance.procedure_id).all()

    items = []
    all_available = True

    for kit_item in kit_items:
        # Get all inventory records for this part
        inv_records = (
            db.query(InventoryRecord)
            .filter(InventoryRecord.part_id == kit_item.part_id, InventoryRecord.quantity > 0)
            .all()
        )

        total_available = sum(float(r.quantity) for r in inv_records)
        qty_required = float(kit_item.quantity_required)
        is_available = total_available >= qty_required

        if not is_available:
            all_available = False

        items.append(
            KitAvailabilityItem(
                part_id=kit_item.part_id,
                part_name=kit_item.part.name,
                quantity_required=qty_required,
                quantity_available=total_available,
                is_available=is_available,
                available_locations=[
                    {
                        "inventory_record_id": r.id,
                        "location": r.location,
                        "lot_number": r.lot_number,
                        "quantity": float(r.quantity),
                    }
                    for r in inv_records
                ],
            )
        )

    return KitAvailabilityResponse(
        procedure_id=instance.procedure_id,
        all_available=all_available,
        items=items,
    )


@router.post("/{instance_id}/consume", response_model=list[ConsumptionResponse])
def consume_kit(
    instance_id: int,
    data: ConsumeKitRequest,
    db: DbSession,
    user_id: CurrentUserId,
) -> list[ConsumptionResponse]:
    """Consume parts from inventory for this procedure instance.

    This should be called after procedure completion to deduct parts from inventory.
    Creates traceability records linking consumed parts to the procedure.
    """
    instance = db.query(ProcedureInstance).filter(ProcedureInstance.id == instance_id).first()
    if not instance:
        raise HTTPException(status_code=404, detail="Instance not found")

    consumptions = []

    for item in data.items:
        inv_record = (
            db.query(InventoryRecord).filter(InventoryRecord.id == item.inventory_record_id).first()
        )
        if not inv_record:
            raise HTTPException(
                status_code=404,
                detail=f"Inventory record {item.inventory_record_id} not found",
            )

        if float(inv_record.quantity) < item.quantity:
            raise HTTPException(
                status_code=400,
                detail=f"Insufficient quantity at {inv_record.location} (have {inv_record.quantity}, need {item.quantity})",
            )

        # Defense-in-depth: inventory only exists for active parts, but a
        # consumption must never reference a draft
        ensure_parts_active(db, [inv_record.part_id], "procedure consumption")

        # Deduct from inventory; SQL-side expression so concurrent
        # consumptions cannot lose updates via read-modify-write
        inv_record.quantity = InventoryRecord.quantity - Decimal(str(item.quantity))

        # Create consumption record
        consumption = InventoryConsumption(
            inventory_record_id=inv_record.id,
            quantity=item.quantity,
            consumption_type=ConsumptionType.PROCEDURE,
            procedure_instance_id=instance_id,
            notes=data.notes,
            consumed_by_id=user_id,
        )
        db.add(consumption)
        db.flush()

        consumptions.append(
            ConsumptionResponse(
                id=consumption.id,
                part_id=inv_record.part_id,
                part_name=inv_record.part.name,
                quantity=item.quantity,
                location=inv_record.location,
                lot_number=inv_record.lot_number,
            )
        )

    db.commit()

    return consumptions


class StepConsumeItem(BaseModel):
    """Single step consumption item."""

    inventory_record_id: int
    quantity: float = Field(..., gt=0)
    usage_type: str = "consume"  # "consume" or "tooling"


class StepConsumeRequest(BaseModel):
    """Request to consume parts at a specific step."""

    items: list[StepConsumeItem]
    notes: str | None = None


@router.post("/{instance_id}/steps/{step_number}/consume", response_model=list[ConsumptionResponse])
def consume_step_parts(
    instance_id: int,
    step_number: int,
    data: StepConsumeRequest,
    db: DbSession,
    user_id: CurrentUserId,
) -> list[ConsumptionResponse]:
    """Consume parts at a specific step during execution.

    This allows tracking which parts were used at which step for traceability.
    Usage types:
    - consume: Part is installed/used up (decrements inventory)
    - tooling: Part is GSE/fixture (tracked but not decremented)
    """
    instance = db.query(ProcedureInstance).filter(ProcedureInstance.id == instance_id).first()
    if not instance:
        raise HTTPException(status_code=404, detail="Instance not found")

    step_exec = (
        db.query(StepExecution)
        .filter(StepExecution.instance_id == instance_id, StepExecution.step_number == step_number)
        .first()
    )
    if not step_exec:
        raise HTTPException(status_code=404, detail="Step not found")

    consumptions = []

    for item in data.items:
        inv_record = (
            db.query(InventoryRecord).filter(InventoryRecord.id == item.inventory_record_id).first()
        )
        if not inv_record:
            raise HTTPException(
                status_code=404,
                detail=f"Inventory record {item.inventory_record_id} not found",
            )

        # Validate usage type
        try:
            usage = UsageType(item.usage_type)
        except ValueError as err:
            raise HTTPException(
                status_code=400, detail=f"Invalid usage type: {item.usage_type}"
            ) from err

        # Defense-in-depth: inventory only exists for active parts, but a
        # consumption must never reference a draft
        ensure_parts_active(db, [inv_record.part_id], "step consumption")

        # Only deduct from inventory if consume type (not tooling)
        if usage == UsageType.CONSUME:
            if float(inv_record.quantity) < item.quantity:
                raise HTTPException(
                    status_code=400,
                    detail=f"Insufficient quantity at {inv_record.location} (have {inv_record.quantity}, need {item.quantity})",
                )
            # SQL-side decrement avoids lost updates under concurrency
            inv_record.quantity = InventoryRecord.quantity - Decimal(str(item.quantity))

        # Create consumption record linked to step
        consumption = InventoryConsumption(
            inventory_record_id=inv_record.id,
            quantity=item.quantity,
            consumption_type=ConsumptionType.PROCEDURE,
            usage_type=usage,
            procedure_instance_id=instance_id,
            step_execution_id=step_exec.id,
            notes=data.notes,
            consumed_by_id=user_id,
        )
        db.add(consumption)
        db.flush()

        consumptions.append(
            ConsumptionResponse(
                id=consumption.id,
                part_id=inv_record.part_id,
                part_name=inv_record.part.name,
                quantity=item.quantity,
                location=inv_record.location,
                lot_number=inv_record.lot_number,
            )
        )

    db.commit()

    return consumptions


@router.get(
    "/{instance_id}/steps/{step_number}/consumptions", response_model=list[ConsumptionResponse]
)
def get_step_consumptions(
    instance_id: int,
    step_number: int,
    db: DbSession,
) -> list[ConsumptionResponse]:
    """Get all consumptions for a specific step."""
    step_exec = (
        db.query(StepExecution)
        .filter(StepExecution.instance_id == instance_id, StepExecution.step_number == step_number)
        .first()
    )
    if not step_exec:
        raise HTTPException(status_code=404, detail="Step not found")

    consumptions = (
        db.query(InventoryConsumption)
        .filter(InventoryConsumption.step_execution_id == step_exec.id)
        .all()
    )

    return [
        ConsumptionResponse(
            id=c.id,
            part_id=c.inventory_record.part_id,
            part_name=c.inventory_record.part.name,
            quantity=float(c.quantity),
            location=c.inventory_record.location,
            lot_number=c.inventory_record.lot_number,
        )
        for c in consumptions
    ]


@router.get("/{instance_id}/consumptions", response_model=list[ConsumptionResponse])
def get_consumptions(
    instance_id: int,
    db: DbSession,
) -> list[ConsumptionResponse]:
    """Get all consumption records for this procedure instance."""
    instance = db.query(ProcedureInstance).filter(ProcedureInstance.id == instance_id).first()
    if not instance:
        raise HTTPException(status_code=404, detail="Instance not found")

    consumptions = (
        db.query(InventoryConsumption)
        .filter(InventoryConsumption.procedure_instance_id == instance_id)
        .all()
    )

    return [
        ConsumptionResponse(
            id=c.id,
            part_id=c.inventory_record.part_id,
            part_name=c.inventory_record.part.name,
            quantity=float(c.quantity),
            location=c.inventory_record.location,
            lot_number=c.inventory_record.lot_number,
        )
        for c in consumptions
    ]


# ============ Production (Assembly Output) ============


class OutputItem(BaseModel):
    """Procedure output definition."""

    part_id: int
    part_name: str
    quantity_produced: float


class ProduceItem(BaseModel):
    """Single item to produce."""

    part_id: int
    quantity: float
    location: str
    lot_number: str | None = None
    serial_number: str | None = None


class ProduceRequest(BaseModel):
    """Request to produce output items."""

    items: list[ProduceItem]
    notes: str | None = None


class ProductionResponse(BaseModel):
    """Production record response."""

    id: int
    part_id: int
    part_name: str
    quantity: float
    location: str
    lot_number: str | None
    serial_number: str | None


@router.get("/{instance_id}/outputs", response_model=list[OutputItem])
def get_procedure_outputs(
    instance_id: int,
    db: DbSession,
) -> list[OutputItem]:
    """Get the expected outputs for this procedure."""
    instance = db.query(ProcedureInstance).filter(ProcedureInstance.id == instance_id).first()
    if not instance:
        raise HTTPException(status_code=404, detail="Instance not found")

    outputs = (
        db.query(ProcedureOutput)
        .filter(ProcedureOutput.procedure_id == instance.procedure_id)
        .all()
    )

    return [
        OutputItem(
            part_id=o.part_id,
            part_name=o.part.name,
            quantity_produced=float(o.quantity_produced),
        )
        for o in outputs
    ]


@router.post("/{instance_id}/produce", response_model=list[ProductionResponse])
def produce_output(
    instance_id: int,
    data: ProduceRequest,
    db: DbSession,
    user_id: CurrentUserId,
) -> list[ProductionResponse]:
    """Produce output items (assemblies) from this procedure instance.

    Creates inventory records for the produced items and links them to this instance.
    """
    instance = db.query(ProcedureInstance).filter(ProcedureInstance.id == instance_id).first()
    if not instance:
        raise HTTPException(status_code=404, detail="Instance not found")

    productions = []

    for item in data.items:
        part = db.query(Part).filter(Part.id == item.part_id).first()
        if not part:
            raise HTTPException(status_code=404, detail=f"Part {item.part_id} not found")

        # A produced as-built instance is a physical reference — draft
        # parts block it (raises DraftPartsBlocked -> 409)
        ensure_parts_active(db, [item.part_id], "production output (as-built)")

        opal_num = generate_opal_number(db)

        # Always create a new inventory record for produced items (unique OPAL number)
        inv_record = InventoryRecord(
            part_id=item.part_id,
            quantity=item.quantity,
            location=item.location,
            lot_number=item.lot_number,
            opal_number=opal_num,
            source_type=SourceType.PRODUCTION,
        )
        db.add(inv_record)
        db.flush()

        # Create production record
        production = InventoryProduction(
            inventory_record_id=inv_record.id,
            quantity=item.quantity,
            procedure_instance_id=instance_id,
            serial_number=item.serial_number,
            produced_opal_number=opal_num,
            status=ProductionStatus.COMPLETED,
            notes=data.notes,
            produced_by_id=user_id,
        )
        db.add(production)
        db.flush()

        # Link inventory record to its production
        inv_record.source_production_id = production.id

        log_create(db, production, user_id)

        productions.append(
            ProductionResponse(
                id=production.id,
                part_id=item.part_id,
                part_name=part.name,
                quantity=item.quantity,
                location=item.location,
                lot_number=item.lot_number,
                serial_number=item.serial_number,
            )
        )

    db.commit()

    return productions


@router.get("/{instance_id}/productions", response_model=list[ProductionResponse])
def get_productions(
    instance_id: int,
    db: DbSession,
) -> list[ProductionResponse]:
    """Get all production records for this procedure instance."""
    instance = db.query(ProcedureInstance).filter(ProcedureInstance.id == instance_id).first()
    if not instance:
        raise HTTPException(status_code=404, detail="Instance not found")

    productions = (
        db.query(InventoryProduction)
        .filter(InventoryProduction.procedure_instance_id == instance_id)
        .all()
    )

    return [
        ProductionResponse(
            id=p.id,
            part_id=p.inventory_record.part_id,
            part_name=p.inventory_record.part.name,
            quantity=float(p.quantity),
            location=p.inventory_record.location,
            lot_number=p.inventory_record.lot_number,
            serial_number=p.serial_number,
        )
        for p in productions
    ]


# ============ BOM Reconciliation & Finalization ============


class BOMKitItem(BaseModel):
    """Kit vs actual consumption comparison."""

    part_id: int
    part_name: str
    qty_required: float
    qty_consumed: float
    variance: float


class BOMUnplannedItem(BaseModel):
    """Consumption not in the original kit."""

    part_id: int
    part_name: str
    qty_consumed: float


class BOMOutputItem(BaseModel):
    """Planned output status."""

    part_id: int
    part_name: str
    serial_number: str | None
    opal_number: str | None
    quantity: float
    status: str


class BOMReconciliationResponse(BaseModel):
    """BOM reconciliation comparison."""

    kit_items: list[BOMKitItem]
    unplanned_consumptions: list[BOMUnplannedItem]
    outputs: list[BOMOutputItem]


class FinalizeRequest(BaseModel):
    """Request to finalize production after execution."""

    location: str = Field(..., min_length=1, description="Where the produced assembly is stored")
    notes: str | None = None


@router.get("/{instance_id}/bom-reconciliation", response_model=BOMReconciliationResponse)
def get_bom_reconciliation(
    instance_id: int,
    db: DbSession,
) -> BOMReconciliationResponse:
    """Get BOM reconciliation: kit (expected) vs actual consumptions."""
    instance = db.query(ProcedureInstance).filter(ProcedureInstance.id == instance_id).first()
    if not instance:
        raise HTTPException(status_code=404, detail="Instance not found")

    return _build_bom_reconciliation(db, instance)


def _build_bom_reconciliation(db, instance) -> BOMReconciliationResponse:
    """Build BOM reconciliation data for an instance."""
    # Get kit (expected) parts
    kit_items = db.query(Kit).filter(Kit.procedure_id == instance.procedure_id).all()
    kit_by_part: dict[int, float] = {k.part_id: float(k.quantity_required) for k in kit_items}
    kit_part_names: dict[int, str] = {k.part_id: k.part.name for k in kit_items}

    # Get actual consumptions (only CONSUME type, not tooling)
    consumptions = (
        db.query(InventoryConsumption)
        .filter(
            InventoryConsumption.procedure_instance_id == instance.id,
            InventoryConsumption.usage_type == UsageType.CONSUME,
        )
        .all()
    )

    # Aggregate consumed quantities by part
    consumed_by_part: dict[int, float] = {}
    consumed_part_names: dict[int, str] = {}
    for c in consumptions:
        pid = c.inventory_record.part_id
        consumed_by_part[pid] = consumed_by_part.get(pid, 0) + float(c.quantity)
        consumed_part_names[pid] = c.inventory_record.part.name

    # Build kit comparison
    bom_kit_items = []
    for part_id, qty_required in kit_by_part.items():
        qty_consumed = consumed_by_part.pop(part_id, 0)
        bom_kit_items.append(
            BOMKitItem(
                part_id=part_id,
                part_name=kit_part_names[part_id],
                qty_required=qty_required,
                qty_consumed=qty_consumed,
                variance=qty_consumed - qty_required,
            )
        )

    # Remaining consumed parts not in kit
    unplanned = [
        BOMUnplannedItem(
            part_id=pid,
            part_name=consumed_part_names.get(pid, "Unknown"),
            qty_consumed=qty,
        )
        for pid, qty in consumed_by_part.items()
    ]

    # Get production outputs
    productions = (
        db.query(InventoryProduction)
        .filter(InventoryProduction.procedure_instance_id == instance.id)
        .all()
    )
    outputs = []
    for p in productions:
        prod_status = p.status.value if hasattr(p.status, "value") else p.status
        outputs.append(
            BOMOutputItem(
                part_id=p.inventory_record.part_id,
                part_name=p.inventory_record.part.name,
                serial_number=p.serial_number,
                opal_number=p.produced_opal_number,
                quantity=float(p.quantity),
                status=prod_status,
            )
        )

    return BOMReconciliationResponse(
        kit_items=bom_kit_items,
        unplanned_consumptions=unplanned,
        outputs=outputs,
    )


@router.post("/{instance_id}/finalize", status_code=200)
def finalize_production(
    instance_id: int,
    data: FinalizeRequest,
    db: DbSession,
    user_id: CurrentUserId,
) -> dict:
    """Finalize production after execution is complete.

    Sets production records to COMPLETED, assigns quantity and location
    to inventory records, and records assembly genealogy.
    """
    instance = db.query(ProcedureInstance).filter(ProcedureInstance.id == instance_id).first()
    if not instance:
        raise HTTPException(status_code=404, detail="Instance not found")

    inst_status = instance.status.value if hasattr(instance.status, "value") else instance.status
    if inst_status != InstanceStatus.COMPLETED.value:
        raise HTTPException(
            status_code=400, detail="Instance must be COMPLETED before finalizing production"
        )

    # Get WIP production records for this instance
    productions = (
        db.query(InventoryProduction)
        .filter(
            InventoryProduction.procedure_instance_id == instance_id,
            InventoryProduction.status == ProductionStatus.WIP,
        )
        .all()
    )

    if not productions:
        raise HTTPException(status_code=400, detail="No WIP production records to finalize")

    # Get all CONSUME-type consumption records for genealogy
    consumption_ids = [
        c.id
        for c in db.query(InventoryConsumption)
        .filter(
            InventoryConsumption.procedure_instance_id == instance_id,
            InventoryConsumption.usage_type == UsageType.CONSUME,
        )
        .all()
    ]

    finalized = []
    for production in productions:
        old_values = get_model_dict(production)

        production.status = ProductionStatus.COMPLETED

        # Update inventory record with actual quantity and location
        inv_record = production.inventory_record
        inv_record.quantity = production.quantity
        inv_record.location = data.location

        log_update(db, production, old_values, user_id)

        # Record assembly genealogy
        if consumption_ids:
            record_assembly_genealogy(db, production.id, consumption_ids)

        finalized.append(
            {
                "production_id": production.id,
                "opal_number": production.produced_opal_number,
                "serial_number": production.serial_number,
                "part_name": inv_record.part.name,
                "quantity": float(production.quantity),
                "location": data.location,
            }
        )

    db.commit()

    return {
        "status": "finalized",
        "instance_id": instance_id,
        "productions": finalized,
    }


# ============ Collaboration (Multi-user Execution) ============


class ParticipantInfo(BaseModel):
    """Participant in an execution."""

    user_id: int
    user_name: str
    joined_at: str
    last_step: int | None = None
    is_active: bool = True


class ParticipantsResponse(BaseModel):
    """Response for execution participants."""

    instance_id: int
    participants: list[ParticipantInfo]


@router.post("/{instance_id}/join", response_model=ParticipantsResponse)
async def join_execution(
    instance_id: int,
    db: DbSession,
    user_id: CurrentUserId,
) -> ParticipantsResponse:
    """Join an execution as a participant.

    This allows multiple users to collaborate on the same procedure execution.
    """
    instance = db.query(ProcedureInstance).filter(ProcedureInstance.id == instance_id).first()
    if not instance:
        raise HTTPException(status_code=404, detail="Instance not found")

    # Get user info
    from opal.db.models import User

    user = db.query(User).filter(User.id == user_id).first()
    if not user:
        raise HTTPException(status_code=404, detail="User not found")

    # Initialize participants if None
    participants = instance.participants or []

    # Check if already a participant
    existing = next((p for p in participants if p.get("user_id") == user_id), None)
    if existing:
        # Update last seen, already joined
        existing["last_active"] = datetime.now(UTC).isoformat()
    else:
        # Add new participant
        participants.append(
            {
                "user_id": user_id,
                "user_name": user.name,
                "joined_at": datetime.now(UTC).isoformat(),
                "last_step": None,
            }
        )

    instance.participants = participants
    db.commit()
    db.refresh(instance)

    # Emit user joined event (only if newly joined)
    if not existing:
        await emit_user_joined(instance_id, user_id, user.name)

    return ParticipantsResponse(
        instance_id=instance.id,
        participants=[
            ParticipantInfo(
                user_id=p["user_id"],
                user_name=p.get("user_name", "Unknown"),
                joined_at=p["joined_at"],
                last_step=p.get("last_step"),
                is_active=True,
            )
            for p in (instance.participants or [])
        ],
    )


@router.post("/{instance_id}/leave")
async def leave_execution(
    instance_id: int,
    db: DbSession,
    user_id: CurrentUserId,
) -> dict:
    """Leave an execution (stop participating)."""
    instance = db.query(ProcedureInstance).filter(ProcedureInstance.id == instance_id).first()
    if not instance:
        raise HTTPException(status_code=404, detail="Instance not found")

    participants = instance.participants or []

    # Find the leaving user's name before removing
    leaving_user = next((p for p in participants if p.get("user_id") == user_id), None)
    user_name = leaving_user.get("user_name", "Unknown") if leaving_user else "Unknown"

    # Remove user from participants and drop their cursor
    instance.participants = [p for p in participants if p.get("user_id") != user_id]
    clear_focus(db, instance_id, user_id)
    db.commit()

    # Emit user left event
    if leaving_user:
        await emit_user_left(instance_id, user_id, user_name)

    return {"status": "left", "instance_id": instance_id}


@router.get("/{instance_id}/participants", response_model=ParticipantsResponse)
def get_participants(
    instance_id: int,
    db: DbSession,
) -> ParticipantsResponse:
    """Get current participants in an execution."""
    instance = db.query(ProcedureInstance).filter(ProcedureInstance.id == instance_id).first()
    if not instance:
        raise HTTPException(status_code=404, detail="Instance not found")

    return ParticipantsResponse(
        instance_id=instance.id,
        participants=[
            ParticipantInfo(
                user_id=p["user_id"],
                user_name=p.get("user_name", "Unknown"),
                joined_at=p["joined_at"],
                last_step=p.get("last_step"),
                is_active=True,
            )
            for p in (instance.participants or [])
        ],
    )


# ============ Redline / ad-hoc operations ============


class AdHocSubStepInput(BaseModel):
    """A single sub-step on a new redline op."""

    title: str = Field(..., min_length=1, max_length=255)
    instructions: str | None = None
    required_data_schema: dict[str, Any] | None = None
    requires_signoff: bool = False


class AdHocOpCreate(BaseModel):
    """Payload to create a redline op against a held NC."""

    issue_id: int
    title: str = Field(..., min_length=1, max_length=255)
    steps: list[AdHocSubStepInput] = Field(..., min_length=1)


class AdHocOpResponse(BaseModel):
    """A redline op (level=0 StepExecution row) with its sub-steps."""

    id: int
    instance_id: int
    issue_id: int
    issue_number: str | None
    host_order: int
    step_number: int
    step_number_str: str
    title: str
    status: str
    created_at: str
    sub_steps: list[StepExecutionResponse]


def _redline_op_response(db, op_row: StepExecution) -> AdHocOpResponse:
    """Bundle a redline op with its sub-steps for API output."""
    sub_rows = (
        db.query(StepExecution)
        .filter(
            StepExecution.instance_id == op_row.instance_id,
            StepExecution.parent_step_order == op_row.step_number,
        )
        .order_by(StepExecution.step_number)
        .all()
    )
    issue_number: str | None = None
    if op_row.ad_hoc_issue_id:
        issue = db.query(Issue).filter(Issue.id == op_row.ad_hoc_issue_id).first()
        if issue:
            issue_number = issue.issue_number
    return AdHocOpResponse(
        id=op_row.id,
        instance_id=op_row.instance_id,
        issue_id=op_row.ad_hoc_issue_id or 0,
        issue_number=issue_number,
        host_order=op_row.ad_hoc_host_order or 0,
        step_number=op_row.step_number,
        step_number_str=op_row.step_number_str,
        title=op_row.title or "",
        status=op_row.status.value if hasattr(op_row.status, "value") else op_row.status,
        created_at=op_row.created_at.isoformat() if op_row.created_at else "",
        sub_steps=[
            StepExecutionResponse(
                id=s.id,
                step_number=s.step_number,
                step_number_str=s.step_number_str,
                level=s.level,
                parent_step_order=s.parent_step_order,
                status=s.status.value if hasattr(s.status, "value") else s.status,
                data_captured=s.data_captured,
                started_at=s.started_at,
                completed_at=s.completed_at,
                completed_by_id=s.completed_by_id,
                notes=s.notes,
                signed_off_at=s.signed_off_at,
                signed_off_by_id=s.signed_off_by_id,
                duration_seconds=s.duration_seconds,
            )
            for s in sub_rows
        ],
    )


@router.post(
    "/{instance_id}/ad-hoc-ops",
    response_model=AdHocOpResponse,
    status_code=201,
)
def create_ad_hoc_op(
    instance_id: int,
    payload: AdHocOpCreate,
    db: DbSession,
    user_id: CurrentUserId,
) -> AdHocOpResponse:
    """Insert a redline / ad-hoc operation into a running execution as part of
    an NC. The redline gates the host op and rides the NC's disposition for
    auto-resume."""
    instance = db.query(ProcedureInstance).filter(ProcedureInstance.id == instance_id).first()
    if not instance:
        raise HTTPException(status_code=404, detail="Instance not found")

    issue = db.query(Issue).filter(Issue.id == payload.issue_id, Issue.deleted_at.is_(None)).first()
    if not issue:
        raise HTTPException(status_code=404, detail="Issue not found")
    issue_type = issue.issue_type.value if hasattr(issue.issue_type, "value") else issue.issue_type
    if issue_type != IssueType.NON_CONFORMANCE.value:
        raise HTTPException(status_code=400, detail="Redlines can only be attached to an NC")
    if issue.step_execution_id is None:
        raise HTTPException(
            status_code=400, detail="NC is not attached to a step; cannot create redline"
        )

    host_exec = db.get(StepExecution, issue.step_execution_id)
    if not host_exec or host_exec.instance_id != instance.id:
        raise HTTPException(status_code=400, detail="NC does not belong to this execution")

    # Host order is the snapshot order of the held op. If the NC was logged on
    # a sub-step, gate against its parent op (the level-0 ancestor).
    if host_exec.level == 0:
        host_order = host_exec.step_number
        host_number_str = host_exec.step_number_str
    else:
        if host_exec.parent_step_order is None:
            raise HTTPException(
                status_code=400, detail="Host step has no parent op to attach the redline to"
            )
        host_order = host_exec.parent_step_order
        parent_exec = next(
            (
                se
                for se in instance.step_executions
                if se.step_number == host_order and se.level == 0
            ),
            None,
        )
        host_number_str = parent_exec.step_number_str if parent_exec else str(host_order)

    existing_redlines = (
        db.query(StepExecution)
        .filter(
            StepExecution.instance_id == instance.id,
            StepExecution.ad_hoc_host_order == host_order,
            StepExecution.level == 0,
        )
        .count()
    )
    redline_seq = existing_redlines + 1
    op_number_str = f"{host_number_str}R{redline_seq}"

    max_step_number = (
        db.query(StepExecution.step_number)
        .filter(StepExecution.instance_id == instance.id)
        .order_by(StepExecution.step_number.desc())
        .limit(1)
        .scalar()
    ) or 0
    op_step_number = max_step_number + 1

    op_row = StepExecution(
        instance_id=instance.id,
        step_number=op_step_number,
        step_number_str=op_number_str,
        level=0,
        parent_step_order=None,
        status=StepStatus.PENDING,
        title=payload.title.strip(),
        ad_hoc_issue_id=issue.id,
        ad_hoc_host_order=host_order,
        requires_signoff=False,
    )
    db.add(op_row)
    db.flush()
    log_create(db, op_row, user_id)

    for idx, sub in enumerate(payload.steps, start=1):
        sub_row = StepExecution(
            instance_id=instance.id,
            step_number=op_step_number + idx,
            step_number_str=f"{op_number_str}.{idx}",
            level=1,
            parent_step_order=op_step_number,
            status=StepStatus.PENDING,
            title=sub.title.strip(),
            instructions=sub.instructions,
            required_data_schema=sub.required_data_schema,
            requires_signoff=sub.requires_signoff,
            ad_hoc_issue_id=issue.id,
            ad_hoc_host_order=host_order,
        )
        db.add(sub_row)
        db.flush()
        log_create(db, sub_row, user_id)

    db.commit()
    db.refresh(op_row)
    return _redline_op_response(db, op_row)


@router.get("/{instance_id}/ad-hoc-ops", response_model=list[AdHocOpResponse])
def list_ad_hoc_ops(
    instance_id: int,
    db: DbSession,
) -> list[AdHocOpResponse]:
    """List redline ops on this execution."""
    instance = db.query(ProcedureInstance).filter(ProcedureInstance.id == instance_id).first()
    if not instance:
        raise HTTPException(status_code=404, detail="Instance not found")

    ops = (
        db.query(StepExecution)
        .filter(
            StepExecution.instance_id == instance_id,
            StepExecution.ad_hoc_issue_id.is_not(None),
            StepExecution.level == 0,
        )
        .order_by(StepExecution.ad_hoc_host_order, StepExecution.step_number)
        .all()
    )
    return [_redline_op_response(db, o) for o in ops]


@router.delete("/{instance_id}/ad-hoc-ops/{op_id}", status_code=204)
def delete_ad_hoc_op(
    instance_id: int,
    op_id: int,
    db: DbSession,
    user_id: CurrentUserId,
) -> None:
    """Delete a redline op and its sub-steps. Allowed only if no sub-step has
    been started yet."""
    op_row = (
        db.query(StepExecution)
        .filter(
            StepExecution.id == op_id,
            StepExecution.instance_id == instance_id,
            StepExecution.ad_hoc_issue_id.is_not(None),
            StepExecution.level == 0,
        )
        .first()
    )
    if not op_row:
        raise HTTPException(status_code=404, detail="Redline op not found")

    sub_rows = (
        db.query(StepExecution)
        .filter(
            StepExecution.instance_id == instance_id,
            StepExecution.parent_step_order == op_row.step_number,
        )
        .all()
    )
    started = [
        s
        for s in sub_rows
        if (s.status.value if hasattr(s.status, "value") else s.status) != StepStatus.PENDING.value
    ]
    if started:
        raise HTTPException(
            status_code=400,
            detail="Cannot delete redline op: one or more sub-steps already started",
        )
    op_status = op_row.status.value if hasattr(op_row.status, "value") else op_row.status
    if op_status != StepStatus.PENDING.value:
        raise HTTPException(
            status_code=400,
            detail="Cannot delete redline op: op is no longer pending",
        )

    for s in sub_rows:
        db.delete(s)
    db.delete(op_row)
    db.commit()
