"""Issues API routes.

Two gates, not one: raised → UNDISPOSITIONED → DISPOSITIONED → CLOSED.
The blocking predicate is `undispositioned`, never `open`. Signing a
disposition (POST /{id}/disposition) releases every containment the issue
holds, live; closure is bookkeeping that follows at its own pace.
"""

from datetime import UTC, datetime

from fastapi import APIRouter, HTTPException, Query
from pydantic import BaseModel, Field
from sqlalchemy import and_, case, or_
from sqlalchemy.orm import joinedload

from opal.api.deps import CurrentUserId, DbSession
from opal.core import notifications
from opal.core.audit import get_model_dict, log_create, log_delete, log_update
from opal.core.designators import generate_issue_number
from opal.core.events import emit_issue_dispositioned
from opal.core.execution_flow import recheck_instance_completion, version_step_map
from opal.core.holds import holding_readout, scope_label
from opal.db.models.execution import ProcedureInstance, StepExecution
from opal.db.models.issue import (
    CONTAINMENT_RANK,
    Containment,
    DispositionType,
    Issue,
    IssuePriority,
    IssueStatus,
    IssueType,
)
from opal.db.models.issue_comment import IssueComment
from opal.db.models.part import Part
from opal.db.models.procedure import MasterProcedure, ProcedureVersion
from opal.db.models.risk import Risk
from opal.db.models.user import User

router = APIRouter(prefix="/issues", tags=["issues"])

_SORT_KEYS = ("number", "title", "type", "state", "priority", "created", "updated")


def _get_enum_val(obj: object, attr: str) -> str:
    """Extract the string value from a potentially-enum attribute."""
    val = getattr(obj, attr)
    return val.value if hasattr(val, "value") else val


def _resolve_containment_instance(
    db,
    containment: Containment,
    containment_step_id: int | None,
    raised_step_id: int | None,
    procedure_instance_id: int | None,
) -> int | None:
    """Reconcile a non-advisory issue's work order against its step anchors.

    Derives procedure_instance_id from a step anchor when unset, and rejects a
    procedure_instance_id (or a second anchor) that names a different work order
    (F3). Advisory issues pass through untouched — they hold nothing.
    """
    if containment == Containment.ADVISORY:
        return procedure_instance_id
    resolved = procedure_instance_id
    for step_id in (containment_step_id, raised_step_id):
        if step_id is None:
            continue
        step = db.query(StepExecution).filter(StepExecution.id == step_id).first()
        if step is None:
            raise HTTPException(status_code=400, detail=f"Step {step_id} not found")
        if resolved is None:
            resolved = step.instance_id
        elif step.instance_id != resolved:
            raise HTTPException(
                status_code=400,
                detail=f"Step {step_id} belongs to a different work order "
                "than procedure_instance_id",
            )
    return resolved


# ============ Schemas ============


class IssueResponse(BaseModel):
    """Issue response."""

    id: int
    issue_number: str | None = None
    title: str
    description: str | None = None
    issue_type: str
    status: str
    priority: str
    containment: str
    containment_step_id: int | None = None
    disp_state: str
    dispositioned: bool
    part_id: int | None = None
    procedure_id: int | None = None
    procedure_instance_id: int | None = None
    raised_step_id: int | None = None
    raised_by_id: int | None = None
    should_be: str | None = None
    actual: str | None = None
    steps_to_reproduce: str | None = None
    expected_behavior: str | None = None
    actual_behavior: str | None = None
    expected_benefit: str | None = None
    root_cause: str | None = None
    corrective_action: str | None = None
    disposition_type: str | None = None
    disposition_rationale: str | None = None
    assigned_to_id: int | None = None
    dispositioned_by_id: int | None = None
    dispositioned_at: datetime | None = None
    created_at: datetime
    updated_at: datetime
    # Display names for the linked records, so no client lookup is needed.
    part_number: str | None = None
    part_name: str | None = None
    procedure_name: str | None = None
    work_order_number: str | None = None
    raised_by_name: str | None = None
    assigned_to_name: str | None = None
    dispositioned_by_name: str | None = None
    self_dispositioned: bool = False
    raised_step_label: str | None = None
    containment_step_label: str | None = None

    model_config = {"from_attributes": True}


class LinkedRisk(BaseModel):
    """A risk this issue responds to, or the risk that realized into it."""

    risk_id: int
    risk_number: str
    title: str
    relation: str  # mitigation | research | realized


class RedlineOp(BaseModel):
    """A redline operation spawned on the work order for this issue."""

    step_number: int
    label: str
    title: str
    status: str


