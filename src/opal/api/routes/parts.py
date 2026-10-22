"""Parts management endpoints."""

import csv
import io
import re
from decimal import Decimal
from typing import Any, Literal

from fastapi import APIRouter, HTTPException, Query, Request, UploadFile, status
from fastapi.responses import Response
from pydantic import BaseModel, Field, field_validator
from sqlalchemy import func, or_, select

from opal.api.deps import CurrentUserId, DbSession, PaginationParams
from opal.api.routes.bom import BOMLineResponse, get_bom_line_response
from opal.api.routes.inventory import InventoryResponse, TestTemplateResponse, inventory_to_response
from opal.api.routes.requirements import get_requirement_response
from opal.config import get_active_project
from opal.core.audit import get_model_dict, log_create, log_delete, log_update
from opal.core.numbering import (
    PartNumberError,
    next_part_number,
    peek_next_part_number,
    pn_exists,
    register_part_number,
    validate_part_number,
)
from opal.core.part_lifecycle import (
    PART_DRAFT,
    PART_LIFECYCLE_STATES,
    PartLifecycleError,
    activate_part,
    ensure_identity_mutable,
    reference_counts,
)
from opal.db.models import (
    AuditLog,
    BOMLine,
    InventoryConsumption,
    InventoryRecord,
    Kit,
    MasterProcedure,
    OnshapeLink,
    Part,
    PartRequirement,
    ProcedureOutput,
    Purchase,
    PurchaseLine,
    Requirement,
    StepKit,
    Supplier,
    SupplierPart,
    TestTemplate,
    User,
)
from opal.project import tier_semantics

router = APIRouter()


class PartCreate(BaseModel):
    """Schema for creating a part."""

    name: str
    internal_pn: str | None = None  # Auto-generated if not provided
    external_pn: str | None = None
    description: str | None = None
    category: str | None = None
    unit_of_measure: str = "ea"
    # "bulk" = one OPAL per batch, "serialized" = one OPAL per unit;
    # None resolves by tier convention (see default_tracking_for_tier)
    tracking_type: str | None = None
    # Declares which sections expect content (make: BOM; buy: suppliers/POs);
    # None resolves by heuristic: buy when an external PN is given, else make
    procurement: Literal["make", "buy", "both"] | None = None
    tier: int = 1  # Tier level; must be one of the project's configured tiers
    parent_id: int | None = None  # Parent assembly if this is a child part
    reorder_point: Decimal | None = Field(None, ge=0)
    is_tooling: bool = False
    calibration_interval_days: int | None = None
    metadata: dict[str, Any] | None = None


class PartUpdate(BaseModel):
    """Schema for updating a part."""

    name: str | None = None
    internal_pn: str | None = None
    external_pn: str | None = None
    description: str | None = None
    category: str | None = None
    unit_of_measure: str | None = None
    tracking_type: str | None = None  # "bulk" or "serialized"
    procurement: Literal["make", "buy", "both"] | None = None
    tier: int | None = None
    parent_id: int | None = None
    reorder_point: Decimal | None = Field(None, ge=0)
    is_tooling: bool | None = None
    calibration_interval_days: int | None = None
    metadata: dict[str, Any] | None = None

    @field_validator("name", "unit_of_measure", "tracking_type", "tier", "is_tooling")
    @classmethod
    def _reject_explicit_null(cls, value: Any) -> Any:
        # None here means the client sent an explicit null (defaults are not
        # validated), which would land in a NOT NULL column
        if value is None:
            raise ValueError("field is not nullable; omit it to leave unchanged")
        return value


class PartResponse(BaseModel):
    """Schema for part response."""

    id: int
    internal_pn: str | None  # Auto-generated part number (e.g., PO/1-001)
    external_pn: str | None  # Manufacturer/supplier part number
    name: str
    description: str | None
    category: str | None
    unit_of_measure: str
    tracking_type: str  # "bulk" or "serialized"
    procurement: str  # "make", "buy", or "both"
    tier: int
    tier_name: str | None = None  # Populated from project config if available
    parent_id: int | None
    reorder_point: Decimal | None = None
    is_low_stock: bool = False
    is_tooling: bool = False
    calibration_interval_days: int | None = None
    metadata: dict[str, Any] | None
    total_quantity: Decimal
    lifecycle_state: str
    activated_at: str | None = None
    activation_cause: str | None = None
    created_at: str
    updated_at: str

    model_config = {"from_attributes": True}


class PartListResponse(BaseModel):
    """Schema for part list response."""

    items: list[PartResponse]
    total: int


def _tier_name(level: int) -> str | None:
    project = get_active_project()
    tier = project.get_tier(level) if project else None
    return tier.name if tier else None


def _part_response(
    part: Part, total: Decimal | None, tier_names: dict[int, str | None]
) -> PartResponse:
    """Build the response for a part given its on-hand total."""
    total = total or Decimal(0)
    return PartResponse(
        id=part.id,
        internal_pn=part.internal_pn,
        external_pn=part.external_pn,
        name=part.name,
        description=part.description,
        category=part.category,
        unit_of_measure=part.unit_of_measure,
        tracking_type=part.tracking_type,
        procurement=part.procurement,
        tier=part.tier,
        tier_name=tier_names.get(part.tier),
        parent_id=part.parent_id,
        reorder_point=part.reorder_point,
        is_low_stock=bool(part.reorder_point is not None and total < part.reorder_point),
        is_tooling=part.is_tooling,
        calibration_interval_days=part.calibration_interval_days,
        metadata=part.metadata_,
        total_quantity=total,
        lifecycle_state=part.lifecycle_state,
        activated_at=part.activated_at.isoformat() if part.activated_at else None,
        activation_cause=part.activation_cause,
        created_at=part.created_at.isoformat(),
        updated_at=part.updated_at.isoformat(),
    )


def get_part_with_quantity(db: DbSession, part: Part) -> PartResponse:
    """Convert part to response with total quantity calculated."""
    total_qty = (
        db.query(func.coalesce(func.sum(InventoryRecord.quantity), 0))
        .filter(InventoryRecord.part_id == part.id)
        .scalar()
    )
    return _part_response(part, total_qty, {part.tier: _tier_name(part.tier)})


# Columns the list can be ordered by (the "stock" key orders by on-hand total)
_SORT_KEYS = {
    "id",
    "internal_pn",
    "external_pn",
    "name",
    "category",
    "tier",
    "state",
    "procurement",
    "unit_of_measure",
    "stock",
    "created_at",
    "updated_at",
}


