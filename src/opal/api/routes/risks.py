"""Risks API routes — scenarios, dispositions, acceptance (issue #40).

Enforcement lives in opal.risks (shared with MCP); routes translate
RiskDispositionError to HTTP 409 and own the transaction.
"""

from datetime import UTC, datetime

from fastapi import APIRouter, HTTPException, Query
from pydantic import BaseModel, Field

from opal.api.deps import CurrentUserId, DbSession
from opal.core.audit import get_model_dict, log_create, log_delete, log_update
from opal.core.designators import generate_issue_number, generate_risk_number
from opal.db.models.issue import Issue, IssueStatus, IssueType
from opal.db.models.risk import Risk, RiskDisposition, RiskIssueLink, RiskIssueRole
from opal.risks.dispositions import (
    OPEN_DISPOSITIONS,
    RiskDispositionError,
    accept,
    apply_acceptance_invalidation,
    set_disposition,
    stamp_review,
)
from opal.risks.lint import lint_scenario
from opal.risks.readiness import readiness

router = APIRouter(prefix="/risks", tags=["risks"])


# ============ Schemas ============


class LinkedIssueSummary(BaseModel):
    """An issue linked to a risk, with its live status inline."""

    issue_id: int
    issue_number: str
    title: str
    status: str
    role: str


class RiskResponse(BaseModel):
    """Risk response."""

    id: int
    risk_number: str
    title: str
    description: str | None = None

    condition: str | None = None
    departure: str | None = None
    asset_part_id: int | None = None
    asset_text: str | None = None
    consequence: str | None = None
    asset_display: str | None = None
    statement: str | None = None

    disposition: str
    owner_id: int | None = None
    owner_name: str | None = None

    probability: int
    impact: int
    score: int
    severity: str
    residual_probability: int | None = None
    residual_impact: int | None = None
    residual_score: int | None = None
    residual_severity: str | None = None

    accepted_by_id: int | None = None
    accepted_by_name: str | None = None
    accepted_at: datetime | None = None
    acceptance_rationale: str | None = None

    watch_observable: str | None = None
    watch_threshold: str | None = None
    watch_contingency: str | None = None

    last_reviewed_at: datetime | None = None
    last_reviewed_by_id: int | None = None

    realized_issue_id: int | None = None
    linked_issues: list[LinkedIssueSummary] = []

    acceptance_invalidated: bool = False

    created_at: datetime
    updated_at: datetime

    model_config = {"from_attributes": True}


class RiskListResponse(BaseModel):
    """Paginated risk list."""

    items: list[RiskResponse]
    total: int
    page: int
    page_size: int


class RiskCreate(BaseModel):
    """Create risk request."""

    title: str = Field(..., min_length=1, max_length=255)
    description: str | None = None
    condition: str | None = None
    departure: str | None = None
    asset_part_id: int | None = None
    asset_text: str | None = None
    consequence: str | None = None
    owner_id: int | None = None
    probability: int = Field(3, ge=1, le=5)
    impact: int = Field(3, ge=1, le=5)
    residual_probability: int | None = Field(None, ge=1, le=5)
    residual_impact: int | None = Field(None, ge=1, le=5)
    watch_observable: str | None = None
    watch_threshold: str | None = None
    watch_contingency: str | None = None


class RiskUpdate(BaseModel):
    """Update risk request. Absent fields are untouched; explicit nulls clear.

    disposition is deliberately absent — transitions go through
    POST /{id}/disposition where the state machine enforces requirements.
    """

    title: str | None = Field(None, min_length=1, max_length=255)
    description: str | None = None
    condition: str | None = None
    departure: str | None = None
    asset_part_id: int | None = None
    asset_text: str | None = None
    consequence: str | None = None
    owner_id: int | None = None
    probability: int | None = Field(None, ge=1, le=5)
    impact: int | None = Field(None, ge=1, le=5)
    residual_probability: int | None = Field(None, ge=1, le=5)
    residual_impact: int | None = Field(None, ge=1, le=5)
    acceptance_rationale: str | None = None
    watch_observable: str | None = None
    watch_threshold: str | None = None
    watch_contingency: str | None = None


class LintRequest(BaseModel):
    """Pre-save scenario lint request."""

    condition: str | None = None
    departure: str | None = None
    consequence: str | None = None


class DispositionRequest(BaseModel):
    """Disposition transition request."""

    disposition: str
    note: str | None = None
    realized_issue_id: int | None = None


class AcceptRequest(BaseModel):
    """Acceptance request — the signature; rationale may come from the form."""

    rationale: str | None = None


class LinkIssueRequest(BaseModel):
    """Link an existing issue to a risk."""

    issue_id: int
    role: str = RiskIssueRole.MITIGATION.value