class IssueDetailResponse(IssueResponse):
    """Single-issue view: the issue plus what it touches."""

    raised_op_order: int | None = None
    risks: list[LinkedRisk] = []
    redline_ops: list[RedlineOp] = []


class Assignee(BaseModel):
    """An active user an issue can be assigned to."""

    id: int
    name: str


class StepOption(BaseModel):
    """A step of the issue's work order, for choosing a containment boundary."""

    id: int
    label: str
    title: str


class IssueListResponse(BaseModel):
    """Paginated issue list."""

    items: list[IssueResponse]
    total: int
    page: int
    page_size: int


class IssueCreate(BaseModel):
    """Create issue request."""

    title: str = Field(..., min_length=1, max_length=255)
    description: str | None = None
    issue_type: str = "task"
    priority: str = "medium"
    containment: str = "advisory"
    containment_step_id: int | None = None
    should_be: str | None = None
    actual: str | None = None
    steps_to_reproduce: str | None = None
    expected_behavior: str | None = None
    actual_behavior: str | None = None
    expected_benefit: str | None = None
    part_id: int | None = None
    procedure_id: int | None = None
    procedure_instance_id: int | None = None
    raised_step_id: int | None = None
    assigned_to_id: int | None = None


class IssueUpdate(BaseModel):
    """Update issue request. Disposition is signed via POST /{id}/disposition,
    not patched; containment changes go through POST /{id}/containment."""

    title: str | None = Field(None, min_length=1, max_length=255)
    description: str | None = None
    issue_type: str | None = None
    status: str | None = None
    priority: str | None = None
    should_be: str | None = None
    actual: str | None = None
    steps_to_reproduce: str | None = None
    expected_behavior: str | None = None
    actual_behavior: str | None = None
    expected_benefit: str | None = None
    part_id: int | None = None
    procedure_id: int | None = None
    procedure_instance_id: int | None = None
    root_cause: str | None = None
    corrective_action: str | None = None
    disposition_type: str | None = None
    disposition_rationale: str | None = None
    assigned_to_id: int | None = None


class DispositionSign(BaseModel):
    """Sign a disposition — the signature moment."""

    disposition_type: str
    disposition_rationale: str = Field(..., min_length=1)


class ContainmentChange(BaseModel):
    """Change containment scope. Narrowing releases a hold and is audited
    with a note."""

    containment: str
    containment_step_id: int | None = None
    note: str | None = None


class IssueCommentResponse(BaseModel):
    """Issue comment response."""

    id: int
    issue_id: int
    user_id: int | None = None
    user_name: str | None = None
    body: str
    created_at: datetime

    model_config = {"from_attributes": True}

    @classmethod
    def of(cls, comment: IssueComment) -> "IssueCommentResponse":
        return cls(
            id=comment.id,
            issue_id=comment.issue_id,
            user_id=comment.user_id,
            user_name=comment.user.name if comment.user else None,
            body=comment.body,
            created_at=comment.created_at,
        )


class IssueCommentCreate(BaseModel):
    """Create issue comment request."""

    body: str = Field(..., min_length=1)


def _issue_to_response(issue: Issue) -> IssueResponse:
    """Convert an Issue ORM object to an IssueResponse."""
    return IssueResponse(
        id=issue.id,
        issue_number=issue.issue_number,
        title=issue.title,
        description=issue.description,
        issue_type=_get_enum_val(issue, "issue_type"),
        status=_get_enum_val(issue, "status"),
        priority=_get_enum_val(issue, "priority"),
        containment=_get_enum_val(issue, "containment"),
        containment_step_id=issue.containment_step_id,
        disp_state=issue.disp_state,
        dispositioned=issue.dispositioned,
        part_id=issue.part_id,
        procedure_id=issue.procedure_id,
        procedure_instance_id=issue.procedure_instance_id,
        raised_step_id=issue.raised_step_id,
        raised_by_id=issue.raised_by_id,
        should_be=issue.should_be,
        actual=issue.actual,
        steps_to_reproduce=issue.steps_to_reproduce,
        expected_behavior=issue.expected_behavior,
        actual_behavior=issue.actual_behavior,
        expected_benefit=issue.expected_benefit,
        root_cause=issue.root_cause,
        corrective_action=issue.corrective_action,
        disposition_type=_get_enum_val(issue, "disposition_type")
        if issue.disposition_type
        else None,
        disposition_rationale=issue.disposition_rationale,
        assigned_to_id=issue.assigned_to_id,
        dispositioned_by_id=issue.dispositioned_by_id,
        dispositioned_at=issue.dispositioned_at,
        created_at=issue.created_at,
        updated_at=issue.updated_at,
        part_number=issue.part.internal_pn if issue.part else None,
        part_name=issue.part.name if issue.part else None,
        procedure_name=issue.procedure.name if issue.procedure else None,
        work_order_number=(
            (issue.procedure_instance.work_order_number or f"WO #{issue.procedure_instance.id}")
            if issue.procedure_instance
            else None
        ),
        raised_by_name=issue.raised_by.name if issue.raised_by else None,
        assigned_to_name=issue.assigned_to.name if issue.assigned_to else None,
        dispositioned_by_name=issue.dispositioned_by.name if issue.dispositioned_by else None,
        self_dispositioned=issue.self_dispositioned,
        raised_step_label=scope_label(issue.raised_step) if issue.raised_step else None,
        containment_step_label=(
            scope_label(issue.containment_step) if issue.containment_step else None
        ),
    )


