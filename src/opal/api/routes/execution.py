"""Execution API routes - procedure instances and step execution."""

from datetime import UTC, datetime
from decimal import Decimal
from typing import Any

from fastapi import APIRouter, HTTPException, Query, Request
from fastapi.responses import Response
from pydantic import BaseModel, Field
from sqlalchemy import exists, func, or_
from sqlalchemy.orm import joinedload, selectinload

from opal.api.deps import CurrentUserId, DbSession
from opal.core.audit import get_model_dict, log_create, log_update
from opal.core.designators import (
    generate_issue_number,
    generate_opal_number,
    generate_serial_number,
    generate_work_order_number,
    peek_serial_numbers,
)
from opal.core.events import (
    emit_cursor_moved,
    emit_instance_completed,
    emit_instance_started,
    emit_step_completed,
    emit_user_joined,
    emit_user_left,
)
from opal.core.execution_document import build_execution_document
from opal.core.execution_flow import (
    FlowError,
    add_step_note,
    build_execution_state,
    check_instance_completion,
    claim_op,
    claims_for_instances,
    clear_focus,
    complete_step_flow,
    focus_step,
    mark_instance_in_work,
    row_has_children,
    sequence_blockers,
    sign_step_flow,
    signoff_step_flow,
    skip_blockers,
    step_signoff_defs,
    touch_user_presence,
)
from opal.core.execution_report import build_execution_report, qr_svg
from opal.core.genealogy import record_assembly_genealogy
from opal.core.holds import (
    blocking_issues_for_instance,
    enum_value,
    get_holds_payload,
)
from opal.core.part_lifecycle import ensure_parts_active
from opal.db.models import InventoryRecord, Kit, Part, ProcedureOutput
from opal.db.models.execution import (
    InstanceStatus,
    ProcedureInstance,
    StepExecution,
    StepFocus,
    StepNote,
    StepSignoff,
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
from opal.db.models.issue import (
    Containment,
    Issue,
    IssuePriority,
    IssueStatus,
    IssueType,
)
from opal.db.models.procedure import MasterProcedure, ProcedureType, ProcedureVersion

router = APIRouter(prefix="/procedure-instances", tags=["execution"])


# ============ Schemas ============


class StepNoteResponse(BaseModel):
    """One timestamped, authored, append-only step note."""

    id: int
    author_id: int | None = None
    author: str | None = None
    created_at: datetime
    body: str


class SignoffUser(BaseModel):
    id: int
    name: str | None = None


class SignoffSlotResponse(BaseModel):
    """One sign-off slot of a step: its definition and, once signed, the signature."""

    slot: int
    label: str
    role: str | None = None
    signed_by: SignoffUser | None = None
    signed_at: datetime | None = None


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
    notes: list[StepNoteResponse] = []
    signed_off_at: datetime | None = None
    signed_off_by_id: int | None = None
    signoffs: list[SignoffSlotResponse] = []
    duration_seconds: int | None = None

    model_config = {"from_attributes": True}


def _note_response(note: StepNote) -> StepNoteResponse:
    return StepNoteResponse(
        id=note.id,
        author_id=note.author_id,
        author=note.author.name if note.author else None,
        created_at=note.created_at,
        body=note.body,
    )


def _signoff_slots(step_exec: StepExecution) -> list[SignoffSlotResponse]:
    """Every slot of the row's effective sign-off list, signed or not."""
    instance = step_exec.instance
    defs = step_signoff_defs(instance.version, step_exec, row_has_children(instance, step_exec))
    records = {r.slot: r for r in step_exec.signoff_records}
    out: list[SignoffSlotResponse] = []
    for n, d in enumerate(defs):
        rec = records.get(n)
        out.append(
            SignoffSlotResponse(
                slot=n,
                label=rec.label if rec else d["label"],
                role=rec.role if rec else d["role"],
                signed_by=SignoffUser(
                    id=rec.signed_by_id, name=rec.signed_by.name if rec.signed_by else None
                )
                if rec and rec.signed_by_id
                else None,
                signed_at=rec.signed_at if rec else None,
            )
        )
    return out


def _step_response(step_exec: StepExecution) -> StepExecutionResponse:
    """The one serializer for a step execution row."""
    return StepExecutionResponse(
        signoffs=_signoff_slots(step_exec),
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
        notes=[_note_response(n) for n in step_exec.notes],
        signed_off_at=step_exec.signed_off_at,
        signed_off_by_id=step_exec.signed_off_by_id,
        duration_seconds=step_exec.duration_seconds,
    )


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
    """Capture an issue at the moment of discovery during step execution.

    The invoking context already knows WO, OP, step, and operator — the
    payload only carries what the crew observed. containment decides what
    the issue holds while undispositioned (step | op | wo | advisory); an
    optional boundary ("resolve by") binds a step-contained hold to a later
    step, which cannot COMPLETE until disposition.
    """

    title: str = Field(..., min_length=1, max_length=255)
    description: str | None = None
    priority: str = "medium"
    should_be: str | None = None
    actual: str | None = None
    containment: str = "step"
    containment_step_number: int | None = Field(
        None,
        description="Boundary step order ('resolve by'); None anchors at the raised step",
    )
    assigned_to_id: int | None = None


def _hold_blocker_detail(action: str, blockers: list[Issue]) -> str:
    """400 detail naming the holding issue(s) — the gated control's reason
    line, server side."""
    names = ", ".join(f"{i.issue_number} {i.title}" for i in blockers)
    return f"Cannot {action}: held by {names} (undispositioned)"


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

    # _step_response serializes every step's notes and each note's author:
    # eager-load the whole chain (plus the procedure name) so the list stays
    # a fixed number of queries — the TUI refresh degraded O(steps+notes)
    # via per-row lazy loads (F10).
    instances = (
        query.options(
            joinedload(ProcedureInstance.procedure),
            selectinload(ProcedureInstance.version),
            selectinload(ProcedureInstance.step_executions)
            .selectinload(StepExecution.notes)
            .joinedload(StepNote.author),
            selectinload(ProcedureInstance.step_executions)
            .selectinload(StepExecution.signoff_records)
            .joinedload(StepSignoff.signed_by),
        )
        .order_by(ProcedureInstance.id.desc())
        .offset((page - 1) * page_size)
        .limit(page_size)
        .all()
    )

    # One query for the page's version numbers, not one per instance.
    version_ids = {inst.version_id for inst in instances}
    versions_by_id = (
        {
            v.id: v
            for v in db.query(ProcedureVersion).filter(ProcedureVersion.id.in_(version_ids)).all()
        }
        if version_ids
        else {}
    )

    items = []
    for inst in instances:
        version = versions_by_id.get(inst.version_id)
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
                created_at=inst.created_at,
                step_executions=[_step_response(se) for se in inst.step_executions],
            )
        )

    return InstanceListResponse(
        items=items,
        total=total,
        page=page,
        page_size=page_size,
    )