class SpawnIssueRequest(BaseModel):
    """Create a new issue and attach it to the risk in one step.

    role mitigation/research creates a TASK and a link row; role realized
    creates a NON_CONFORMANCE and sets realized_issue_id (no link row —
    realization is a dedicated pointer, not a response).
    """

    role: str
    title: str = Field(..., min_length=1, max_length=255)
    description: str | None = None


class ReviewStampRequest(BaseModel):
    """Bulk review stamp — one click at gate time."""

    risk_ids: list[int] = Field(..., min_length=1)


# ============ Helpers ============


def _get_risk(db: DbSession, risk_id: int) -> Risk:
    risk = db.query(Risk).filter(Risk.id == risk_id, Risk.deleted_at.is_(None)).first()
    if not risk:
        raise HTTPException(status_code=404, detail="Risk not found")
    return risk


def _risk_to_response(risk: Risk, acceptance_invalidated: bool = False) -> RiskResponse:
    """Convert Risk model to response."""
    return RiskResponse(
        id=risk.id,
        risk_number=risk.risk_number,
        title=risk.title,
        description=risk.description,
        condition=risk.condition,
        departure=risk.departure,
        asset_part_id=risk.asset_part_id,
        asset_text=risk.asset_text,
        consequence=risk.consequence,
        asset_display=risk.asset_display,
        statement=risk.statement,
        disposition=risk.disposition,
        owner_id=risk.owner_id,
        owner_name=risk.owner.name if risk.owner else None,
        probability=risk.probability,
        impact=risk.impact,
        score=risk.score,
        severity=risk.severity,
        residual_probability=risk.residual_probability,
        residual_impact=risk.residual_impact,
        residual_score=risk.residual_score,
        residual_severity=risk.residual_severity,
        accepted_by_id=risk.accepted_by_id,
        accepted_by_name=risk.accepted_by.name if risk.accepted_by else None,
        accepted_at=risk.accepted_at,
        acceptance_rationale=risk.acceptance_rationale,
        watch_observable=risk.watch_observable,
        watch_threshold=risk.watch_threshold,
        watch_contingency=risk.watch_contingency,
        last_reviewed_at=risk.last_reviewed_at,
        last_reviewed_by_id=risk.last_reviewed_by_id,
        realized_issue_id=risk.realized_issue_id,
        linked_issues=[
            LinkedIssueSummary(
                issue_id=link.issue_id,
                issue_number=link.issue.issue_number,
                title=link.issue.title,
                status=link.issue.status.value
                if hasattr(link.issue.status, "value")
                else link.issue.status,
                role=link.role,
            )
            for link in risk.issue_links
            if link.issue is not None and link.issue.deleted_at is None
        ],
        acceptance_invalidated=acceptance_invalidated,
        created_at=risk.created_at,
        updated_at=risk.updated_at,
    )


def _validate_asset_pair(risk: Risk) -> None:
    if risk.asset_part_id is not None and (risk.asset_text or "").strip():
        raise HTTPException(
            status_code=400,
            detail="asset_part_id and asset_text are exclusive — exactly one names the asset",
        )


# ============ Utility Endpoints ============


@router.get("/dispositions", response_model=list[str])
def get_risk_dispositions() -> list[str]:
    """Get all risk dispositions."""
    return [d.value for d in RiskDisposition]


@router.post("/lint")
def lint_risk_scenario(data: LintRequest) -> dict:
    """Lint scenario fields before save. Findings are keyed by field."""
    findings = lint_scenario(
        condition=data.condition,
        departure=data.departure,
        consequence=data.consequence,
    )
    return {
        "findings": {
            field: [f.to_dict() for f in field_findings]
            for field, field_findings in findings.items()
        },
        "would_block_accept": any(
            f.severity == "block_accept"
            for field_findings in findings.values()
            for f in field_findings
        ),
    }


@router.get("/matrix")
def get_risk_matrix(db: DbSession) -> dict:
    """Risk matrix data: current (solid) and residual (hollow) marker counts."""
    risks = (
        db.query(Risk)
        .filter(Risk.deleted_at.is_(None))
        .filter(Risk.disposition.in_(OPEN_DISPOSITIONS))
        .all()
    )

    matrix = [[0 for _ in range(5)] for _ in range(5)]
    residual_matrix = [[0 for _ in range(5)] for _ in range(5)]

    for risk in risks:
        matrix[risk.probability - 1][risk.impact - 1] += 1
        if risk.residual_probability is not None and risk.residual_impact is not None:
            residual_matrix[risk.residual_probability - 1][risk.residual_impact - 1] += 1

    return {
        "matrix": matrix,
        "residual_matrix": residual_matrix,
        "labels": {
            "probability": [
                "1 - Rare",
                "2 - Unlikely",
                "3 - Possible",
                "4 - Likely",
                "5 - Almost Certain",
            ],
            "impact": ["1 - Negligible", "2 - Minor", "3 - Moderate", "4 - Major", "5 - Severe"],
        },
        "total_risks": len(risks),
    }