def _issue_to_detail(db, issue: Issue) -> IssueDetailResponse:
    """Issue plus linked risks and spawned redline ops."""
    base = _issue_to_response(issue).model_dump()
    raised_op_order = None
    if issue.raised_step is not None and issue.procedure_instance_id is not None:
        raised = issue.raised_step
        raised_op_order = raised.step_number if raised.level == 0 else raised.parent_step_order

    risks = [
        LinkedRisk(
            risk_id=link.risk_id,
            risk_number=link.risk.risk_number,
            title=link.risk.title,
            relation=link.role,
        )
        for link in issue.risk_links
        if link.risk is not None and link.risk.deleted_at is None
    ]
    realized = (
        db.query(Risk).filter(Risk.realized_issue_id == issue.id, Risk.deleted_at.is_(None)).all()
    )
    risks += [
        LinkedRisk(risk_id=r.id, risk_number=r.risk_number, title=r.title, relation="realized")
        for r in realized
    ]

    redlines = (
        db.query(StepExecution)
        .filter(StepExecution.ad_hoc_issue_id == issue.id, StepExecution.level == 0)
        .order_by(StepExecution.step_number)
        .all()
    )
    return IssueDetailResponse(
        **base,
        raised_op_order=raised_op_order,
        risks=risks,
        redline_ops=[
            RedlineOp(
                step_number=op.step_number,
                label=scope_label(op),
                title=op.title or "",
                status=_get_enum_val(op, "status"),
            )
            for op in redlines
        ],
    )


# ============ Utility Endpoints ============


@router.get("/types", response_model=list[str])
def get_issue_types() -> list[str]:
    """Get all issue types."""
    return [t.value for t in IssueType]


@router.get("/statuses", response_model=list[str])
def get_issue_statuses() -> list[str]:
    """Get all issue statuses."""
    return [s.value for s in IssueStatus]


@router.get("/priorities", response_model=list[str])
def get_issue_priorities() -> list[str]:
    """Get all issue priorities."""
    return [p.value for p in IssuePriority]


@router.get("/disposition-types", response_model=list[str])
def get_disposition_types() -> list[str]:
    """Get all disposition types."""
    return [d.value for d in DispositionType]


@router.get("/containments", response_model=list[str])
def get_containments() -> list[str]:
    """Get all containment scopes."""
    return [c.value for c in Containment]


# ============ Issue CRUD ============