# ============ Overview, cut preview, document, report ============


class OverviewRow(BaseModel):
    """One work order in the executions list."""

    id: int
    work_order_number: str | None = None
    procedure_id: int
    procedure_name: str
    version_number: int
    status: str
    priority: int = 0
    created_at: datetime
    started_at: datetime | None = None
    completed_at: datetime | None = None
    target_completion_at: datetime | None = None
    cut_by: str | None = None
    progress_done: int = 0
    progress_total: int = 0
    held_by: list[str] = []
    working: list[dict[str, Any]] = []


class OverviewResponse(BaseModel):
    """Paginated work-order list with per-status counts for the active filters."""

    items: list[OverviewRow]
    total: int
    page: int
    page_size: int
    counts: dict[str, int]


_OVERVIEW_SORTS = {
    "work_order": ProcedureInstance.work_order_number,
    "procedure": MasterProcedure.name,
    "status": ProcedureInstance.status,
    "created": ProcedureInstance.id,
    "target": ProcedureInstance.target_completion_at,
    "priority": ProcedureInstance.priority,
}


def _blocking_issue_exists():
    """Correlated EXISTS: an undispositioned, containment-bearing issue on the work order."""
    return exists().where(
        Issue.procedure_instance_id == ProcedureInstance.id,
        Issue.deleted_at.is_(None),
        Issue.status != IssueStatus.CLOSED,
        Issue.containment != Containment.ADVISORY,
        or_(Issue.disposition_type.is_(None), Issue.dispositioned_at.is_(None)),
    )