@router.get("", response_model=PartListResponse)
def list_parts(
    db: DbSession,
    pagination: PaginationParams,
    search: str | None = Query(None, description="Search in name, PNs, description"),
    category: str | None = Query(None, description="Filter by category"),
    tier: int | None = Query(
        None, description="Filter by tier level (as configured in the project)"
    ),
    parent_id: int | None = Query(None, description="Filter by parent assembly ID"),
    top_level: bool = Query(
        False, description="Only show parts with no parent (top-level assemblies)"
    ),
    has_parent: bool | None = Query(
        None, description="true: only sub-components; false: only top-level parts"
    ),
    low_stock: bool = Query(False, description="Only show parts below reorder point"),
    state: str | None = Query(None, description="Filter by lifecycle state (draft/active)"),
    procurement: Literal["make", "buy", "both"] | None = Query(
        None, description="Filter by procurement declaration"
    ),
    tooling: bool | None = Query(None, description="true: only tooling; false: exclude tooling"),
    sort_by: str = Query("id", description=f"One of: {', '.join(sorted(_SORT_KEYS))}"),
    sort_order: Literal["asc", "desc"] = Query("desc"),
) -> PartListResponse:
    """List parts with filtering, sorting and pagination."""
    if sort_by not in _SORT_KEYS:
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail=f"Unknown sort key '{sort_by}' (expected one of {', '.join(sorted(_SORT_KEYS))})",
        )

    # On-hand total per part, aggregated once and outer-joined so the whole
    # page comes from a single query
    qty_subq = (
        db.query(
            InventoryRecord.part_id.label("part_id"),
            func.sum(InventoryRecord.quantity).label("total_qty"),
        )
        .group_by(InventoryRecord.part_id)
        .subquery()
    )
    total_qty = func.coalesce(qty_subq.c.total_qty, 0)
    query = (
        db.query(Part, total_qty.label("total_qty"))
        .outerjoin(qty_subq, Part.id == qty_subq.c.part_id)
        .filter(Part.deleted_at.is_(None))
    )

    if state:
        if state not in PART_LIFECYCLE_STATES:
            raise HTTPException(
                status_code=status.HTTP_400_BAD_REQUEST,
                detail=f"Unknown lifecycle state '{state}' (expected draft or active)",
            )
        query = query.filter(Part.lifecycle_state == state)

    if search:
        search_term = f"%{search}%"
        query = query.filter(
            or_(
                Part.name.ilike(search_term),
                Part.internal_pn.ilike(search_term),
                Part.external_pn.ilike(search_term),
                Part.description.ilike(search_term),
            )
        )
    if category:
        query = query.filter(Part.category == category)
    if tier is not None:
        query = query.filter(Part.tier == tier)
    if procurement:
        query = query.filter(Part.procurement == procurement)
    if tooling is not None:
        query = query.filter(Part.is_tooling == tooling)

    if parent_id is not None:
        query = query.filter(Part.parent_id == parent_id)
    elif has_parent is not None:
        query = query.filter(Part.parent_id.isnot(None) if has_parent else Part.parent_id.is_(None))
    elif top_level:
        query = query.filter(Part.parent_id.is_(None))

    if low_stock:
        query = query.filter(Part.reorder_point.isnot(None), total_qty < Part.reorder_point)

    total = query.count()

    sort_columns = {
        "id": Part.id,
        "internal_pn": Part.internal_pn,
        "external_pn": Part.external_pn,
        "name": func.lower(Part.name),
        "category": Part.category,
        "tier": Part.tier,
        "state": Part.lifecycle_state,
        "procurement": Part.procurement,
        "unit_of_measure": Part.unit_of_measure,
        "stock": total_qty,
        "created_at": Part.created_at,
        "updated_at": Part.updated_at,
    }
    column = sort_columns[sort_by]
    ordering = column.asc() if sort_order == "asc" else column.desc()
    rows = (
        query.order_by(ordering, Part.id.desc())
        .offset(pagination.skip)
        .limit(pagination.limit)
        .all()
    )

    project = get_active_project()
    tier_names = {t.level: t.name for t in project.tiers} if project else {}
    return PartListResponse(
        items=[_part_response(part, qty, tier_names) for part, qty in rows],
        total=total,
    )


def default_tracking_for_tier(tier: int) -> str:
    """Tracking type a part gets when none is given: the configured tier's
    default_tracking (legacy level rules when the tier isn't configured).
    Editable on the part page afterwards."""
    return tier_semantics(get_active_project(), tier).default_tracking


def require_configured_tier(tier: int) -> None:
    """422 when an active project is configured and ``tier`` isn't one of its
    levels. Without a project config any tier is accepted (fallback numbering
    imposes no tier set)."""
    project = get_active_project()
    if project is not None and project.get_tier(tier) is None:
        levels = ", ".join(str(t.level) for t in project.tiers)
        raise HTTPException(
            status_code=status.HTTP_422_UNPROCESSABLE_ENTITY,
            detail=f"Unknown tier {tier} (configured tiers: {levels})",
        )


def assign_internal_pn(db: DbSession, tier: int, override: str | None) -> str:
    """Resolve a part's internal PN: validated override or the next number.

    Overrides are validated strictly against the project numbering format and
    checked for uniqueness across ALL rows including soft-deleted ones —
    retired numbers never reissue.
    """
    if not override:
        return next_part_number(db, tier)

    try:
        validate_part_number(get_active_project(), tier, override)
    except PartNumberError as e:
        raise HTTPException(status_code=status.HTTP_422_UNPROCESSABLE_ENTITY, detail=str(e)) from e
    if pn_exists(db, override):
        raise HTTPException(
            status_code=status.HTTP_409_CONFLICT,
            detail=f"Part number {override} is already taken (numbers are never reused, "
            "including by deleted parts)",
        )
    register_part_number(db, tier, override)
    return override