@router.post("/review-stamp")
def review_stamp(
    data: ReviewStampRequest,
    db: DbSession,
    user_id: CurrentUserId,
) -> dict:
    """Stamp last_reviewed_* on the listed risks — the entire review ceremony."""
    risks = (
        db.query(Risk).filter(Risk.id.in_(data.risk_ids), Risk.deleted_at.is_(None)).all()
    )
    if not risks:
        raise HTTPException(status_code=404, detail="No matching risks")
    count = stamp_review(db, risks, user_id)
    db.commit()
    return {
        "stamped": count,
        "reviewed_at": risks[0].last_reviewed_at.isoformat(),
    }


# ============ Risk CRUD ============


@router.get("", response_model=RiskListResponse)
def list_risks(
    db: DbSession,
    search: str | None = Query(None),
    disposition: str | None = Query(None),
    severity: str | None = Query(None),
    min_score: int | None = Query(None, ge=1, le=25),
    page: int = Query(1, ge=1),
    page_size: int = Query(50, ge=1, le=100),
) -> RiskListResponse:
    """List risks with optional filters."""
    query = db.query(Risk).filter(Risk.deleted_at.is_(None))

    if search:
        search_term = f"%{search}%"
        query = query.filter(
            Risk.title.ilike(search_term) | Risk.risk_number.ilike(search_term)
        )

    if disposition:
        query = query.filter(Risk.disposition == disposition)

    total = query.count()

    risks = query.order_by(Risk.id.desc()).offset((page - 1) * page_size).limit(page_size).all()

    # Filter by severity/min_score in Python (computed properties)
    items = [_risk_to_response(r) for r in risks]

    if severity:
        items = [i for i in items if i.severity == severity]
    if min_score:
        items = [i for i in items if i.score >= min_score]

    return RiskListResponse(
        items=items,
        total=total,
        page=page,
        page_size=page_size,
    )


@router.post("", response_model=RiskResponse, status_code=201)
def create_risk(
    data: RiskCreate,
    db: DbSession,
    user_id: CurrentUserId,
) -> RiskResponse:
    """Create a new risk."""
    risk = Risk(
        risk_number=generate_risk_number(db),
        disposition=RiskDisposition.OPEN.value,
        **data.model_dump(),
    )
    _validate_asset_pair(risk)
    db.add(risk)
    db.flush()

    log_create(db, risk, user_id)
    db.commit()
    db.refresh(risk)

    return _risk_to_response(risk)


@router.get("/{risk_id}", response_model=RiskResponse)
def get_risk(
    risk_id: int,
    db: DbSession,
) -> RiskResponse:
    """Get risk by ID."""
    return _risk_to_response(_get_risk(db, risk_id))


@router.patch("/{risk_id}", response_model=RiskResponse)
def update_risk(
    risk_id: int,
    data: RiskUpdate,
    db: DbSession,
    user_id: CurrentUserId,
) -> RiskResponse:
    """Update a risk.

    Editing scenario or score fields on an accepted risk re-dispositions it
    to open — the signature covered the risk as scored.
    """
    risk = _get_risk(db, risk_id)
    old_values = get_model_dict(risk)

    updates = data.model_dump(exclude_unset=True)
    if updates.get("title") is None and "title" in updates:
        del updates["title"]  # title is required; explicit null cannot clear it
    # Setting one asset form clears the other — exactly one names the asset.
    if updates.get("asset_part_id") is not None and "asset_text" not in updates:
        updates["asset_text"] = None
    if (updates.get("asset_text") or "").strip() and "asset_part_id" not in updates:
        updates["asset_part_id"] = None

    for field, value in updates.items():
        setattr(risk, field, value)
    _validate_asset_pair(risk)

    log_update(db, risk, old_values, user_id)
    invalidated = apply_acceptance_invalidation(db, risk, old_values, user_id)
    db.commit()
    db.refresh(risk)

    return _risk_to_response(risk, acceptance_invalidated=invalidated)


@router.delete("/{risk_id}", status_code=204)
def delete_risk(
    risk_id: int,
    db: DbSession,
    user_id: CurrentUserId,
) -> None:
    """Soft delete a risk."""
    risk = _get_risk(db, risk_id)
    risk.deleted_at = datetime.now(UTC)
    log_delete(db, risk, user_id)
    db.commit()


# ============ Acceptance & Dispositions ============


@router.get("/{risk_id}/readiness")
def get_risk_readiness(risk_id: int, db: DbSession) -> dict:
    """Acceptance readiness checks for the panel."""
    return readiness(db, _get_risk(db, risk_id))