@router.get("/overview", response_model=OverviewResponse)
def executions_overview(
    db: DbSession,
    user_id: CurrentUserId,
    status: list[str] | None = Query(None),
    procedure_id: int | None = Query(None),
    q: str | None = Query(None, description="Work order number or procedure name"),
    mine: bool = Query(False, description="Cut by, claimed by, or worked by the caller"),
    held: bool = Query(False, description="Only work orders held by an undispositioned issue"),
    sort: str = Query("created"),
    dir: str = Query("desc", pattern="^(asc|desc)$"),
    page: int = Query(1, ge=1),
    page_size: int = Query(50, ge=1, le=100),
) -> OverviewResponse:
    """The executions list: filters, sort and per-row progress, holds and claimers."""
    from opal.db.models import User

    def apply_filters(query, with_status: bool):
        if with_status and status:
            wanted = [x for part in status for x in part.split(",") if x]
            query = query.filter(ProcedureInstance.status.in_(wanted))
        if procedure_id:
            query = query.filter(ProcedureInstance.procedure_id == procedure_id)
        if q:
            term = f"%{q}%"
            query = query.filter(
                or_(
                    ProcedureInstance.work_order_number.ilike(term),
                    MasterProcedure.name.ilike(term),
                )
            )
        if mine and user_id is not None:
            query = query.filter(
                or_(
                    ProcedureInstance.started_by_id == user_id,
                    exists().where(
                        StepFocus.instance_id == ProcedureInstance.id, StepFocus.user_id == user_id
                    ),
                    exists().where(
                        StepExecution.instance_id == ProcedureInstance.id,
                        StepExecution.completed_by_id == user_id,
                    ),
                )
            )
        if held:
            query = query.filter(_blocking_issue_exists())
        return query

    base = db.query(ProcedureInstance).join(
        MasterProcedure, MasterProcedure.id == ProcedureInstance.procedure_id
    )
    total = apply_filters(base, True).count()

    counts = {s.value: 0 for s in InstanceStatus}
    count_rows = apply_filters(
        db.query(ProcedureInstance.status, func.count(ProcedureInstance.id)).join(
            MasterProcedure, MasterProcedure.id == ProcedureInstance.procedure_id
        ),
        False,
    ).group_by(ProcedureInstance.status)
    for st, n in count_rows:
        counts[enum_value(st)] = n

    column = _OVERVIEW_SORTS.get(sort, ProcedureInstance.id)
    order = column.asc() if dir == "asc" else column.desc()
    instances = (
        apply_filters(base, True)
        .options(
            joinedload(ProcedureInstance.procedure),
            selectinload(ProcedureInstance.step_executions),
        )
        .order_by(order, ProcedureInstance.id.desc())
        .offset((page - 1) * page_size)
        .limit(page_size)
        .all()
    )

    versions = {
        v.id: v
        for v in db.query(ProcedureVersion)
        .filter(ProcedureVersion.id.in_({i.version_id for i in instances}))
        .all()
    }
    ids = [i.id for i in instances]
    cursors_by_instance = claims_for_instances(db, ids)
    user_ids = {c.user_id for cs in cursors_by_instance.values() for c in cs}
    user_ids |= {i.started_by_id for i in instances if i.started_by_id}
    users = (
        {u.id: u for u in db.query(User).filter(User.id.in_(user_ids)).all()} if user_ids else {}
    )

    items = []
    for inst in instances:
        version = versions.get(inst.version_id)
        contingency = {
            s["order"]
            for s in (version.content.get("steps", []) if version else [])
            if s.get("is_contingency")
        }
        rows = inst.step_executions
        parents = {se.parent_step_order for se in rows if se.parent_step_order is not None}
        counted = [
            se
            for se in rows
            if se.step_number not in parents
            and se.step_number not in contingency
            and se.parent_step_order not in contingency
        ]
        done = sum(
            1 for se in counted if enum_value(se.status) in ("completed", "signed_off", "skipped")
        )
        by_id = {se.id: se for se in rows}
        working = []
        for c in cursors_by_instance.get(inst.id, []):
            u = users.get(c.user_id)
            se = by_id.get(c.step_execution_id)
            working.append(
                {
                    "user_id": c.user_id,
                    "name": u.name if u else None,
                    "step_number": (se.step_number_str or str(se.step_number)) if se else None,
                }
            )
        held_by = (
            [i.issue_number for i in blocking_issues_for_instance(db, inst.id)]
            if enum_value(inst.status) in ("cut", "in_work")
            else []
        )
        starter = users.get(inst.started_by_id)
        items.append(
            OverviewRow(
                id=inst.id,
                work_order_number=inst.work_order_number,
                procedure_id=inst.procedure_id,
                procedure_name=inst.procedure.name,
                version_number=version.version_number if version else 0,
                status=enum_value(inst.status),
                priority=inst.priority,
                created_at=inst.created_at,
                started_at=inst.started_at,
                completed_at=inst.completed_at,
                target_completion_at=inst.target_completion_at,
                cut_by=starter.name if starter else None,
                progress_done=done,
                progress_total=len(counted),
                held_by=held_by,
                working=working,
            )
        )

    return OverviewResponse(items=items, total=total, page=page, page_size=page_size, counts=counts)