@router.get("", response_model=IssueListResponse)
def list_issues(
    db: DbSession,
    search: str | None = Query(None),
    issue_type: str | None = Query(None),
    status: str | None = Query(None),
    disp_state: str | None = Query(None),
    priority: str | None = Query(None),
    assigned_to_id: int | None = Query(None),
    part_id: int | None = Query(None),
    procedure_id: int | None = Query(None),
    procedure_instance_id: int | None = Query(None),
    sort: str | None = Query(None, description=f"One of {', '.join(_SORT_KEYS)}"),
    dir: str = Query("desc", pattern="^(asc|desc)$"),
    page: int = Query(1, ge=1),
    page_size: int = Query(50, ge=1, le=100),
) -> IssueListResponse:
    """List issues with optional filters. Without `sort`, undispositioned
    containment-bearing issues come first, then newest first."""
    query = db.query(Issue).filter(Issue.deleted_at.is_(None))

    if search:
        search_term = f"%{search}%"
        query = query.filter(
            or_(Issue.title.ilike(search_term), Issue.issue_number.ilike(search_term))
        )
    if assigned_to_id:
        query = query.filter(Issue.assigned_to_id == assigned_to_id)

    if issue_type:
        query = query.filter(Issue.issue_type == issue_type)
    if status:
        query = query.filter(Issue.status == status)
    if disp_state:
        query = _filter_disp_state(query, disp_state)
    if priority:
        query = query.filter(Issue.priority == priority)
    if part_id:
        query = query.filter(Issue.part_id == part_id)
    if procedure_id:
        query = query.filter(Issue.procedure_id == procedure_id)
    if procedure_instance_id:
        query = query.filter(Issue.procedure_instance_id == procedure_instance_id)

    total = query.count()

    if sort is not None and sort not in _SORT_KEYS:
        raise HTTPException(status_code=400, detail=f"Invalid sort: {sort}")
    if sort is None:
        order = [case((_blocking_clause(), 0), else_=1), Issue.id.desc()]
    else:
        column = _sort_column(sort)
        order = [column.asc() if dir == "asc" else column.desc(), Issue.id.desc()]

    issues = (
        query.options(
            joinedload(Issue.part),
            joinedload(Issue.procedure),
            joinedload(Issue.procedure_instance),
            joinedload(Issue.assigned_to),
            joinedload(Issue.raised_by),
            joinedload(Issue.dispositioned_by),
        )
        .order_by(*order)
        .offset((page - 1) * page_size)
        .limit(page_size)
        .all()
    )

    return IssueListResponse(
        items=[_issue_to_response(i) for i in issues],
        total=total,
        page=page,
        page_size=page_size,
    )


def _blocking_clause():
    """SQL twin of Issue.is_blocking for open issues."""
    signed = and_(Issue.disposition_type.isnot(None), Issue.dispositioned_at.isnot(None))
    return and_(
        Issue.status != IssueStatus.CLOSED,
        Issue.containment != Containment.ADVISORY,
        ~signed,
    )


def _sort_column(sort: str):
    if sort == "priority":
        return case(
            (Issue.priority == IssuePriority.CRITICAL, 4),
            (Issue.priority == IssuePriority.HIGH, 3),
            (Issue.priority == IssuePriority.MEDIUM, 2),
            else_=1,
        )
    if sort == "state":
        return case((_blocking_clause(), 0), (Issue.status != IssueStatus.CLOSED, 1), else_=2)
    return {
        "number": Issue.issue_number,
        "title": Issue.title,
        "type": Issue.issue_type,
        "created": Issue.created_at,
        "updated": Issue.updated_at,
    }[sort]


def _filter_disp_state(query, disp_state: str):
    """The four-value STATE filter, matching what the list column renders:
    open = advisory-open; undispositioned / dispositioned = containment-bearing
    only; closed = closed."""
    signed = and_(Issue.disposition_type.isnot(None), Issue.dispositioned_at.isnot(None))
    bearing = Issue.containment != Containment.ADVISORY
    if disp_state == "closed":
        return query.filter(Issue.status == IssueStatus.CLOSED)
    if disp_state == "open":
        return query.filter(
            Issue.status != IssueStatus.CLOSED, Issue.containment == Containment.ADVISORY
        )
    if disp_state == "dispositioned":
        return query.filter(Issue.status != IssueStatus.CLOSED, bearing, signed)
    if disp_state == "undispositioned":
        return query.filter(
            Issue.status != IssueStatus.CLOSED,
            bearing,
            or_(Issue.disposition_type.is_(None), Issue.dispositioned_at.is_(None)),
        )
    raise HTTPException(status_code=400, detail=f"Invalid disp_state: {disp_state}")