@router.post("/{risk_id}/disposition", response_model=RiskResponse)
def set_risk_disposition(
    risk_id: int,
    data: DispositionRequest,
    db: DbSession,
    user_id: CurrentUserId,
) -> RiskResponse:
    """Transition the risk's disposition; 409 names each unmet requirement."""
    risk = _get_risk(db, risk_id)

    if data.realized_issue_id is not None:
        issue = (
            db.query(Issue)
            .filter(Issue.id == data.realized_issue_id, Issue.deleted_at.is_(None))
            .first()
        )
        if not issue:
            raise HTTPException(status_code=404, detail="Realized issue not found")
        old_values = get_model_dict(risk)
        risk.realized_issue_id = issue.id
        log_update(db, risk, old_values, user_id)

    try:
        set_disposition(db, risk, data.disposition, user_id, note=data.note)
    except RiskDispositionError as err:
        db.rollback()
        raise HTTPException(status_code=409, detail=str(err)) from err

    db.commit()
    db.refresh(risk)
    return _risk_to_response(risk)


@router.post("/{risk_id}/accept", response_model=RiskResponse)
def accept_risk(
    risk_id: int,
    data: AcceptRequest,
    db: DbSession,
    user_id: CurrentUserId,
) -> RiskResponse:
    """Accept the risk — the signature moment; session user signs."""
    risk = _get_risk(db, risk_id)
    try:
        accept(db, risk, user_id, rationale=data.rationale)
    except RiskDispositionError as err:
        db.rollback()
        raise HTTPException(status_code=409, detail=str(err)) from err

    db.commit()
    db.refresh(risk)
    return _risk_to_response(risk)


# ============ Linked Issues ============


def _validate_role(role: str) -> None:
    if role not in {r.value for r in RiskIssueRole}:
        raise HTTPException(status_code=400, detail=f"Invalid role: {role}")


@router.post("/{risk_id}/issues", response_model=RiskResponse, status_code=201)
def link_issue(
    risk_id: int,
    data: LinkIssueRequest,
    db: DbSession,
    user_id: CurrentUserId,
) -> RiskResponse:
    """Link an existing issue to the risk."""
    risk = _get_risk(db, risk_id)
    _validate_role(data.role)

    issue = db.query(Issue).filter(Issue.id == data.issue_id, Issue.deleted_at.is_(None)).first()
    if not issue:
        raise HTTPException(status_code=404, detail="Issue not found")
    if any(link.issue_id == issue.id for link in risk.issue_links):
        raise HTTPException(status_code=409, detail=f"{issue.issue_number} is already linked")

    link = RiskIssueLink(risk_id=risk.id, issue_id=issue.id, role=data.role)
    db.add(link)
    db.flush()
    log_create(db, link, user_id)
    db.commit()
    db.refresh(risk)
    return _risk_to_response(risk)


@router.post("/{risk_id}/issues/spawn", response_model=RiskResponse, status_code=201)
def spawn_issue(
    risk_id: int,
    data: SpawnIssueRequest,
    db: DbSession,
    user_id: CurrentUserId,
) -> RiskResponse:
    """Create a new issue and attach it: mitigation/research link, or realization."""
    risk = _get_risk(db, risk_id)
    roles = {r.value for r in RiskIssueRole} | {"realized"}
    if data.role not in roles:
        raise HTTPException(status_code=400, detail=f"Invalid role: {data.role}")

    issue = Issue(
        issue_number=generate_issue_number(db),
        title=data.title,
        description=data.description,
        issue_type=IssueType.NON_CONFORMANCE if data.role == "realized" else IssueType.TASK,
        status=IssueStatus.OPEN,
    )
    db.add(issue)
    db.flush()
    log_create(db, issue, user_id)

    if data.role == "realized":
        old_values = get_model_dict(risk)
        risk.realized_issue_id = issue.id
        log_update(db, risk, old_values, user_id)
    else:
        link = RiskIssueLink(risk_id=risk.id, issue_id=issue.id, role=data.role)
        db.add(link)
        db.flush()
        log_create(db, link, user_id)

    db.commit()
    db.refresh(risk)
    return _risk_to_response(risk)


@router.delete("/{risk_id}/issues/{issue_id}", response_model=RiskResponse)
def unlink_issue(
    risk_id: int,
    issue_id: int,
    db: DbSession,
    user_id: CurrentUserId,
) -> RiskResponse:
    """Remove a risk-issue link (the issue itself is untouched)."""
    risk = _get_risk(db, risk_id)
    link = next((x for x in risk.issue_links if x.issue_id == issue_id), None)
    if not link:
        raise HTTPException(status_code=404, detail="Link not found")

    log_delete(db, link, user_id)
    db.delete(link)
    db.commit()
    db.refresh(risk)
    return _risk_to_response(risk)