class PreviewPart(BaseModel):
    part_id: int
    part_number: str | None
    part_name: str
    uom: str | None = None
    per_work_order: float
    required: float
    available: float
    is_available: bool
    usage_type: str | None = None


class PreviewOutput(BaseModel):
    part_id: int
    part_number: str | None
    part_name: str
    quantity_each: float
    serials: list[str]


class PreviewVersion(BaseModel):
    id: int
    number: int
    created_at: datetime
    is_current: bool


class CutPreview(BaseModel):
    """What cutting N work orders from a procedure version will allocate and consume."""

    procedure_id: int
    procedure_name: str
    procedure_type: str
    versions: list[PreviewVersion]
    version_id: int
    version_number: int
    step_count: int
    op_count: int
    quantity: int
    outputs: list[PreviewOutput]
    kit: list[PreviewPart]
    step_kit: list[PreviewPart]
    all_available: bool


@router.get("/preview", response_model=CutPreview)
def preview_cut(
    db: DbSession,
    procedure_id: int = Query(...),
    version_id: int | None = Query(None),
    quantity: int = Query(1, ge=1, le=100),
) -> CutPreview:
    """Cut preview: versions, serials the build outputs will be given, and a kit
    availability check scaled by quantity. Allocates nothing."""
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
    if not versions:
        raise HTTPException(status_code=400, detail="Procedure has no published version")
    chosen = next((v for v in versions if v.id == version_id), None) if version_id else None
    if version_id and chosen is None:
        raise HTTPException(status_code=404, detail="Version not found for this procedure")
    if chosen is None:
        chosen = next((v for v in versions if v.id == procedure.current_version_id), versions[0])

    steps = chosen.content.get("steps", [])
    proc_type = enum_value(procedure.procedure_type)

    def on_hand(part_id: int) -> float:
        total = (
            db.query(func.coalesce(func.sum(InventoryRecord.quantity), 0))
            .filter(InventoryRecord.part_id == part_id, InventoryRecord.quantity > 0)
            .scalar()
        )
        return float(total or 0)

    outputs: list[PreviewOutput] = []
    if proc_type == ProcedureType.BUILD.value:
        for o in db.query(ProcedureOutput).filter(ProcedureOutput.procedure_id == procedure_id):
            outputs.append(
                PreviewOutput(
                    part_id=o.part_id,
                    part_number=o.part.internal_pn,
                    part_name=o.part.name,
                    quantity_each=float(o.quantity_produced),
                    serials=peek_serial_numbers(db, o.part, quantity),
                )
            )

    kit_parts: list[PreviewPart] = []
    for k in db.query(Kit).options(joinedload(Kit.part)).filter(Kit.procedure_id == procedure_id):
        per = float(k.quantity_required)
        have = on_hand(k.part_id)
        kit_parts.append(
            PreviewPart(
                part_id=k.part_id,
                part_number=k.part.internal_pn,
                part_name=k.part.name,
                uom=k.part.unit_of_measure,
                per_work_order=per,
                required=per * quantity,
                available=have,
                is_available=have >= per * quantity,
            )
        )

    # Step kits aggregate by part and usage: tooling is checked out, not used up,
    # so it needs one set on hand rather than `quantity` sets.
    agg: dict[tuple[int, str], float] = {}
    for step in steps:
        for sk in step.get("step_kit") or []:
            key = (sk["part_id"], sk.get("usage_type") or "consume")
            agg[key] = agg.get(key, 0.0) + float(sk["quantity_required"])
    step_kit_parts: list[PreviewPart] = []
    for (part_id, usage), per in sorted(agg.items()):
        part = db.get(Part, part_id)
        if part is None:
            continue
        need = per * quantity if usage == "consume" else per
        have = on_hand(part_id)
        step_kit_parts.append(
            PreviewPart(
                part_id=part_id,
                part_number=part.internal_pn,
                part_name=part.name,
                uom=part.unit_of_measure,
                per_work_order=per,
                required=need,
                available=have,
                is_available=have >= need,
                usage_type=usage,
            )
        )

    return CutPreview(
        procedure_id=procedure.id,
        procedure_name=procedure.name,
        procedure_type=proc_type,
        versions=[
            PreviewVersion(
                id=v.id,
                number=v.version_number,
                created_at=v.created_at,
                is_current=v.id == procedure.current_version_id,
            )
            for v in versions
        ],
        version_id=chosen.id,
        version_number=chosen.version_number,
        step_count=len(steps),
        op_count=sum(1 for s in steps if s.get("level", 0) == 0),
        quantity=quantity,
        outputs=outputs,
        kit=kit_parts,
        step_kit=step_kit_parts,
        all_available=all(p.is_available for p in [*kit_parts, *step_kit_parts]),
    )