@router.post("", response_model=IssueResponse, status_code=201)
def create_issue(
    data: IssueCreate,
    db: DbSession,
    user_id: CurrentUserId,
) -> IssueResponse:
    """Create a new issue."""
    # Validate enums
    try:
        issue_type = IssueType(data.issue_type)
    except ValueError as err:
        raise HTTPException(
            status_code=400, detail=f"Invalid issue type: {data.issue_type}"
        ) from err

    try:
        priority = IssuePriority(data.priority)
    except ValueError as err:
        raise HTTPException(status_code=400, detail=f"Invalid priority: {data.priority}") from err

    try:
        containment = Containment(data.containment)
    except ValueError as err:
        raise HTTPException(
            status_code=400, detail=f"Invalid containment: {data.containment}"
        ) from err

    # A non-advisory containment holds a specific work order via the anchor's
    # procedure_instance_id (core/holds filters on it). Derive it from any step
    # anchor and reject anchors that name a different work order — otherwise the
    # hold reports success but blocks nothing, or blocks the wrong WO (F3). A
    # bare draft (no anchor, no WO) is still allowed; the WO is linked later.
    procedure_instance_id = _resolve_containment_instance(
        db, containment, data.containment_step_id, data.raised_step_id, data.procedure_instance_id
    )

    # The work order already names its procedure; don't ask the caller twice.
    procedure_id = data.procedure_id
    if procedure_instance_id is not None:
        wo = db.get(ProcedureInstance, procedure_instance_id)
        if wo is None:
            raise HTTPException(
                status_code=400, detail=f"Work order {procedure_instance_id} not found"
            )
        if procedure_id is None:
            procedure_id = wo.procedure_id

    issue = Issue(
        issue_number=generate_issue_number(db),
        title=data.title,
        description=data.description,
        issue_type=issue_type,
        status=IssueStatus.OPEN,
        priority=priority,
        containment=containment,
        containment_step_id=data.containment_step_id,
        should_be=data.should_be,
        actual=data.actual,
        steps_to_reproduce=data.steps_to_reproduce,
        expected_behavior=data.expected_behavior,
        actual_behavior=data.actual_behavior,
        expected_benefit=data.expected_benefit,
        part_id=data.part_id,
        procedure_id=procedure_id,
        procedure_instance_id=procedure_instance_id,
        raised_step_id=data.raised_step_id,
        raised_by_id=user_id,
        assigned_to_id=data.assigned_to_id,
    )
    # Raising a containment-bearing issue against a work order can be what
    # blocks it; blocking_change reports that only if the run was clear before.
    with notifications.blocking_change(db, procedure_instance_id, user_id, issue):
        db.add(issue)
        db.flush()

    log_create(db, issue, user_id)
    notifications.issue_assigned(db, issue, user_id)
    db.commit()
    db.refresh(issue)

    return _issue_to_response(issue)


@router.get("/{issue_id}", response_model=IssueDetailResponse)
def get_issue(
    issue_id: int,
    db: DbSession,
) -> IssueDetailResponse:
    """Get issue by ID, with linked risks and redline ops."""
    issue = db.query(Issue).filter(Issue.id == issue_id, Issue.deleted_at.is_(None)).first()
    if not issue:
        raise HTTPException(status_code=404, detail="Issue not found")

    return _issue_to_detail(db, issue)


@router.get("/{issue_id}/steps", response_model=list[StepOption])
def get_issue_steps(
    issue_id: int,
    db: DbSession,
) -> list[StepOption]:
    """Steps of the issue's work order — the candidates for a containment
    boundary. Empty while the issue is not linked to a work order."""
    issue = db.query(Issue).filter(Issue.id == issue_id, Issue.deleted_at.is_(None)).first()
    if not issue:
        raise HTTPException(status_code=404, detail="Issue not found")
    if issue.procedure_instance_id is None:
        return []
    steps = (
        db.query(StepExecution)
        .filter(StepExecution.instance_id == issue.procedure_instance_id)
        .order_by(StepExecution.step_number)
        .all()
    )
    instance = db.get(ProcedureInstance, issue.procedure_instance_id)
    titles = version_step_map(db.get(ProcedureVersion, instance.version_id) if instance else None)
    return [
        StepOption(
            id=s.id,
            label=scope_label(s),
            title=s.title or titles.get(s.step_number, {}).get("title", ""),
        )
        for s in steps
    ]


@router.get("/{issue_id}/holding", response_model=list[dict])
def get_issue_holding(
    issue_id: int,
    db: DbSession,
) -> list[dict]:
    """What this issue is stopping: [{label, scope, href}], empty for advisory
    or dispositioned issues. The disposition confirm dialog reads its
    consequence sentence from here."""
    issue = db.query(Issue).filter(Issue.id == issue_id, Issue.deleted_at.is_(None)).first()
    if not issue:
        raise HTTPException(status_code=404, detail="Issue not found")

    return holding_readout(db, issue)