@router.post("", response_model=PartResponse, status_code=status.HTTP_201_CREATED)
def create_part(
    db: DbSession,
    part_in: PartCreate,
    user_id: CurrentUserId,
) -> PartResponse:
    """Create a new part. Parts are born draft; activation is a deliberate act."""
    # Validate parent exists if specified
    if part_in.parent_id is not None:
        parent = (
            db.query(Part).filter(Part.id == part_in.parent_id, Part.deleted_at.is_(None)).first()
        )
        if not parent:
            raise HTTPException(
                status_code=status.HTTP_400_BAD_REQUEST,
                detail=f"Parent part {part_in.parent_id} not found",
            )

    require_configured_tier(part_in.tier)
    internal_pn = assign_internal_pn(db, part_in.tier, part_in.internal_pn)

    part = Part(
        name=part_in.name,
        internal_pn=internal_pn,
        external_pn=part_in.external_pn,
        description=part_in.description,
        category=part_in.category,
        unit_of_measure=part_in.unit_of_measure,
        tracking_type=part_in.tracking_type or default_tracking_for_tier(part_in.tier),
        procurement=part_in.procurement or ("buy" if part_in.external_pn else "make"),
        tier=part_in.tier,
        parent_id=part_in.parent_id,
        reorder_point=part_in.reorder_point,
        is_tooling=part_in.is_tooling,
        calibration_interval_days=part_in.calibration_interval_days,
        metadata_=part_in.metadata,
    )
    db.add(part)
    db.commit()
    db.refresh(part)

    log_create(db, part, user_id)
    db.commit()

    return get_part_with_quantity(db, part)


class NextPnResponse(BaseModel):
    """Preview of the next part number for a tier."""

    part_number: str
    sequence: int
    tier: int
    tier_name: str | None = None
    default_tracking: str


@router.get("/next-pn", response_model=NextPnResponse)
def preview_next_pn(
    db: DbSession,
    tier: int = Query(..., description="Tier level to preview the next number for"),
) -> NextPnResponse:
    """Preview the next part number for a tier without consuming it."""
    try:
        part_number, sequence = peek_next_part_number(db, tier)
    except ValueError as e:
        raise HTTPException(status_code=status.HTTP_400_BAD_REQUEST, detail=str(e)) from e

    project = get_active_project()
    tier_config = project.get_tier(tier) if project else None
    return NextPnResponse(
        part_number=part_number,
        sequence=sequence,
        tier=tier,
        tier_name=tier_config.name if tier_config else None,
        default_tracking=default_tracking_for_tier(tier),
    )


class ReserveRequest(BaseModel):
    """Request to reserve a block of part numbers as draft parts."""

    tier: int = 1
    count: int
    name_prefix: str | None = None


class ReserveResponse(BaseModel):
    """A reserved block of draft parts."""

    parts: list[PartResponse]
    first_pn: str
    last_pn: str


@router.post("/reserve", response_model=ReserveResponse, status_code=status.HTTP_201_CREATED)
def reserve_part_numbers(
    db: DbSession,
    reserve_in: ReserveRequest,
    user_id: CurrentUserId,
) -> ReserveResponse:
    """Reserve a block of part numbers as real draft rows.

    Serves label pre-printing and vendor pre-allocation: unused reservations
    are visibly stale drafts a human can soft-delete, not invisible holes.
    """
    if not 1 <= reserve_in.count <= 500:
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail="count must be between 1 and 500",
        )

    require_configured_tier(reserve_in.tier)
    prefix = reserve_in.name_prefix or "RESERVED"
    parts: list[Part] = []
    try:
        for _ in range(reserve_in.count):
            pn = next_part_number(db, reserve_in.tier)
            # Name from the PN's sequence digits so names inherit PN uniqueness
            seq_match = re.search(r"(\d+)$", pn)
            part = Part(
                name=f"{prefix}-{seq_match.group(1) if seq_match else pn}",
                internal_pn=pn,
                tier=reserve_in.tier,
            )
            db.add(part)
            db.flush()
            log_create(db, part, user_id)
            parts.append(part)
    except ValueError as e:
        raise HTTPException(status_code=status.HTTP_400_BAD_REQUEST, detail=str(e)) from e
    db.commit()
    for part in parts:
        db.refresh(part)

    return ReserveResponse(
        parts=[get_part_with_quantity(db, p) for p in parts],
        first_pn=parts[0].internal_pn,
        last_pn=parts[-1].internal_pn,
    )


class ActivateRequest(BaseModel):
    """Request body for part activation."""

    cause: str | None = None


@router.post("/{part_id}/activate", response_model=PartResponse)
def activate_part_endpoint(
    db: DbSession,
    part_id: int,
    user_id: CurrentUserId,
    activate_in: ActivateRequest | None = None,
) -> PartResponse:
    """Activate a draft part, locking its identity permanently."""
    part = db.query(Part).filter(Part.id == part_id, Part.deleted_at.is_(None)).first()
    if not part:
        raise HTTPException(
            status_code=status.HTTP_404_NOT_FOUND,
            detail=f"Part {part_id} not found",
        )

    cause = (activate_in.cause if activate_in else None) or "manual activation from part page"
    old_values = get_model_dict(part)
    try:
        activate_part(db, part, user_id, cause)
    except PartLifecycleError as e:
        raise HTTPException(status_code=status.HTTP_409_CONFLICT, detail=str(e)) from e

    log_update(db, part, old_values, user_id)
    db.commit()
    db.refresh(part)
    return get_part_with_quantity(db, part)


@router.get("/categories")
def list_categories(db: DbSession) -> list[str]:
    """List all unique part categories."""
    categories = (
        db.query(Part.category)
        .filter(Part.deleted_at.is_(None), Part.category.isnot(None))
        .distinct()
        .all()
    )
    return sorted([c[0] for c in categories if c[0]])


class SchemaTier(BaseModel):
    """A configured tier with the semantics that drive numbering and tracking."""

    level: int
    name: str
    code: str
    description: str = ""
    default_tracking: str
    require_lot: bool
    auto_serial: bool


class CustomFieldDef(BaseModel):
    """A project-defined part field, stored under ``metadata[key]``."""

    key: str
    label: str
    type: Literal["text", "number", "boolean", "select"] = "text"
    options: list[str] = []
    default: Any = None
    required: bool = False


class PartSchema(BaseModel):
    """Everything a part form or filter needs from project configuration."""

    tiers: list[SchemaTier]
    categories: list[str]
    custom_fields: list[CustomFieldDef]
    numbering_format: str | None = None