@router.get("/{instance_id}/document")
def get_execution_document(
    instance_id: int,
    db: DbSession,
    user_id: CurrentUserId,
) -> dict:
    """The execution document view model: OPs and steps with computed gates, holds,
    cursors, notes, evidence, kit and consumption. A pure read; the presence
    heartbeat stays on /state."""
    instance = db.query(ProcedureInstance).filter(ProcedureInstance.id == instance_id).first()
    if not instance:
        raise HTTPException(status_code=404, detail="Instance not found")
    return build_execution_document(db, instance, user_id)


@router.get("/{instance_id}/report")
def get_execution_report(instance_id: int, db: DbSession) -> dict:
    """Build report content for a COMPLETED work order."""
    instance = db.query(ProcedureInstance).filter(ProcedureInstance.id == instance_id).first()
    if not instance:
        raise HTTPException(status_code=404, detail="Instance not found")
    status = enum_value(instance.status)
    if status != InstanceStatus.COMPLETED.value:
        raise HTTPException(
            status_code=400,
            detail=f"Work order is {status.upper().replace('_', ' ')}; "
            "reports are only generated for COMPLETED work orders",
        )
    return build_execution_report(db, instance)


@router.get("/{instance_id}/qr.svg")
def get_execution_qr(instance_id: int, request: Request, db: DbSession, origin: str | None = None):
    """QR code linking to the execution page. ``origin`` is the browser's origin
    (the API cannot know the public address); it defaults to the request's own."""
    instance = db.query(ProcedureInstance).filter(ProcedureInstance.id == instance_id).first()
    if not instance:
        raise HTTPException(status_code=404, detail="Instance not found")
    base = (origin or str(request.base_url)).rstrip("/")
    if not base.startswith(("http://", "https://")):
        raise HTTPException(status_code=400, detail="origin must be an http(s) origin")
    return Response(content=qr_svg(f"{base}/executions/{instance_id}"), media_type="image/svg+xml")


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

    status_value = (
        procedure.status.value if hasattr(procedure.status, "value") else procedure.status
    )
    if status_value == "deprecated":
        raise HTTPException(
            status_code=400, detail="Template is deprecated; activate it to cut work orders"
        )

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
        created_at=instance.created_at,
        step_executions=[_step_response(se) for se in instance.step_executions],
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
        created_at=instance.created_at,
        step_executions=[_step_response(se) for se in instance.step_executions],
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
        created_at=instance.created_at,
        step_executions=[_step_response(se) for se in instance.step_executions],
    )


