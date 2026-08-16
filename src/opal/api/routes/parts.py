"""Parts management endpoints."""

import csv
import io
import re
from decimal import Decimal
from typing import Any, Literal

from fastapi import APIRouter, HTTPException, Query, Request, UploadFile, status
from fastapi.responses import Response
from pydantic import BaseModel, field_validator
from sqlalchemy import func, or_, select

from opal.api.deps import CurrentUserId, DbSession, PaginationParams
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
from opal.db.models import InventoryRecord, Part, Supplier, SupplierPart
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
    reorder_point: Decimal | None = None
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
    reorder_point: Decimal | None = None
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


def get_part_with_quantity(db: DbSession, part: Part) -> PartResponse:
    """Convert part to response with total quantity calculated."""
    from opal.config import get_active_project

    total_qty = (
        db.query(func.coalesce(func.sum(InventoryRecord.quantity), 0))
        .filter(InventoryRecord.part_id == part.id)
        .scalar()
    )

    # Try to get tier name from project config
    tier_name = None
    project = get_active_project()
    if project:
        tier = project.get_tier(part.tier)
        if tier:
            tier_name = tier.name

    total = total_qty or Decimal(0)
    is_low = bool(part.reorder_point is not None and total < part.reorder_point)

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
        tier_name=tier_name,
        parent_id=part.parent_id,
        reorder_point=part.reorder_point,
        is_low_stock=is_low,
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


@router.get("", response_model=PartListResponse)
def list_parts(
    db: DbSession,
    pagination: PaginationParams,
    search: str | None = Query(None, description="Search in name, external_pn, description"),
    category: str | None = Query(None, description="Filter by category"),
    tier: int | None = Query(
        None, description="Filter by tier level (as configured in the project)"
    ),
    parent_id: int | None = Query(None, description="Filter by parent assembly ID"),
    top_level: bool = Query(
        False, description="Only show parts with no parent (top-level assemblies)"
    ),
    low_stock: bool = Query(False, description="Only show parts below reorder point"),
    state: str | None = Query(None, description="Filter by lifecycle state (draft/active)"),
) -> PartListResponse:
    """List all parts with optional filtering."""
    query = db.query(Part).filter(Part.deleted_at.is_(None))

    if state:
        if state not in PART_LIFECYCLE_STATES:
            raise HTTPException(
                status_code=status.HTTP_400_BAD_REQUEST,
                detail=f"Unknown lifecycle state '{state}' (expected draft or active)",
            )
        query = query.filter(Part.lifecycle_state == state)

    # Apply search filter
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

    # Apply category filter
    if category:
        query = query.filter(Part.category == category)

    # Apply tier filter
    if tier is not None:
        query = query.filter(Part.tier == tier)

    # Apply parent filter
    if parent_id is not None:
        query = query.filter(Part.parent_id == parent_id)
    elif top_level:
        query = query.filter(Part.parent_id.is_(None))

    if low_stock:
        # Filter to parts with reorder_point set, where stock < reorder_point
        query = query.filter(Part.reorder_point.isnot(None))
        # We need to compute stock in a subquery
        stock_subq = (
            db.query(
                InventoryRecord.part_id,
                func.coalesce(func.sum(InventoryRecord.quantity), 0).label("total_qty"),
            )
            .group_by(InventoryRecord.part_id)
            .subquery()
        )
        query = query.outerjoin(stock_subq, Part.id == stock_subq.c.part_id).filter(
            func.coalesce(stock_subq.c.total_qty, 0) < Part.reorder_point
        )

    total = query.count()
    parts = query.order_by(Part.id.desc()).offset(pagination.skip).limit(pagination.limit).all()

    return PartListResponse(
        items=[get_part_with_quantity(db, p) for p in parts],
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


@router.get("/{part_id}/datamatrix")
def get_part_datamatrix(
    db: DbSession,
    part_id: int,
) -> Response:
    """Generate a Data Matrix SVG of the part number.

    A short identifier needs far fewer modules per side as Data Matrix
    than as a QR code (~16x16 vs. QR's 21x21+), which matters on a
    narrow continuous-tape label printer (e.g. the DYMO LabelManager
    280's 12mm/180dpi print strip): more px/module survives the print
    resolution instead of blurring into an unscannable square.
    """
    from pystrich.datamatrix import DataMatrixEncoder

    part = db.query(Part).filter(Part.id == part_id, Part.deleted_at.is_(None)).first()
    if not part:
        raise HTTPException(status_code=404, detail=f"Part {part_id} not found")

    encoder = DataMatrixEncoder(part.internal_pn)
    return Response(content=encoder.get_svg(), media_type="image/svg+xml")


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
        preview.tracking_type = row_data.get("tracking_type") or None
        preview.procurement = (row_data.get("procurement") or "").lower() or None
        preview.description = row_data.get("description") or None

        # Parse tier
        tier_str = row_data.get("tier", "").strip()
        if tier_str:
            try:
                preview.tier = int(tier_str)
            except ValueError:
                preview.errors.append(f"Invalid tier: '{tier_str}'")

        # Parse reorder_point
        rp_str = row_data.get("reorder_point", "").strip()
        if rp_str:
            try:
                preview.reorder_point = float(rp_str)
            except ValueError:
                preview.errors.append(f"Invalid reorder_point: '{rp_str}'")

        # Validate required fields
        if not preview.name:
            preview.errors.append("Name is required")

        if preview.tier is not None and preview.tier not in valid_tiers:
            levels = ", ".join(str(level) for level in sorted(valid_tiers))
            preview.errors.append(f"Tier must be one of {levels}, got {preview.tier}")

        if preview.tracking_type and preview.tracking_type.lower() not in valid_tracking:
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

    created = 0
    skipped = 0
    errors: list[str] = []

    for i, part_in in enumerate(import_in.rows):
        # Skip duplicates if requested
        if import_in.skip_duplicates and part_in.name.lower() in existing_names:
            skipped += 1
            continue

        try:
            internal_pn = next_part_number(db, part_in.tier)
            part = Part(
                name=part_in.name,
                internal_pn=internal_pn,
                external_pn=part_in.external_pn,
                description=part_in.description,
                category=part_in.category,
                unit_of_measure=part_in.unit_of_measure or "EA",
                tracking_type=part_in.tracking_type or "bulk",
                procurement=part_in.procurement or ("buy" if part_in.external_pn else "make"),
                tier=part_in.tier,
                reorder_point=part_in.reorder_point,
                is_tooling=part_in.is_tooling,
                metadata_=part_in.metadata,
            )
            db.add(part)
            db.flush()
            log_create(db, part, user_id)
            existing_names.add(part_in.name.lower())
            created += 1
        except Exception as e:
            errors.append(f"Row {i + 1}: {str(e)}")

    db.commit()

    return ImportResult(created=created, skipped=skipped, errors=errors)


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