def _custom_field_defs(raw: dict[str, Any]) -> list[CustomFieldDef]:
    """Normalise project ``custom_fields`` into definitions.

    Accepts ``key: type``, ``key: [options]`` and ``key: {label, type, options,
    default, required}`` so hand-written project configs stay valid.
    """
    defs: list[CustomFieldDef] = []
    for key, spec in raw.items():
        label = str(key).replace("_", " ").strip().title()
        if isinstance(spec, dict):
            kind = str(spec.get("type", "select" if spec.get("options") else "text"))
            options = [str(o) for o in spec.get("options", [])]
            defs.append(
                CustomFieldDef(
                    key=str(key),
                    label=str(spec.get("label", label)),
                    type=kind if kind in ("text", "number", "boolean", "select") else "text",
                    options=options,
                    default=spec.get("default"),
                    required=bool(spec.get("required", False)),
                )
            )
        elif isinstance(spec, list):
            defs.append(
                CustomFieldDef(
                    key=str(key), label=label, type="select", options=[str(o) for o in spec]
                )
            )
        else:
            kind = str(spec) if spec else "text"
            defs.append(
                CustomFieldDef(
                    key=str(key),
                    label=label,
                    type=kind if kind in ("text", "number", "boolean", "select") else "text",
                )
            )
    return defs


@router.get("/schema", response_model=PartSchema)
def get_part_schema(db: DbSession) -> PartSchema:
    """Tier/category taxonomy and custom fields from project configuration."""
    project = get_active_project()
    used = {
        c
        for (c,) in db.query(Part.category)
        .filter(Part.deleted_at.is_(None), Part.category.isnot(None))
        .distinct()
        .all()
        if c
    }
    categories = used | set(project.categories if project else [])
    tiers = (
        [SchemaTier(**t.model_dump()) for t in project.tiers]
        if project
        else [
            SchemaTier(
                level=level,
                name=f"Tier {level}",
                code=str(level),
                default_tracking=tier_semantics(None, level).default_tracking,
                require_lot=tier_semantics(None, level).require_lot,
                auto_serial=tier_semantics(None, level).auto_serial,
            )
            for level in (1, 2, 3)
        ]
    )
    return PartSchema(
        tiers=tiers,
        categories=sorted(categories, key=str.lower),
        custom_fields=_custom_field_defs(project.custom_fields) if project else [],
        numbering_format=project.part_numbering.format if project else None,
    )


@router.get("/{part_id}/qrcode")
def get_part_qrcode(
    db: DbSession,
    part_id: int,
    request: Request,
) -> Response:
    """Generate a QR code SVG for a part."""
    import io as _io

    import segno

    part = db.query(Part).filter(Part.id == part_id, Part.deleted_at.is_(None)).first()
    if not part:
        raise HTTPException(status_code=404, detail=f"Part {part_id} not found")

    url = f"{request.base_url}parts/{part.id}"
    qr = segno.make(url)
    buf = _io.BytesIO()
    qr.save(buf, kind="svg", scale=4, border=1)
    return Response(content=buf.getvalue(), media_type="image/svg+xml")


@router.get("/{part_id}", response_model=PartResponse)
def get_part(
    db: DbSession,
    part_id: int,
) -> PartResponse:
    """Get a specific part."""
    part = db.query(Part).filter(Part.id == part_id, Part.deleted_at.is_(None)).first()
    if not part:
        raise HTTPException(
            status_code=status.HTTP_404_NOT_FOUND,
            detail=f"Part {part_id} not found",
        )

    return get_part_with_quantity(db, part)


@router.patch("/{part_id}", response_model=PartResponse)
def update_part(
    db: DbSession,
    part_id: int,
    part_in: PartUpdate,
    user_id: CurrentUserId,
) -> PartResponse:
    """Update a part."""
    part = db.query(Part).filter(Part.id == part_id, Part.deleted_at.is_(None)).first()
    if not part:
        raise HTTPException(
            status_code=status.HTTP_404_NOT_FOUND,
            detail=f"Part {part_id} not found",
        )

    # Validate parent_id if being updated
    if part_in.parent_id is not None:
        # Cannot be own parent
        if part_in.parent_id == part_id:
            raise HTTPException(
                status_code=status.HTTP_400_BAD_REQUEST,
                detail="A part cannot be its own parent",
            )
        # Parent must exist
        parent = (
            db.query(Part).filter(Part.id == part_in.parent_id, Part.deleted_at.is_(None)).first()
        )
        if not parent:
            raise HTTPException(
                status_code=status.HTTP_400_BAD_REQUEST,
                detail=f"Parent part {part_in.parent_id} not found",
            )
        # The parent chain must not lead back to this part
        ancestor: Part | None = parent
        seen: set[int] = set()
        while ancestor is not None and ancestor.id not in seen:
            if ancestor.id == part_id:
                raise HTTPException(
                    status_code=status.HTTP_400_BAD_REQUEST,
                    detail=f"{parent.internal_pn or parent.name} is inside "
                    f"{part.internal_pn or part.name}; it cannot be its parent",
                )
            seen.add(ancestor.id)
            ancestor = (
                db.query(Part).filter(Part.id == ancestor.parent_id).first()
                if ancestor.parent_id
                else None
            )

    old_values = get_model_dict(part)

    update_data = part_in.model_dump(exclude_unset=True)
    if "metadata" in update_data:
        update_data["metadata_"] = update_data.pop("metadata")

    # Identity (PN, tier) is mutable only while draft
    pn_change = "internal_pn" in update_data and update_data["internal_pn"] != part.internal_pn
    tier_change = "tier" in update_data and update_data["tier"] != part.tier
    if pn_change or tier_change:
        try:
            ensure_identity_mutable(part)
        except PartLifecycleError as e:
            raise HTTPException(status_code=status.HTTP_409_CONFLICT, detail=str(e)) from e
    if tier_change:
        require_configured_tier(update_data["tier"])

    # Tracking decides how stock is stored (one record per unit vs one lump);
    # flipping it under existing records would misdescribe them.
    if "tracking_type" in update_data and update_data["tracking_type"] != part.tracking_type:
        has_stock = (
            db.query(InventoryRecord.id).filter(InventoryRecord.part_id == part.id).first()
            is not None
        )
        if has_stock:
            raise HTTPException(
                status_code=status.HTTP_409_CONFLICT,
                detail=f"{part.internal_pn or part.name} has stock records; tracking cannot change",
            )

    if tier_change and not pn_change:
        # Tier re-sync: the draft gets a fresh number from the new tier's
        # counter; the old number is abandoned permanently (gaps are information)
        update_data["internal_pn"] = next_part_number(db, update_data["tier"])
    elif pn_change:
        new_tier = update_data.get("tier", part.tier)
        update_data["internal_pn"] = assign_internal_pn(db, new_tier, update_data["internal_pn"])

    for field, value in update_data.items():
        setattr(part, field, value)

    db.commit()
    db.refresh(part)

    log_update(db, part, old_values, user_id)
    db.commit()

    return get_part_with_quantity(db, part)