@router.patch("/{issue_id}", response_model=IssueResponse)
def update_issue(
    issue_id: int,
    data: IssueUpdate,
    db: DbSession,
    user_id: CurrentUserId,
) -> IssueResponse:
    """Update an issue."""
    issue = db.query(Issue).filter(Issue.id == issue_id, Issue.deleted_at.is_(None)).first()
    if not issue:
        raise HTTPException(status_code=404, detail="Issue not found")

    old_values = get_model_dict(issue)
    previous_assignee = issue.assigned_to_id
    previous_status = _get_enum_val(issue, "status")
    # The run this issue holds *now*. Re-pointing an issue at a different work
    # order is rare and is handled as a plain edit: the derived hold display
    # stays correct either way, only the transition notification is skipped.
    watched_instance = issue.procedure_instance_id
    was_blocking = notifications.has_blocker(db, watched_instance)

    if data.title is not None:
        issue.title = data.title
    if data.description is not None:
        issue.description = data.description
    if data.issue_type is not None:
        try:
            issue.issue_type = IssueType(data.issue_type)
        except ValueError as err:
            raise HTTPException(
                status_code=400, detail=f"Invalid issue type: {data.issue_type}"
            ) from err
    if data.status is not None:
        try:
            new_status = IssueStatus(data.status)
        except ValueError as err:
            raise HTTPException(status_code=400, detail=f"Invalid status: {data.status}") from err
        if new_status == IssueStatus.CLOSED:
            _validate_close(issue, data)
        issue.status = new_status
    if data.priority is not None:
        try:
            issue.priority = IssuePriority(data.priority)
        except ValueError as err:
            raise HTTPException(
                status_code=400, detail=f"Invalid priority: {data.priority}"
            ) from err
    if data.should_be is not None:
        issue.should_be = data.should_be
    if data.actual is not None:
        issue.actual = data.actual
    if data.steps_to_reproduce is not None:
        issue.steps_to_reproduce = data.steps_to_reproduce
    if data.expected_behavior is not None:
        issue.expected_behavior = data.expected_behavior
    if data.actual_behavior is not None:
        issue.actual_behavior = data.actual_behavior
    if data.expected_benefit is not None:
        issue.expected_benefit = data.expected_benefit
    # Links: an explicit null clears, an omitted field is untouched.
    sent = data.model_fields_set
    if "part_id" in sent:
        if data.part_id is not None and db.get(Part, data.part_id) is None:
            raise HTTPException(status_code=400, detail=f"Part {data.part_id} not found")
        issue.part_id = data.part_id
    if "procedure_id" in sent:
        if data.procedure_id is not None and db.get(MasterProcedure, data.procedure_id) is None:
            raise HTTPException(status_code=400, detail=f"Procedure {data.procedure_id} not found")
        issue.procedure_id = data.procedure_id
    if "procedure_instance_id" in sent and data.procedure_instance_id != watched_instance:
        _relink_instance(db, issue, data.procedure_instance_id)
    if data.root_cause is not None:
        issue.root_cause = data.root_cause
    if data.corrective_action is not None:
        issue.corrective_action = data.corrective_action
    if data.disposition_type is not None or data.disposition_rationale is not None:
        # Drafting the disposition panel is a PATCH; the signature is not.
        # A signed disposition is immutable — a different decision is a new
        # signature, not an edit.
        if issue.dispositioned:
            raise HTTPException(
                status_code=400,
                detail="Disposition already signed; it cannot be edited",
            )
        if data.disposition_type is not None:
            if data.disposition_type == "":
                issue.disposition_type = None
            else:
                try:
                    issue.disposition_type = DispositionType(data.disposition_type)
                except ValueError as err:
                    raise HTTPException(
                        status_code=400,
                        detail=f"Invalid disposition type: {data.disposition_type}",
                    ) from err
        if data.disposition_rationale is not None:
            issue.disposition_rationale = data.disposition_rationale
    if "assigned_to_id" in sent:
        if data.assigned_to_id is not None and db.get(User, data.assigned_to_id) is None:
            raise HTTPException(status_code=400, detail=f"User {data.assigned_to_id} not found")
        issue.assigned_to_id = data.assigned_to_id

    log_update(db, issue, old_values, user_id)

    # Closing an issue can release the last hold on a work order.
    notifications.blocking_transition(db, watched_instance, was_blocking, user_id, issue)
    if issue.assigned_to_id is not None and issue.assigned_to_id != previous_assignee:
        notifications.issue_assigned(db, issue, user_id)
    if (
        _get_enum_val(issue, "status") == IssueStatus.CLOSED.value
        and previous_status != IssueStatus.CLOSED.value
    ):
        notifications.issue_closed(db, issue, user_id)

    db.commit()
    db.refresh(issue)

    return _issue_to_response(issue)