# ============ Step Execution ============


class FocusMove(BaseModel):
    """Claim an OP: the caller says they are working on it. Presence, not an event.
    ``step_number`` may name the OP or any of its steps; the claim covers the OP."""

    step_number: int


@router.post("/{instance_id}/focus")
async def move_focus(
    instance_id: int,
    data: FocusMove,
    db: DbSession,
    user_id: CurrentUserId,
) -> dict:
    """Claim an OP for the caller (one claim per user per work order).
    Broadcast to the document; never recorded. Reading a step never moves
    the claim — only this explicit call does."""
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

    # A claim says "I am working on this OP": it is refused where work cannot
    # happen — a finished OP, or one still gated by an OP dependency or an
    # open redline.
    step_exec = claim_op(step_exec, list(instance.step_executions))
    status = step_exec.status.value if hasattr(step_exec.status, "value") else step_exec.status
    if status in ("completed", "signed_off", "skipped"):
        raise HTTPException(status_code=409, detail="Operation is finished")
    # Unfinished sub-steps never gate the claim: working them is the point.
    gates = [b for b in sequence_blockers(db, instance, step_exec) if b.kind != "children"]
    if gates:
        raise HTTPException(status_code=409, detail="; ".join(b.message for b in gates))

    from opal.db.models import User

    user = db.query(User).filter(User.id == user_id).first()
    if not user:
        raise HTTPException(status_code=401, detail="Unknown user")

    user.last_seen_at = datetime.now(UTC)
    focus = focus_step(db, instance, step_exec, user)
    db.commit()

    await emit_cursor_moved(instance_id, step_exec.step_number, user_id, user.name)

    return {
        "step_number": step_exec.step_number,
        "focused_at": focus.focused_at.isoformat(),
    }


@router.delete("/{instance_id}/focus")
async def release_focus(instance_id: int, db: DbSession, user_id: CurrentUserId) -> dict:
    """Release the caller's claim. Broadcast as a cursor move to nowhere."""
    instance = db.query(ProcedureInstance).filter(ProcedureInstance.id == instance_id).first()
    if not instance:
        raise HTTPException(status_code=404, detail="Instance not found")
    from opal.db.models import User

    user = db.query(User).filter(User.id == user_id).first()
    clear_focus(db, instance_id, user_id)
    db.commit()
    await emit_cursor_moved(instance_id, None, user_id, user.name if user else None)
    return {"step_number": None}


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


def _get_instance_step(
    db: DbSession, instance_id: int, step_number: int
) -> tuple[ProcedureInstance, StepExecution]:
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
    return instance, step_exec