@router.delete("/{part_id}", status_code=status.HTTP_204_NO_CONTENT)
def delete_part(
    db: DbSession,
    part_id: int,
    user_id: CurrentUserId,
) -> None:
    """Soft delete a draft part. Its number is permanently retired, never reissued.

    Referenced things leave the world by state transition, stillborn things
    by soft delete — a part with any reference (even design-time) cannot be
    deleted, and active parts never can.
    """
    part = db.query(Part).filter(Part.id == part_id, Part.deleted_at.is_(None)).first()
    if not part:
        raise HTTPException(
            status_code=status.HTTP_404_NOT_FOUND,
            detail=f"Part {part_id} not found",
        )

    if part.lifecycle_state != PART_DRAFT:
        raise HTTPException(
            status_code=status.HTTP_409_CONFLICT,
            detail=f"{part.internal_pn or part.id} is active and cannot be deleted",
        )
    refs = reference_counts(db, part)
    if refs:
        ref_list = ", ".join(f"{count} {name}" for name, count in refs.items())
        raise HTTPException(
            status_code=status.HTTP_409_CONFLICT,
            detail=f"Draft part {part.internal_pn or part.id} is referenced ({ref_list}); "
            "remove the references first",
        )

    log_delete(db, part, user_id)
    part.soft_delete()
    db.commit()


# ============ CSV Import ============

# Column header normalization mapping
_HEADER_ALIASES: dict[str, str] = {
    "name": "name",
    "part_name": "name",
    "external_pn": "external_pn",
    "external pn": "external_pn",
    "external_part_number": "external_pn",
    "external part number": "external_pn",
    "part_number": "external_pn",
    "part number": "external_pn",
    "manufacturer_pn": "external_pn",
    "description": "description",
    "category": "category",
    "tier": "tier",
    "unit_of_measure": "unit_of_measure",
    "unit of measure": "unit_of_measure",
    "unit": "unit_of_measure",
    "uom": "unit_of_measure",
    "tracking_type": "tracking_type",
    "tracking type": "tracking_type",
    "tracking": "tracking_type",
    "procurement": "procurement",
    "reorder_point": "reorder_point",
    "reorder point": "reorder_point",
}

# Columns to silently ignore (from CSV export format)
_IGNORE_COLUMNS = {
    "id",
    "internal_pn",
    "internal pn",
    "internal_part_number",
    "total_quantity",
    "total quantity",
    "locations",
    "stock_qty",
    "stock qty",
    "created_at",
    "updated_at",
}


class ImportRowPreview(BaseModel):
    """Preview of a single CSV row."""

    row_number: int
    name: str | None = None
    external_pn: str | None = None
    tier: int | None = None
    category: str | None = None
    unit_of_measure: str | None = None
    tracking_type: str | None = None
    procurement: str | None = None
    description: str | None = None
    reorder_point: float | None = None
    errors: list[str] = []
    warnings: list[str] = []
    valid: bool = True


class ImportPreviewResponse(BaseModel):
    """Response from import preview."""

    total_rows: int
    valid_rows: int
    error_rows: int
    warning_rows: int
    rows: list[ImportRowPreview]
    headers_found: list[str]


class ImportResult(BaseModel):
    """Response from actual import."""

    created: int
    skipped: int
    errors: list[str]
    first_pn: str | None = None
    last_pn: str | None = None


def _normalize_header(header: str) -> str | None:
    """Normalize a CSV column header to a known field name."""
    h = header.strip().lower().replace(" ", "_")
    if h in _IGNORE_COLUMNS or header.strip().lower() in _IGNORE_COLUMNS:
        return None
    return _HEADER_ALIASES.get(h) or _HEADER_ALIASES.get(header.strip().lower())


@router.post("/import/preview", response_model=ImportPreviewResponse)
async def import_preview(
    db: DbSession,
    file: UploadFile,
) -> ImportPreviewResponse:
    """Parse and validate a CSV file for parts import without creating anything."""
    # Read CSV with BOM handling
    content = await file.read()
    text_stream = io.StringIO(content.decode("utf-8-sig"))
    reader = csv.DictReader(text_stream)

    if not reader.fieldnames:
        raise HTTPException(status_code=400, detail="CSV file has no headers")

    # Normalize headers
    header_map: dict[str, str | None] = {}
    for h in reader.fieldnames:
        header_map[h] = _normalize_header(h)

    headers_found = [v for v in header_map.values() if v]

    if "name" not in headers_found:
        raise HTTPException(status_code=400, detail="CSV must have a 'Name' column")

    # Collect existing parts for duplicate detection
    existing_names = {
        p.name.lower() for p in db.query(Part.name).filter(Part.deleted_at.is_(None)).all()
    }
    existing_external_pns = set()
    for row in (
        db.query(Part.external_pn)
        .filter(Part.deleted_at.is_(None), Part.external_pn.isnot(None))
        .all()
    ):
        existing_external_pns.add(row[0].lower())

    project = get_active_project()
    # Without a project config there is no configured set; keep the legacy range
    valid_tiers = {t.level for t in project.tiers} if project else {1, 2, 3, 4, 5}
    valid_tracking = {"bulk", "serialized"}

    rows: list[ImportRowPreview] = []
    for i, raw_row in enumerate(reader):
        if i >= 5000:
            break

        row_data: dict[str, str] = {}
        for csv_key, normalized_key in header_map.items():
            if normalized_key and csv_key in raw_row:
                row_data[normalized_key] = raw_row[csv_key].strip() if raw_row[csv_key] else ""

        preview = ImportRowPreview(row_number=i + 1)
        preview.name = row_data.get("name") or None
        preview.external_pn = row_data.get("external_pn") or None
        preview.category = row_data.get("category") or None
        preview.unit_of_measure = row_data.get("unit_of_measure") or None
        preview.tracking_type = (row_data.get("tracking_type") or "").lower() or None
        preview.procurement = (row_data.get("procurement") or "").lower() or None
        preview.description = row_data.get("description") or None

        # Parse tier (blank = the lowest configured tier)
        tier_str = row_data.get("tier", "").strip()
        if tier_str:
            try:
                preview.tier = int(tier_str)
            except ValueError:
                preview.errors.append(f"Invalid tier: '{tier_str}'")
        else:
            preview.tier = min(valid_tiers)

        # Parse reorder_point
        rp_str = row_data.get("reorder_point", "").strip()
        if rp_str:
            try:
                preview.reorder_point = float(rp_str)
            except ValueError:
                preview.errors.append(f"Invalid reorder_point: '{rp_str}'")
            else:
                if preview.reorder_point < 0:
                    preview.errors.append(f"Reorder point cannot be negative, got '{rp_str}'")

        # Validate required fields
        if not preview.name:
            preview.errors.append("Name is required")

        if preview.tier is not None and preview.tier not in valid_tiers:
            levels = ", ".join(str(level) for level in sorted(valid_tiers))
            preview.errors.append(f"Tier must be one of {levels}, got {preview.tier}")

        if preview.tracking_type and preview.tracking_type not in valid_tracking:
            preview.errors.append(
                f"Tracking type must be 'bulk' or 'serialized', got '{preview.tracking_type}'"
            )

        if preview.procurement and preview.procurement not in {"make", "buy", "both"}:
            preview.errors.append(
                f"Procurement must be 'make', 'buy', or 'both', got '{preview.procurement}'"
            )

        # Check duplicates
        if preview.name and preview.name.lower() in existing_names:
            preview.warnings.append(f"Part with name '{preview.name}' already exists")
        if preview.external_pn and preview.external_pn.lower() in existing_external_pns:
            preview.warnings.append(f"Part with external PN '{preview.external_pn}' already exists")

        preview.valid = len(preview.errors) == 0
        rows.append(preview)

    return ImportPreviewResponse(
        total_rows=len(rows),
        valid_rows=sum(1 for r in rows if r.valid),
        error_rows=sum(1 for r in rows if not r.valid),
        warning_rows=sum(1 for r in rows if r.warnings),
        rows=rows,
        headers_found=headers_found,
    )