def _relink_instance(db, issue: Issue, new_instance_id: int | None) -> None:
    """Point the issue at another work order, or detach it.

    Detaching an undispositioned containment-bearing issue would silently
    release its hold, so that is refused; so is leaving a step anchor behind
    in the old work order."""
    if new_instance_id is None:
        if issue.is_blocking:
            raise HTTPException(
                status_code=400,
                detail=f"{issue.issue_number} is undispositioned; "
                "sign a disposition before detaching its work order",
            )
    else:
        wo = db.get(ProcedureInstance, new_instance_id)
        if wo is None:
            raise HTTPException(status_code=400, detail=f"Work order {new_instance_id} not found")
        if issue.procedure_id is None:
            issue.procedure_id = wo.procedure_id
    for step_id in (issue.containment_step_id, issue.raised_step_id):
        if step_id is None:
            continue
        step = db.get(StepExecution, step_id)
        if step is not None and step.instance_id != new_instance_id:
            raise HTTPException(
                status_code=400,
                detail="A step anchor belongs to the current work order; clear the boundary first",
            )
    issue.procedure_instance_id = new_instance_id


def _validate_close(issue: Issue, data: IssueUpdate | None = None) -> None:
    """Closing an undispositioned containment-bearing issue is impossible —
    disposition first, always. Advisory issues close freely. NC-type issues
    additionally require corrective action text (type-based, any containment)."""
    if issue.containment_bearing and not issue.dispositioned:
        raise HTTPException(
            status_code=400,
            detail=f"{issue.issue_number} is undispositioned; sign a disposition before closing",
        )
    issue_type = _get_enum_val(issue, "issue_type")
    if issue_type == IssueType.NON_CONFORMANCE.value:
        corrective = issue.corrective_action
        if data is not None and data.corrective_action is not None:
            corrective = data.corrective_action
        if not (corrective or "").strip():
            raise HTTPException(
                status_code=400,
                detail=f"{issue.issue_number} is a non-conformance; "
                "corrective action is required to close",
            )


@router.post("/{issue_id}/disposition", response_model=IssueResponse)
async def sign_disposition(
    issue_id: int,
    data: DispositionSign,
    db: DbSession,
    user_id: CurrentUserId,
) -> IssueResponse:
    """Sign the disposition — sets the signature and releases every
    containment this issue holds, live."""
    issue = db.query(Issue).filter(Issue.id == issue_id, Issue.deleted_at.is_(None)).first()
    if not issue:
        raise HTTPException(status_code=404, detail="Issue not found")

    if _get_enum_val(issue, "status") == IssueStatus.CLOSED.value:
        raise HTTPException(status_code=400, detail="Issue is closed")
    if issue.dispositioned:
        raise HTTPException(status_code=400, detail="Disposition already signed")
    if not issue.containment_bearing:
        raise HTTPException(
            status_code=400,
            detail=f"{issue.issue_number} is advisory; there is no disposition to sign",
        )

    try:
        disposition_type = DispositionType(data.disposition_type)
    except ValueError as err:
        raise HTTPException(
            status_code=400, detail=f"Invalid disposition type: {data.disposition_type}"
        ) from err

    old_values = get_model_dict(issue)
    was_blocking = notifications.has_blocker(db, issue.procedure_instance_id)
    issue.disposition_type = disposition_type
    issue.disposition_rationale = data.disposition_rationale
    issue.dispositioned_by_id = user_id
    issue.dispositioned_at = datetime.now(UTC)

    log_update(db, issue, old_values, user_id)
    db.flush()
    recheck_instance_completion(db, issue)
    # Signing releases this issue's containment — the run may now be clear.
    notifications.issue_dispositioned(db, issue, user_id)
    notifications.blocking_transition(db, issue.procedure_instance_id, was_blocking, user_id, issue)
    db.commit()
    db.refresh(issue)

    # Held rows recover their controls without reload.
    if issue.procedure_instance_id is not None:
        await emit_issue_dispositioned(issue.procedure_instance_id, issue.id, issue.issue_number)

    return _issue_to_response(issue)