async def _finish_signature(
    db: DbSession,
    instance: ProcedureInstance,
    step_exec: StepExecution,
    result: Any,
    user_id: int,
) -> StepExecutionResponse:
    """Commit a signature and emit its events: one tail for COMPLETE, SIGN OFF and
    the slot endpoint."""
    if result.validation_errors:
        raise HTTPException(status_code=422, detail=result.validation_errors)

    from opal.db.models import User

    user = db.query(User).filter(User.id == user_id).first()
    user_name = user.name if user else None

    db.commit()
    db.refresh(step_exec)
    db.expire(step_exec, ["signoff_records"])
    db.refresh(instance)

    await emit_step_completed(instance.id, step_exec.step_number, user_id, user_name)
    if result.instance_started:
        await emit_instance_started(instance.id, instance.procedure_id, user_id, user_name)
    if result.instance_completed:
        await emit_instance_completed(
            instance.id, instance.procedure_id, InstanceStatus.COMPLETED.value
        )
    return _step_response(step_exec)


@router.post("/{instance_id}/steps/{step_number}/complete", response_model=StepExecutionResponse)
async def complete_step(
    instance_id: int,
    step_number: int,
    data: StepComplete,
    db: DbSession,
    user_id: CurrentUserId,
) -> StepExecutionResponse:
    """Sign slot 0 of a step with optional data capture (the old COMPLETE)."""
    instance, step_exec = _get_instance_step(db, instance_id, step_number)
    try:
        result = complete_step_flow(
            db, instance, step_exec, user_id, data_captured=data.data_captured, notes=data.notes
        )
    except FlowError as err:
        raise HTTPException(status_code=err.status_code, detail=err.message) from err
    return await _finish_signature(db, instance, step_exec, result, user_id)


class SignoffSign(BaseModel):
    """Sign one slot. Data capture rides with slot 0."""

    data_captured: dict[str, Any] | None = None


@router.post(
    "/{instance_id}/steps/{step_number}/signoffs/{slot}", response_model=StepExecutionResponse
)
async def sign_step_slot(
    instance_id: int,
    step_number: int,
    slot: int,
    db: DbSession,
    user_id: CurrentUserId,
    data: SignoffSign | None = None,
) -> StepExecutionResponse:
    """Sign slot ``slot`` of a step's or OP's sign-off list. The step completes
    with its last slot. Slot 0 carries the old COMPLETE gate (sequence, holds,
    required data); later slots may be signed in any order after it."""
    instance, step_exec = _get_instance_step(db, instance_id, step_number)
    try:
        result = sign_step_flow(
            db,
            instance,
            step_exec,
            slot,
            user_id,
            data_captured=data.data_captured if data else None,
        )
    except FlowError as err:
        raise HTTPException(status_code=err.status_code, detail=err.message) from err
    return await _finish_signature(db, instance, step_exec, result, user_id)


class StepNoteCreate(BaseModel):
    """Append one note to a step."""

    body: str