class ImportRequest(BaseModel):
    """Request to perform the actual import."""

    rows: list[PartCreate]
    skip_duplicates: bool = True


@router.post("/import", response_model=ImportResult)
def import_parts(
    db: DbSession,
    import_in: ImportRequest,
    user_id: CurrentUserId,
) -> ImportResult:
    """Import parts from validated data. Call preview first to validate."""
    if len(import_in.rows) > 5000:
        raise HTTPException(status_code=400, detail="Maximum 5000 rows per import")

    existing_names = {
        p.name.lower() for p in db.query(Part.name).filter(Part.deleted_at.is_(None)).all()
    }

    existing_external = {
        row[0].lower()
        for row in db.query(Part.external_pn)
        .filter(Part.deleted_at.is_(None), Part.external_pn.isnot(None))
        .all()
    }

    created = 0
    skipped = 0
    errors: list[str] = []
    first_pn: str | None = None
    last_pn: str | None = None

    for i, part_in in enumerate(import_in.rows):
        # Skip duplicates if requested
        if import_in.skip_duplicates and (
            part_in.name.lower() in existing_names
            or (part_in.external_pn and part_in.external_pn.lower() in existing_external)
        ):
            skipped += 1
            continue

        # Each row is its own savepoint: a bad row never takes the batch down
        try:
            with db.begin_nested():
                require_configured_tier(part_in.tier)
                part = Part(
                    name=part_in.name,
                    internal_pn=next_part_number(db, part_in.tier),
                    external_pn=part_in.external_pn,
                    description=part_in.description,
                    category=part_in.category,
                    unit_of_measure=part_in.unit_of_measure,
                    tracking_type=part_in.tracking_type or default_tracking_for_tier(part_in.tier),
                    procurement=part_in.procurement or ("buy" if part_in.external_pn else "make"),
                    tier=part_in.tier,
                    reorder_point=part_in.reorder_point,
                    is_tooling=part_in.is_tooling,
                    calibration_interval_days=part_in.calibration_interval_days,
                    metadata_=part_in.metadata,
                )
                db.add(part)
                db.flush()
                log_create(db, part, user_id)
        except HTTPException as e:
            errors.append(f"Row {i + 1}: {e.detail}")
            continue
        except Exception as e:
            errors.append(f"Row {i + 1}: {e}")
            continue
        existing_names.add(part_in.name.lower())
        if part_in.external_pn:
            existing_external.add(part_in.external_pn.lower())
        created += 1
        first_pn = first_pn or part.internal_pn
        last_pn = part.internal_pn

    db.commit()

    return ImportResult(
        created=created, skipped=skipped, errors=errors, first_pn=first_pn, last_pn=last_pn
    )


# --- Supplier cross-reference view ---


class PartSupplierResponse(BaseModel):
    """Supplier catalog entry as seen from a part."""

    id: int
    supplier_id: int
    supplier_name: str
    part_id: int
    part_name: str
    vendor_pn: str
    is_preferred: bool
    notes: str | None
    created_at: str

    model_config = {"from_attributes": True}


@router.get("/{part_id}/suppliers", response_model=list[PartSupplierResponse])
async def list_part_suppliers(
    db: DbSession,
    part_id: int,
):
    """List all suppliers that carry this part (cross-reference view)."""
    part = db.execute(
        select(Part).where(Part.id == part_id, Part.deleted_at.is_(None))
    ).scalar_one_or_none()
    if not part:
        raise HTTPException(
            status_code=status.HTTP_404_NOT_FOUND,
            detail=f"Part {part_id} not found",
        )

    entries = (
        db.execute(
            select(SupplierPart)
            .join(Supplier, SupplierPart.supplier_id == Supplier.id)
            .where(SupplierPart.part_id == part_id, Supplier.deleted_at.is_(None))
            .order_by(SupplierPart.is_preferred.desc(), SupplierPart.id)
        )
        .scalars()
        .all()
    )
    return [
        PartSupplierResponse(
            id=sp.id,
            supplier_id=sp.supplier_id,
            supplier_name=sp.supplier.name,
            part_id=sp.part_id,
            part_name=sp.part.name,
            vendor_pn=sp.vendor_pn,
            is_preferred=sp.is_preferred,
            notes=sp.notes,
            created_at=sp.created_at.strftime("%Y-%m-%dT%H:%M:%S") + "Z",
        )
        for sp in entries
    ]


# ============ Part page ============


class PartExpects(BaseModel):
    """Which sections expect content, declared by the part's procurement.

    The empty-state rule has one home: an empty section that is not expected
    is absent; one that is expected renders as a single line. Sections with
    rows render regardless, so the client never has to hide data.
    """

    bom: bool
    suppliers: bool
    po_lines: bool