@router.post("/{issue_id}/containment", response_model=IssueResponse)
def set_containment(
    issue_id: int,
    data: ContainmentChange,
    db: DbSession,
    user_id: CurrentUserId,
) -> IssueResponse:
    """Change containment scope. Widening is one click; narrowing (or
    downgrading to advisory) releases a hold — a decision, not an edit — and
    is audited with a note."""
    issue = db.query(Issue).filter(Issue.id == issue_id, Issue.deleted_at.is_(None)).first()
    if not issue:
        raise HTTPException(status_code=404, detail="Issue not found")

    try:
        new_containment = Containment(data.containment)
    except ValueError as err:
        raise HTTPException(
            status_code=400, detail=f"Invalid containment: {data.containment}"
        ) from err

    old_containment = _get_enum_val(issue, "containment")
    narrowing = CONTAINMENT_RANK[new_containment.value] < CONTAINMENT_RANK[old_containment]
    if narrowing and issue.is_blocking and not (data.note or "").strip():
        raise HTTPException(
            status_code=400,
            detail=f"Narrowing containment {old_containment} → {new_containment.value} "
            "releases a hold; a note is required",
        )

    old_values = get_model_dict(issue)
    was_blocking = notifications.has_blocker(db, issue.procedure_instance_id)
    issue.containment = new_containment
    # Boundary re-binding uses explicit presence, not None-skip: an omitted
    # containment_step_id leaves the boundary untouched, while an explicit null
    # clears it (a mis-bound boundary was previously immutable — F8). A non-null
    # boundary must belong to this issue's work order; it seeds the WO on a
    # still-unlinked issue and is rejected when it names a different one.
    if "containment_step_id" in data.model_fields_set:
        new_step_id = data.containment_step_id
        if new_step_id is not None:
            step = db.query(StepExecution).filter(StepExecution.id == new_step_id).first()
            if step is None:
                raise HTTPException(status_code=404, detail=f"Step {new_step_id} not found")
            if issue.procedure_instance_id is None:
                issue.procedure_instance_id = step.instance_id
            elif step.instance_id != issue.procedure_instance_id:
                raise HTTPException(
                    status_code=400,
                    detail=f"Step {new_step_id} belongs to a different work order than this issue",
                )
        issue.containment_step_id = new_step_id
    log_update(db, issue, old_values, user_id)

    if narrowing and (data.note or "").strip():
        comment = IssueComment(
            issue_id=issue.id,
            user_id=user_id,
            body=f"Containment narrowed {old_containment} → {new_containment.value}: {data.note}",
        )
        db.add(comment)
        db.flush()
        log_create(db, comment, user_id)

    if narrowing:
        db.flush()
        recheck_instance_completion(db, issue)

    # Downgrading to advisory releases the hold; widening onto a clear run
    # creates one.
    notifications.blocking_transition(db, issue.procedure_instance_id, was_blocking, user_id, issue)

    db.commit()
    db.refresh(issue)

    return _issue_to_response(issue)


@router.delete("/{issue_id}", status_code=204)
def delete_issue(
    issue_id: int,
    db: DbSession,
    user_id: CurrentUserId,
) -> None:
    """Soft delete an issue."""
    issue = db.query(Issue).filter(Issue.id == issue_id, Issue.deleted_at.is_(None)).first()
    if not issue:
        raise HTTPException(status_code=404, detail="Issue not found")

    was_blocking = notifications.has_blocker(db, issue.procedure_instance_id)
    issue.deleted_at = datetime.now(UTC)
    log_delete(db, issue, user_id)
    db.flush()
    recheck_instance_completion(db, issue)
    # Deleting the last blocker frees the run just as signing one does.
    notifications.blocking_transition(db, issue.procedure_instance_id, was_blocking, user_id, issue)
    db.commit()


# ============ Issue Comments ============


@router.post("/{issue_id}/comments", response_model=IssueCommentResponse, status_code=201)
def create_issue_comment(
    issue_id: int,
    data: IssueCommentCreate,
    db: DbSession,
    user_id: CurrentUserId,
) -> IssueCommentResponse:
    """Add a comment to an issue."""
    issue = db.query(Issue).filter(Issue.id == issue_id, Issue.deleted_at.is_(None)).first()
    if not issue:
        raise HTTPException(status_code=404, detail="Issue not found")

    comment = IssueComment(
        issue_id=issue_id,
        user_id=user_id,
        body=data.body,
    )
    db.add(comment)
    db.flush()
    log_create(db, comment, user_id)
    notifications.issue_commented(db, issue, data.body, user_id)
    db.commit()
    db.refresh(comment)

    return IssueCommentResponse.of(comment)


@router.get("/{issue_id}/comments", response_model=list[IssueCommentResponse])
def list_issue_comments(
    issue_id: int,
    db: DbSession,
) -> list[IssueCommentResponse]:
    """List comments for an issue."""
    issue = db.query(Issue).filter(Issue.id == issue_id, Issue.deleted_at.is_(None)).first()
    if not issue:
        raise HTTPException(status_code=404, detail="Issue not found")

    comments = (
        db.query(IssueComment)
        .filter(IssueComment.issue_id == issue_id)
        .order_by(IssueComment.created_at)
        .all()
    )

    return [IssueCommentResponse.of(c) for c in comments]