@router.post(
    "/{instance_id}/steps/{step_number}/notes",
    response_model=StepNoteResponse,
    status_code=201,
)
def create_step_note(
    instance_id: int,
    step_number: int,
    data: StepNoteCreate,
    db: DbSession,
    user_id: CurrentUserId,
) -> StepNoteResponse:
    """Append a timestamped, authored note to a step.

    Notes are a record, not a control: any step status (pending, held,
    terminal) and any instance status — a completed or aborted work order
    still takes post-mortem notes.
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

    try:
        note = add_step_note(db, step_exec, data.body, user_id)
    except FlowError as err:
        raise HTTPException(status_code=err.status_code, detail=err.message) from err
    db.commit()
    db.refresh(note)

    return _note_response(note)


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

    # SKIP is a terminal commitment: it inherits the held scope (a hold cannot
    # be skipped around) and any open redline-rework op on the gate — skipping
    # the host step must not strand authorized rework (F5). It does not inherit
    # strict_sequence/dependency ordering: skipping legitimately need not wait
    # on predecessors.
    holds = skip_blockers(db, instance, step_exec)
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

    return _step_response(step_exec)


@router.post("/{instance_id}/steps/{step_number}/signoff", response_model=StepExecutionResponse)
async def signoff_step(
    instance_id: int,
    step_number: int,
    db: DbSession,
    user_id: CurrentUserId,
) -> StepExecutionResponse:
    """Sign the next unsigned slot of a step awaiting sign-off (a wrapper over
    the slot endpoint for the TUI and scripts)."""
    instance, step_exec = _get_instance_step(db, instance_id, step_number)
    try:
        result = signoff_step_flow(db, instance, step_exec, user_id)
    except FlowError as err:
        raise HTTPException(status_code=err.status_code, detail=err.message) from err
    return await _finish_signature(db, instance, step_exec, result, user_id)


@router.post("/{instance_id}/steps/{step_number}/nc", status_code=201)
def log_non_conformance(
    instance_id: int,
    step_number: int,
    data: NonConformanceCreate,
    db: DbSession,
    user_id: CurrentUserId,
) -> dict:
    """Capture a non-conformance during step execution, creates an Issue.

    The hold is the issue itself: an undispositioned issue with step
    containment makes the step's COMPLETE absent. Step status is not touched.
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

    try:
        priority = IssuePriority(data.priority)
    except ValueError:
        priority = IssuePriority.MEDIUM

    try:
        containment = Containment(data.containment)
    except ValueError as err:
        raise HTTPException(
            status_code=400, detail=f"Invalid containment: {data.containment}"
        ) from err

    # Optional boundary ("resolve by"): a step-contained hold may bind to a
    # later step; None anchors at the raised step.
    containment_step_id = None
    if data.containment_step_number is not None:
        boundary = (
            db.query(StepExecution)
            .filter(
                StepExecution.instance_id == instance_id,
                StepExecution.step_number == data.containment_step_number,
            )
            .first()
        )
        if boundary is None:
            raise HTTPException(
                status_code=404,
                detail=f"Boundary step {data.containment_step_number} not found",
            )
        containment_step_id = boundary.id

    issue = Issue(
        issue_number=generate_issue_number(db),
        title=data.title,
        description=data.description,
        issue_type=IssueType.NON_CONFORMANCE,
        status=IssueStatus.OPEN,
        priority=priority,
        containment=containment,
        containment_step_id=containment_step_id,
        should_be=data.should_be,
        actual=data.actual,
        procedure_id=instance.procedure_id,
        procedure_instance_id=instance_id,
        raised_step_id=step_exec.id,
        raised_by_id=user_id,
        assigned_to_id=data.assigned_to_id,
    )
    # Raising an NC from the floor is the commonest way a run becomes blocked,
    # so it notifies through the same path as an issue raised from /issues.
    from opal.core import notifications

    with notifications.blocking_change(db, instance_id, user_id, issue):
        db.add(issue)
        db.flush()

    log_create(db, issue, user_id)
    notifications.issue_assigned(db, issue, user_id)
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
        "containment": issue.containment.value
        if hasattr(issue.containment, "value")
        else issue.containment,
        "procedure_instance_id": instance_id,
        "step_number": step_number,
    }


@router.get("/{instance_id}/holds")
def get_instance_holds(
    instance_id: int,
    db: DbSession,
) -> dict:
    """The controller's blocking state: every undispositioned issue holding
    this work order and what it blocks."""
    instance = db.query(ProcedureInstance).filter(ProcedureInstance.id == instance_id).first()
    if not instance:
        raise HTTPException(status_code=404, detail="Instance not found")
    return get_holds_payload(db, instance_id)


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
    uom: str | None = None
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
                uom=kit_item.part.unit_of_measure,
                quantity_required=qty_required,
                quantity_available=total_available,
                is_available=is_available,
                available_locations=[
                    {
                        "inventory_record_id": r.id,
                        "opal_number": r.opal_number,
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

    # Remove user from participants. The claim stays: it is an explicit
    # statement of where they work, and survives reloads and closed tabs.
    instance.participants = [p for p in participants if p.get("user_id") != user_id]
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
        sub_steps=[_step_response(s) for s in sub_rows],
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
    if issue.raised_step_id is None:
        raise HTTPException(
            status_code=400, detail="NC is not attached to a step; cannot create redline"
        )

    host_exec = db.get(StepExecution, issue.raised_step_id)
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