def section_expectations(procurement: str) -> PartExpects:
    """BOM expects content on make|both; suppliers and PO lines on buy|both."""
    return PartExpects(
        bom=procurement in ("make", "both"),
        suppliers=procurement in ("buy", "both"),
        po_lines=procurement in ("buy", "both"),
    )


class PartRef(BaseModel):
    """A part named by its number, for links."""

    id: int
    internal_pn: str | None
    name: str


class PoLineRow(BaseModel):
    """A purchase line for this part."""

    line_id: int
    purchase_id: int
    reference: str | None
    supplier: str
    status: str
    qty_ordered: Decimal
    qty_received: Decimal
    unit_cost: Decimal | None
    target_date: str | None


class ProcedureUseRow(BaseModel):
    """A procedure that kits, consumes, uses as tooling, or produces this part."""

    procedure_id: int
    procedure_name: str
    procedure_status: str
    role: Literal["kit", "consume", "tooling", "produces"]
    step_number: str | None = None
    quantity: Decimal


class ConsumptionRow(BaseModel):
    """One consumption of this part's stock."""

    id: int
    consumed_at: str
    quantity: Decimal
    opal_number: str | None
    execution_id: int | None
    work_order_number: str | None
    notes: str | None


class RequirementRow(BaseModel):
    """A requirement allocated to this part."""

    allocation_id: int
    requirement_id: str
    requirement_ref_id: int | None
    title: str | None
    lifecycle_state: str | None
    tbd: bool = False
    tbr: bool = False
    stale: bool = False
    status: str


class OnshapeRef(BaseModel):
    """Onshape link status for this part."""

    document_id: str
    name: str | None
    part_number: str | None
    last_synced_at: str | None
    stale: bool


class PartDetailResponse(BaseModel):
    """Everything the part page shows, in one read."""

    part: PartResponse
    parent: PartRef | None
    tier_code: str | None
    activated_by: str | None
    expects: PartExpects
    references: dict[str, int]
    deletable: bool
    stock: list[InventoryResponse]
    bom: list[BOMLineResponse]
    where_used: list[BOMLineResponse]
    suppliers: list[PartSupplierResponse]
    po_lines: list[PoLineRow]
    procedure_use: list[ProcedureUseRow]
    consumption: list[ConsumptionRow]
    consumption_truncated: bool
    requirements: list[RequirementRow]
    tests: list[TestTemplateResponse]
    onshape: OnshapeRef | None


_CONSUMPTION_LIMIT = 50
_PO_LINE_LIMIT = 50


def _active_part(db: DbSession, part_id: int) -> Part:
    part = db.query(Part).filter(Part.id == part_id, Part.deleted_at.is_(None)).first()
    if not part:
        raise HTTPException(
            status_code=status.HTTP_404_NOT_FOUND,
            detail=f"Part {part_id} not found",
        )
    return part


def _enum_value(value: Any) -> str:
    return value.value if hasattr(value, "value") else str(value)


@router.get("/{part_id}/detail", response_model=PartDetailResponse)
def get_part_detail(db: DbSession, part_id: int) -> PartDetailResponse:
    """The part page's read model: the part plus every collection it shows."""
    part = _active_part(db, part_id)
    project = get_active_project()
    tier = project.get_tier(part.tier) if project else None
    parent = (
        db.query(Part).filter(Part.id == part.parent_id, Part.deleted_at.is_(None)).first()
        if part.parent_id
        else None
    )
    activated_by = db.get(User, part.activated_by_id) if part.activated_by_id else None

    stock = (
        db.query(InventoryRecord)
        .filter(InventoryRecord.part_id == part.id)
        .order_by(InventoryRecord.location, InventoryRecord.opal_number)
        .all()
    )
    bom = (
        db.query(BOMLine)
        .join(Part, BOMLine.component_id == Part.id)
        .filter(BOMLine.assembly_id == part.id, Part.deleted_at.is_(None))
        .order_by(BOMLine.id)
        .all()
    )
    where_used = (
        db.query(BOMLine)
        .join(Part, BOMLine.assembly_id == Part.id)
        .filter(BOMLine.component_id == part.id, Part.deleted_at.is_(None))
        .order_by(BOMLine.id)
        .all()
    )
    suppliers = (
        db.query(SupplierPart)
        .join(Supplier, SupplierPart.supplier_id == Supplier.id)
        .filter(SupplierPart.part_id == part.id, Supplier.deleted_at.is_(None))
        .order_by(SupplierPart.is_preferred.desc(), SupplierPart.id)
        .all()
    )

    po_rows = (
        db.query(PurchaseLine, Purchase)
        .join(Purchase, PurchaseLine.purchase_id == Purchase.id)
        .filter(PurchaseLine.part_id == part.id)
        .order_by(Purchase.id.desc(), PurchaseLine.id)
        .limit(_PO_LINE_LIMIT)
        .all()
    )
    po_lines = [
        PoLineRow(
            line_id=line.id,
            purchase_id=purchase.id,
            reference=purchase.reference,
            supplier=purchase.supplier,
            status=_enum_value(purchase.status),
            qty_ordered=line.qty_ordered,
            qty_received=line.qty_received,
            unit_cost=line.unit_cost,
            target_date=purchase.target_date.isoformat() if purchase.target_date else None,
        )
        for line, purchase in po_rows
    ]

    procedure_use: list[ProcedureUseRow] = []
    for kit, proc in (
        db.query(Kit, MasterProcedure)
        .join(MasterProcedure, Kit.procedure_id == MasterProcedure.id)
        .filter(Kit.part_id == part.id, MasterProcedure.deleted_at.is_(None))
        .order_by(MasterProcedure.name)
        .all()
    ):
        procedure_use.append(
            ProcedureUseRow(
                procedure_id=proc.id,
                procedure_name=proc.name,
                procedure_status=_enum_value(proc.status),
                role="kit",
                quantity=kit.quantity_required,
            )
        )
    for step_kit in db.query(StepKit).filter(StepKit.part_id == part.id).all():
        proc = step_kit.step.procedure
        if proc.deleted_at is not None:
            continue
        procedure_use.append(
            ProcedureUseRow(
                procedure_id=proc.id,
                procedure_name=proc.name,
                procedure_status=_enum_value(proc.status),
                role="tooling" if _enum_value(step_kit.usage_type) == "tooling" else "consume",
                step_number=step_kit.step.step_number,
                quantity=step_kit.quantity_required,
            )
        )
    for output, proc in (
        db.query(ProcedureOutput, MasterProcedure)
        .join(MasterProcedure, ProcedureOutput.procedure_id == MasterProcedure.id)
        .filter(ProcedureOutput.part_id == part.id, MasterProcedure.deleted_at.is_(None))
        .all()
    ):
        procedure_use.append(
            ProcedureUseRow(
                procedure_id=proc.id,
                procedure_name=proc.name,
                procedure_status=_enum_value(proc.status),
                role="produces",
                quantity=output.quantity_produced,
            )
        )

    consumed = (
        db.query(InventoryConsumption)
        .join(InventoryRecord, InventoryConsumption.inventory_record_id == InventoryRecord.id)
        .filter(InventoryRecord.part_id == part.id)
        .order_by(InventoryConsumption.created_at.desc(), InventoryConsumption.id.desc())
        .limit(_CONSUMPTION_LIMIT + 1)
        .all()
    )
    consumption = [
        ConsumptionRow(
            id=c.id,
            consumed_at=c.created_at.isoformat(),
            quantity=c.quantity,
            opal_number=c.inventory_record.opal_number,
            execution_id=c.procedure_instance_id,
            work_order_number=(
                c.procedure_instance.work_order_number if c.procedure_instance else None
            ),
            notes=c.notes,
        )
        for c in consumed[:_CONSUMPTION_LIMIT]
    ]

    requirement_rows: list[RequirementRow] = []
    for allocation in (
        db.query(PartRequirement)
        .filter(PartRequirement.part_id == part.id)
        .order_by(PartRequirement.id)
        .all()
    ):
        resolved = get_requirement_response(db, allocation)
        req = (
            db.get(Requirement, allocation.requirement_ref_id)
            if allocation.requirement_ref_id
            else None
        )
        requirement_rows.append(
            RequirementRow(
                allocation_id=allocation.id,
                requirement_id=allocation.requirement_id,
                requirement_ref_id=allocation.requirement_ref_id,
                title=resolved.requirement_title,
                lifecycle_state=req.lifecycle_state if req else None,
                tbd=bool(req and req.tbd),
                tbr=bool(req and req.tbr),
                stale=bool(req and req.stale),
                status=allocation.status,
            )
        )

    tests = (
        db.query(TestTemplate)
        .filter(TestTemplate.part_id == part.id)
        .order_by(TestTemplate.sort_order, TestTemplate.id)
        .all()
    )
    link = db.query(OnshapeLink).filter(OnshapeLink.part_id == part.id).first()

    refs = reference_counts(db, part)
    return PartDetailResponse(
        part=get_part_with_quantity(db, part),
        parent=PartRef(id=parent.id, internal_pn=parent.internal_pn, name=parent.name)
        if parent
        else None,
        tier_code=tier.code if tier else None,
        activated_by=activated_by.name if activated_by else None,
        expects=section_expectations(_enum_value(part.procurement)),
        references=refs,
        deletable=part.lifecycle_state == PART_DRAFT and not refs,
        stock=[inventory_to_response(r) for r in stock],
        bom=[get_bom_line_response(line) for line in bom],
        where_used=[get_bom_line_response(line) for line in where_used],
        suppliers=[
            PartSupplierResponse(
                id=sp.id,
                supplier_id=sp.supplier_id,
                supplier_name=sp.supplier.name,
                part_id=sp.part_id,
                part_name=part.name,
                vendor_pn=sp.vendor_pn,
                is_preferred=sp.is_preferred,
                notes=sp.notes,
                created_at=sp.created_at.strftime("%Y-%m-%dT%H:%M:%S") + "Z",
            )
            for sp in suppliers
        ],
        po_lines=po_lines,
        procedure_use=procedure_use,
        consumption=consumption,
        consumption_truncated=len(consumed) > _CONSUMPTION_LIMIT,
        requirements=requirement_rows,
        tests=[
            TestTemplateResponse(
                id=t.id,
                part_id=t.part_id,
                name=t.name,
                description=t.description,
                required=t.required,
                test_type=t.test_type,
                min_value=t.min_value,
                max_value=t.max_value,
                unit=t.unit,
                sort_order=t.sort_order,
                created_at=t.created_at.isoformat(),
            )
            for t in tests
        ],
        onshape=OnshapeRef(
            document_id=link.document_id,
            name=link.onshape_name,
            part_number=link.onshape_part_number,
            last_synced_at=link.last_synced_at.isoformat() if link.last_synced_at else None,
            stale=link.stale,
        )
        if link
        else None,
    )


class HistoryChange(BaseModel):
    """One field's before/after in an audit entry."""

    field: str
    old: Any = None
    new: Any = None


class HistoryEntry(BaseModel):
    """One audit entry on the part."""

    timestamp: str
    action: str
    user_name: str | None
    changes: list[HistoryChange]


class PartHistory(BaseModel):
    """Newest-first audit excerpt for a part."""

    items: list[HistoryEntry]
    total: int


# Bookkeeping columns that change on every write and say nothing
_HISTORY_SKIP = {"updated_at", "created_at", "id"}


@router.get("/{part_id}/history", response_model=PartHistory)
def get_part_history(
    db: DbSession,
    part_id: int,
    limit: int = Query(15, ge=1, le=200),
) -> PartHistory:
    """The part's audit trail, newest first."""
    _active_part(db, part_id)
    query = db.query(AuditLog).filter(AuditLog.table_name == "part", AuditLog.record_id == part_id)
    total = query.count()
    entries = query.order_by(AuditLog.timestamp.desc(), AuditLog.id.desc()).limit(limit).all()

    user_ids = {e.user_id for e in entries if e.user_id}
    names = (
        {u.id: u.name for u in db.query(User).filter(User.id.in_(user_ids)).all()}
        if user_ids
        else {}
    )
    items: list[HistoryEntry] = []
    for e in entries:
        action = _enum_value(e.action)
        changes: list[HistoryChange] = []
        if action == "update" and e.new_values:
            old = e.old_values or {}
            changes = [
                HistoryChange(field=k, old=old.get(k), new=v)
                for k, v in e.new_values.items()
                if k not in _HISTORY_SKIP
            ]
        items.append(
            HistoryEntry(
                timestamp=e.timestamp.isoformat(),
                action=action,
                user_name=names.get(e.user_id) if e.user_id else None,
                changes=changes,
            )
        )
    return PartHistory(items=items, total=total)
