"""Inventory management endpoints."""

from datetime import UTC, date, datetime, timedelta
from decimal import Decimal
from enum import Enum

from fastapi import APIRouter, HTTPException, Query, Request, status
from fastapi.responses import Response
from pydantic import BaseModel
from sqlalchemy import func, or_
from sqlalchemy.orm import joinedload

from opal.api.deps import CurrentUserId, DbSession, PaginationParams
from opal.core.audit import get_model_dict, log_create, log_delete, log_update
from opal.core.designators import generate_serial_number
from opal.core.genealogy import get_full_genealogy
from opal.core.inventory import build_ledger, generate_opal_number, receipt_rules
from opal.core.part_lifecycle import ensure_parts_active
from opal.db.models import InventoryRecord, Part, StockTestResult, StockTransfer, TestTemplate, User
from opal.db.models.audit import AuditAction, AuditLog
from opal.db.models.inventory import (
    ConsumptionType,
    InventoryConsumption,
    InventoryProduction,
    SourceType,
    TestResult,
    TransferStatus,
    UsageType,
)
from opal.db.models.part import TrackingType

router = APIRouter()


class InventoryCreate(BaseModel):
    """Schema for creating an inventory record."""

    part_id: int
    quantity: Decimal
    location: str
    lot_number: str | None = None
    expiration_date: date | None = None
    # The part tier's receiving rules (lot required for lot-tracked bulk
    # parts, generated serials for serial-issuing tiers) apply exactly as in
    # purchase receiving. On by default so no client can create untraceable
    # stock by omission; send false to bypass deliberately (e.g. data migration).
    enforce_tier_rules: bool = True


class InventoryUpdate(BaseModel):
    """Schema for updating an inventory record.

    Deliberately has no ``quantity`` field: on-hand stock is traceable and may
    only change through ``/adjust`` or ``/count``, which write a ledger delta
    and enforce the negative/serialized guards. A blind ``PATCH`` of quantity
    would rewrite stock with no history.
    """

    location: str | None = None
    lot_number: str | None = None
    expiration_date: date | None = None


class AdjustmentReason(str, Enum):
    """Reason for an inventory adjustment."""

    CYCLE_COUNT = "cycle_count"
    DAMAGE = "damage"
    SCRAP = "scrap"
    FOUND = "found"
    CORRECTION = "correction"


class InventoryAdjust(BaseModel):
    """Schema for adjusting inventory quantity."""

    adjustment: Decimal  # Positive to add, negative to subtract
    reason: AdjustmentReason
    notes: str | None = None


class InventoryCount(BaseModel):
    """Schema for recording a physical count."""

    counted_quantity: Decimal


class InventoryResponse(BaseModel):
    """Schema for inventory response."""

    id: int
    part_id: int
    part_name: str
    part_external_pn: str | None
    part_uom: str | None = None
    part_internal_pn: str | None = None
    part_tracking_type: str | None = None
    part_is_tooling: bool = False
    quantity: Decimal
    location: str
    lot_number: str | None
    last_counted_at: str | None
    opal_number: str | None
    source_type: str | None
    source_purchase_line_id: int | None
    source_production_id: int | None
    expiration_date: str | None
    is_expired: bool = False
    days_until_expiration: int | None = None
    last_calibrated_at: str | None = None
    calibration_due_at: str | None = None
    calibration_status: str | None = None  # "ok", "due_soon", "overdue"
    created_at: str
    updated_at: str

    model_config = {"from_attributes": True}


class InventoryListResponse(BaseModel):
    """Schema for inventory list response."""

    items: list[InventoryResponse]
    total: int


class LocationSummary(BaseModel):
    """Summary of inventory at a location."""

    location: str
    total_records: int
    total_parts: int


def inventory_to_response(record: InventoryRecord) -> InventoryResponse:
    """Convert inventory record to response."""
    source_type = None
    if record.source_type:
        source_type = (
            record.source_type.value if hasattr(record.source_type, "value") else record.source_type
        )

    # Compute expiration fields
    is_expired = False
    days_until = None
    if record.expiration_date:
        today = date.today()
        delta = (record.expiration_date - today).days
        days_until = delta
        is_expired = delta < 0

    # Compute calibration status
    calibration_status = None
    if record.part.is_tooling and record.calibration_due_at:
        now = datetime.now(UTC)
        cal_due = record.calibration_due_at
        if cal_due.tzinfo is None:
            cal_due = cal_due.replace(tzinfo=UTC)
        if cal_due <= now:
            calibration_status = "overdue"
        elif (cal_due - now).days <= 30:
            calibration_status = "due_soon"
        else:
            calibration_status = "ok"

    return InventoryResponse(
        id=record.id,
        part_id=record.part_id,
        part_name=record.part.name,
        part_external_pn=record.part.external_pn,
        part_uom=record.part.unit_of_measure,
        part_internal_pn=record.part.internal_pn,
        part_tracking_type=record.part.tracking_type,
        part_is_tooling=bool(record.part.is_tooling),
        quantity=record.quantity,
        location=record.location,
        lot_number=record.lot_number,
        last_counted_at=record.last_counted_at.isoformat() if record.last_counted_at else None,
        opal_number=record.opal_number,
        source_type=source_type,
        source_purchase_line_id=record.source_purchase_line_id,
        source_production_id=record.source_production_id,
        expiration_date=record.expiration_date.isoformat() if record.expiration_date else None,
        is_expired=is_expired,
        days_until_expiration=days_until,
        last_calibrated_at=record.last_calibrated_at.isoformat()
        if record.last_calibrated_at
        else None,
        calibration_due_at=record.calibration_due_at.isoformat()
        if record.calibration_due_at
        else None,
        calibration_status=calibration_status,
        created_at=record.created_at.isoformat(),
        updated_at=record.updated_at.isoformat(),
    )


def _low_stock_part_ids(db: DbSession):
    """Subquery: ids of parts whose total on-hand is below their reorder point."""
    totals = (
        db.query(
            InventoryRecord.part_id.label("part_id"),
            func.coalesce(func.sum(InventoryRecord.quantity), 0).label("total"),
        )
        .group_by(InventoryRecord.part_id)
        .subquery()
    )
    return (
        db.query(Part.id)
        .outerjoin(totals, Part.id == totals.c.part_id)
        .filter(
            Part.deleted_at.is_(None),
            Part.reorder_point.isnot(None),
            func.coalesce(totals.c.total, 0) < Part.reorder_point,
        )
    )


def _filtered_records(
    db: DbSession,
    *,
    part_id: int | None,
    location: str | None,
    lot_number: str | None,
    search: str | None,
    source_type: str | None,
    has_stock: bool | None,
    low_stock: bool,
    expired: bool,
    expiring_soon: bool,
    calibration_overdue: bool,
):
    query = db.query(InventoryRecord).join(Part).filter(Part.deleted_at.is_(None))

    if part_id:
        query = query.filter(InventoryRecord.part_id == part_id)
    if location:
        query = query.filter(InventoryRecord.location == location)
    if lot_number:
        query = query.filter(InventoryRecord.lot_number == lot_number)
    if search:
        term = f"%{search.strip()}%"
        query = query.filter(
            or_(
                InventoryRecord.opal_number.ilike(term),
                InventoryRecord.lot_number.ilike(term),
                InventoryRecord.location.ilike(term),
                Part.name.ilike(term),
                Part.internal_pn.ilike(term),
                Part.external_pn.ilike(term),
            )
        )
    if source_type:
        query = query.filter(InventoryRecord.source_type == source_type)
    if has_stock is True:
        query = query.filter(InventoryRecord.quantity > 0)
    elif has_stock is False:
        query = query.filter(InventoryRecord.quantity <= 0)
    if low_stock:
        query = query.filter(InventoryRecord.part_id.in_(_low_stock_part_ids(db).scalar_subquery()))
    if expired:
        query = query.filter(
            InventoryRecord.expiration_date.isnot(None),
            InventoryRecord.expiration_date < date.today(),
        )
    elif expiring_soon:
        today = date.today()
        threshold = today + timedelta(days=30)
        query = query.filter(
            InventoryRecord.expiration_date.isnot(None),
            InventoryRecord.expiration_date <= threshold,
        )
    if calibration_overdue:
        now = datetime.now(UTC)
        query = query.filter(
            Part.is_tooling == True,  # noqa: E712
            InventoryRecord.calibration_due_at.isnot(None),
            InventoryRecord.calibration_due_at <= now,
        )
    return query


_SORT_COLUMNS = {
    "opal_number": InventoryRecord.opal_number,
    "part": Part.internal_pn,
    "name": Part.name,
    "location": InventoryRecord.location,
    "quantity": InventoryRecord.quantity,
    "lot_number": InventoryRecord.lot_number,
    "expiration_date": InventoryRecord.expiration_date,
    "created_at": InventoryRecord.created_at,
}


@router.get("", response_model=InventoryListResponse)
def list_inventory(
    db: DbSession,
    pagination: PaginationParams,
    part_id: int | None = Query(None, description="Filter by part ID"),
    location: str | None = Query(None, description="Filter by location"),
    lot_number: str | None = Query(None, description="Filter by lot number"),
    search: str | None = Query(
        None, description="Match OPAL number, lot, location, part name or part number"
    ),
    source_type: str | None = Query(None, description="purchase, production, manual, transfer"),
    has_stock: bool | None = Query(
        None, description="true: on hand above zero; false: depleted records only"
    ),
    low_stock: bool = Query(False, description="Only records of parts below their reorder point"),
    expired: bool = Query(False, description="Filter to only expired items"),
    expiring_soon: bool = Query(False, description="Filter to items expiring within 30 days"),
    calibration_overdue: bool = Query(
        False, description="Filter to tooling items with overdue calibration"
    ),
    sort: str | None = Query(None, description=f"One of: {', '.join(_SORT_COLUMNS)}"),
    order: str = Query("asc", pattern="^(asc|desc)$"),
) -> InventoryListResponse:
    """List inventory records with optional filtering."""
    if sort is not None and sort not in _SORT_COLUMNS:
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail=f"Unknown sort '{sort}' (expected one of {', '.join(_SORT_COLUMNS)})",
        )
    query = _filtered_records(
        db,
        part_id=part_id,
        location=location,
        lot_number=lot_number,
        search=search,
        source_type=source_type,
        has_stock=has_stock,
        low_stock=low_stock,
        expired=expired,
        expiring_soon=expiring_soon,
        calibration_overdue=calibration_overdue,
    )

    total = query.count()
    if sort:
        column = _SORT_COLUMNS[sort]
        ordering = [column.desc() if order == "desc" else column.asc(), InventoryRecord.id.desc()]
    else:
        ordering = [InventoryRecord.location, InventoryRecord.part_id]
    records = (
        query.options(joinedload(InventoryRecord.part))
        .order_by(*ordering)
        .offset(pagination.skip)
        .limit(pagination.limit)
        .all()
    )

    return InventoryListResponse(
        items=[inventory_to_response(r) for r in records],
        total=total,
    )


class StockByPart(BaseModel):
    """On-hand stock of one part, summed over the matching records."""

    part_id: int
    internal_pn: str | None
    external_pn: str | None
    name: str
    unit_of_measure: str | None
    tracking_type: str
    reorder_point: Decimal | None
    quantity: Decimal
    record_count: int
    locations: list[str]
    is_low_stock: bool


class StockByPartResponse(BaseModel):
    items: list[StockByPart]
    total: int


@router.get("/by-part", response_model=StockByPartResponse)
def stock_by_part(
    db: DbSession,
    pagination: PaginationParams,
    location: str | None = Query(None),
    search: str | None = Query(None),
    low_stock: bool = Query(False),
    sort: str = Query("part", pattern="^(part|name|quantity|record_count)$"),
    order: str = Query("asc", pattern="^(asc|desc)$"),
) -> StockByPartResponse:
    """On-hand stock grouped by part. The part's total is always the sum over
    all its records; ``location`` and ``search`` narrow which parts appear
    and which records are summed, so a location filter answers "how much of
    each part is in this location"."""
    records = _filtered_records(
        db,
        part_id=None,
        location=location,
        lot_number=None,
        search=search,
        source_type=None,
        has_stock=None,
        low_stock=low_stock,
        expired=False,
        expiring_soon=False,
        calibration_overdue=False,
    ).subquery()

    qty = func.coalesce(func.sum(records.c.quantity), 0)
    count = func.count(records.c.id)
    sort_column = {
        "part": Part.internal_pn,
        "name": Part.name,
        "quantity": qty,
        "record_count": count,
    }[sort]
    grouped = (
        db.query(Part, qty.label("qty"), count.label("n"))
        .join(records, records.c.part_id == Part.id)
        .group_by(Part.id)
    )
    total = grouped.count()
    rows = (
        grouped.order_by(sort_column.desc() if order == "desc" else sort_column.asc(), Part.id)
        .offset(pagination.skip)
        .limit(pagination.limit)
        .all()
    )

    part_ids = [part.id for part, _, _ in rows]
    location_rows = (
        db.query(InventoryRecord.part_id, InventoryRecord.location)
        .filter(InventoryRecord.part_id.in_(part_ids), InventoryRecord.quantity > 0)
        .distinct()
        .order_by(InventoryRecord.location)
        .all()
        if part_ids
        else []
    )
    locations: dict[int, list[str]] = {}
    for pid, loc in location_rows:
        if loc:
            locations.setdefault(pid, []).append(loc)

    # Low-stock is judged on the part's whole on-hand, not the filtered sum.
    all_totals = dict(
        db.query(InventoryRecord.part_id, func.coalesce(func.sum(InventoryRecord.quantity), 0))
        .filter(InventoryRecord.part_id.in_(part_ids))
        .group_by(InventoryRecord.part_id)
        .all()
        if part_ids
        else []
    )

    items = [
        StockByPart(
            part_id=part.id,
            internal_pn=part.internal_pn,
            external_pn=part.external_pn,
            name=part.name,
            unit_of_measure=part.unit_of_measure,
            tracking_type=part.tracking_type,
            reorder_point=part.reorder_point,
            quantity=quantity,
            record_count=n,
            locations=locations.get(part.id, []),
            is_low_stock=bool(
                part.reorder_point is not None
                and Decimal(all_totals.get(part.id, 0)) < part.reorder_point
            ),
        )
        for part, quantity, n in rows
    ]
    return StockByPartResponse(items=items, total=total)


@router.get("/{inventory_id}/qrcode")
def get_inventory_qrcode(
    db: DbSession,
    inventory_id: int,
    request: Request,
) -> Response:
    """Generate a QR code SVG for an inventory record."""
    import io

    import segno

    record = (
        db.query(InventoryRecord)
        .join(Part)
        .filter(InventoryRecord.id == inventory_id, Part.deleted_at.is_(None))
        .first()
    )
    if not record:
        raise HTTPException(status_code=404, detail=f"Inventory record {inventory_id} not found")

    url = f"{request.base_url}inventory/opal/{record.opal_number}"
    qr = segno.make(url)
    buf = io.BytesIO()
    qr.save(buf, kind="svg", scale=4, border=1)
    return Response(content=buf.getvalue(), media_type="image/svg+xml")


@router.get("/locations")
def list_locations(db: DbSession) -> list[LocationSummary]:
    """List all inventory locations with summary."""
    results = (
        db.query(
            InventoryRecord.location,
            func.count(InventoryRecord.id).label("total_records"),
            func.count(func.distinct(InventoryRecord.part_id)).label("total_parts"),
        )
        .join(Part)
        .filter(Part.deleted_at.is_(None))
        .group_by(InventoryRecord.location)
        .order_by(InventoryRecord.location)
        .all()
    )

    return [
        LocationSummary(
            location=r.location,
            total_records=r.total_records,
            total_parts=r.total_parts,
        )
        for r in results
    ]


# ============ OPAL Number Lookup ============


class OpalHistoryEntry(BaseModel):
    """Entry in OPAL number history."""

    event_type: str  # "created", "consumed", "transferred", "counted", "adjusted"
    timestamp: str
    details: dict


class OpalHistoryResponse(BaseModel):
    """Response for OPAL number history."""

    opal_number: str
    inventory: InventoryResponse
    history: list[OpalHistoryEntry]


@router.get("/opal/{opal_number}", response_model=InventoryResponse)
def get_inventory_by_opal(
    opal_number: str,
    db: DbSession,
) -> InventoryResponse:
    """Look up an inventory record by its OPAL number."""
    record = (
        db.query(InventoryRecord)
        .join(Part)
        .filter(InventoryRecord.opal_number == opal_number, Part.deleted_at.is_(None))
        .first()
    )
    if not record:
        raise HTTPException(
            status_code=status.HTTP_404_NOT_FOUND,
            detail=f"Inventory record with OPAL number {opal_number} not found",
        )

    return inventory_to_response(record)


@router.get("/opal/{opal_number}/history", response_model=OpalHistoryResponse)
def get_opal_history(
    opal_number: str,
    db: DbSession,
) -> OpalHistoryResponse:
    """Get the full lifecycle history of an item by OPAL number.

    Returns creation source, consumptions, transfers, counts, etc.
    """
    record = (
        db.query(InventoryRecord)
        .join(Part)
        .filter(InventoryRecord.opal_number == opal_number, Part.deleted_at.is_(None))
        .first()
    )
    if not record:
        raise HTTPException(
            status_code=status.HTTP_404_NOT_FOUND,
            detail=f"Inventory record with OPAL number {opal_number} not found",
        )

    history: list[OpalHistoryEntry] = []

    # Creation event
    source_details: dict = {
        "source_type": (
            record.source_type.value if hasattr(record.source_type, "value") else record.source_type
        )
        if record.source_type
        else "unknown"
    }
    if record.source_purchase_line_id:
        source_details["purchase_line_id"] = record.source_purchase_line_id
        if record.source_purchase_line:
            source_details["purchase_id"] = record.source_purchase_line.purchase_id
    if record.source_production_id:
        source_details["production_id"] = record.source_production_id

    history.append(
        OpalHistoryEntry(
            event_type="created",
            timestamp=record.created_at.isoformat(),
            details=source_details,
        )
    )

    # Consumptions
    for consumption in record.consumptions:
        history.append(
            OpalHistoryEntry(
                event_type="consumed",
                timestamp=consumption.created_at.isoformat(),
                details={
                    "quantity": float(consumption.quantity),
                    "consumption_type": consumption.consumption_type.value
                    if hasattr(consumption.consumption_type, "value")
                    else consumption.consumption_type,
                    "usage_type": consumption.usage_type.value
                    if hasattr(consumption.usage_type, "value")
                    else consumption.usage_type,
                    "procedure_instance_id": consumption.procedure_instance_id,
                    "step_execution_id": consumption.step_execution_id,
                },
            )
        )

    # Outgoing transfers (from this record)
    for transfer in record.outgoing_transfers:
        history.append(
            OpalHistoryEntry(
                event_type="transferred_out",
                timestamp=transfer.transferred_at.isoformat()
                if transfer.transferred_at
                else transfer.created_at.isoformat(),
                details={
                    "quantity": float(transfer.quantity),
                    "to_location": transfer.target_location,
                },
            )
        )

    # Incoming transfers (to this record) - this record was created from a transfer
    for transfer in record.incoming_transfers:
        history.append(
            OpalHistoryEntry(
                event_type="transferred_in",
                timestamp=transfer.transferred_at.isoformat()
                if transfer.transferred_at
                else transfer.created_at.isoformat(),
                details={
                    "quantity": float(transfer.quantity),
                    "from_location": transfer.source_location,
                },
            )
        )

    # Physical counts
    if record.last_counted_at:
        history.append(
            OpalHistoryEntry(
                event_type="counted",
                timestamp=record.last_counted_at.isoformat(),
                details={"quantity": float(record.quantity)},
            )
        )

    # Sort history by timestamp
    history.sort(key=lambda h: h.timestamp)

    return OpalHistoryResponse(
        opal_number=opal_number,
        inventory=inventory_to_response(record),
        history=history,
    )


# ============ OPAL record detail ============


class DetailPart(BaseModel):
    id: int
    internal_pn: str | None
    external_pn: str | None
    name: str
    unit_of_measure: str | None
    tracking_type: str
    is_tooling: bool
    tier: int
    tier_name: str | None
    lifecycle_state: str


class DetailPurchase(BaseModel):
    id: int
    reference: str | None
    supplier: str | None


class DetailExecution(BaseModel):
    id: int
    work_order_number: str | None
    serial_number: str | None = None


class DetailSource(BaseModel):
    type: str | None
    purchase: DetailPurchase | None = None
    execution: DetailExecution | None = None
    transferred_from_opal: str | None = None


class DetailLedgerRow(BaseModel):
    kind: str
    timestamp: str
    delta: Decimal
    balance: Decimal
    quantity: Decimal | None = None
    reason: str | None = None
    notes: str | None = None
    user_name: str | None = None
    execution: DetailExecution | None = None
    from_location: str | None = None
    to_location: str | None = None
    counterpart_opal: str | None = None


class DetailGenealogyRow(BaseModel):
    opal_number: str
    part_id: int | None
    part_number: str | None
    part_name: str | None
    quantity_used: Decimal
    work_order_number: str | None = None


class DetailTest(BaseModel):
    id: int
    template_id: int | None
    test_name: str
    result: str
    value: str | None
    notes: str | None
    tested_at: str | None
    tested_by_name: str | None


class DetailTestTemplate(BaseModel):
    id: int
    name: str
    description: str | None
    required: bool
    test_type: str
    min_value: Decimal | None
    max_value: Decimal | None
    unit: str | None


class OpalDetailResponse(BaseModel):
    inventory: InventoryResponse
    part: DetailPart
    source: DetailSource
    ledger: list[DetailLedgerRow]
    components: list[DetailGenealogyRow]
    assemblies: list[DetailGenealogyRow]
    tests: list[DetailTest]
    test_templates: list[DetailTestTemplate]


@router.get("/opal/{opal_number}/detail", response_model=OpalDetailResponse)
def get_opal_detail(opal_number: str, db: DbSession) -> OpalDetailResponse:
    """Everything the record page shows: the record, its part, where it came
    from, the quantity ledger with running balance, genealogy in both
    directions, and test results against the part's test templates."""
    from opal.config import get_active_project
    from opal.db.models.execution import ProcedureInstance

    record = (
        db.query(InventoryRecord)
        .join(Part)
        .filter(InventoryRecord.opal_number == opal_number, Part.deleted_at.is_(None))
        .first()
    )
    if not record:
        raise HTTPException(
            status_code=status.HTTP_404_NOT_FOUND,
            detail=f"Inventory record with OPAL number {opal_number} not found",
        )
    part = record.part

    project = get_active_project()
    tier_cfg = project.get_tier(part.tier) if project else None

    # Source
    source_type = getattr(record.source_type, "value", record.source_type)
    source = DetailSource(type=source_type)
    if record.source_purchase_line and record.source_purchase_line.purchase:
        po = record.source_purchase_line.purchase
        source.purchase = DetailPurchase(id=po.id, reference=po.reference, supplier=po.supplier)
    if record.source_production and record.source_production.procedure_instance:
        inst = record.source_production.procedure_instance
        source.execution = DetailExecution(
            id=inst.id,
            work_order_number=inst.work_order_number,
            serial_number=record.source_production.serial_number,
        )
    if source_type == "transfer" and record.incoming_transfers:
        first = min(record.incoming_transfers, key=lambda t: t.created_at)
        if first.source_inventory:
            source.transferred_from_opal = first.source_inventory.opal_number

    # Ledger
    entries = build_ledger(record)
    receipt = next((e for e in entries if e.kind == "received" and not e.user_name), None)
    if receipt:
        # The opening receipt is not a movement row; its author is the creator in the audit log
        created = (
            db.query(AuditLog)
            .filter(
                AuditLog.table_name == record.__tablename__,
                AuditLog.record_id == record.id,
                AuditLog.action == AuditAction.CREATE,
            )
            .first()
        )
        if created and created.user_id:
            author = db.get(User, created.user_id)
            receipt.user_name = author.name if author else None
    instance_ids = {e.instance_id for e in entries if e.instance_id}
    instances = (
        {
            i.id: i
            for i in db.query(ProcedureInstance)
            .filter(ProcedureInstance.id.in_(instance_ids))
            .all()
        }
        if instance_ids
        else {}
    )
    ledger = [
        DetailLedgerRow(
            kind=e.kind,
            timestamp=e.timestamp.isoformat(),
            delta=e.delta,
            balance=e.balance,
            quantity=e.quantity,
            reason=e.reason,
            notes=e.notes,
            user_name=e.user_name,
            execution=(
                DetailExecution(
                    id=e.instance_id,
                    work_order_number=instances[e.instance_id].work_order_number,
                    serial_number=e.serial_number,
                )
                if e.instance_id in instances
                else None
            ),
            from_location=e.from_location,
            to_location=e.to_location,
            counterpart_opal=e.counterpart_opal,
        )
        for e in entries
    ]

    # Genealogy
    genealogy = get_full_genealogy(db, opal_number)
    components = [
        DetailGenealogyRow(
            opal_number=c["component_opal_number"],
            part_id=c["part_id"],
            part_number=c["part_number"],
            part_name=c["part_name"],
            quantity_used=Decimal(str(c["quantity_used"])),
        )
        for c in genealogy["components"]
    ]
    assemblies = [
        DetailGenealogyRow(
            opal_number=a["assembly_opal_number"],
            part_id=a["part_id"],
            part_number=a["part_number"],
            part_name=a["part_name"],
            quantity_used=Decimal(str(a["quantity_used"])),
            work_order_number=a["work_order_number"],
        )
        for a in genealogy["assemblies_containing"]
    ]

    results = (
        db.query(StockTestResult)
        .filter(StockTestResult.inventory_record_id == record.id)
        .order_by(StockTestResult.created_at.desc())
        .all()
    )
    templates = (
        db.query(TestTemplate)
        .filter(TestTemplate.part_id == record.part_id)
        .order_by(TestTemplate.sort_order)
        .all()
    )

    return OpalDetailResponse(
        inventory=inventory_to_response(record),
        part=DetailPart(
            id=part.id,
            internal_pn=part.internal_pn,
            external_pn=part.external_pn,
            name=part.name,
            unit_of_measure=part.unit_of_measure,
            tracking_type=part.tracking_type,
            is_tooling=bool(part.is_tooling),
            tier=part.tier,
            tier_name=tier_cfg.name if tier_cfg else None,
            lifecycle_state=part.lifecycle_state,
        ),
        source=source,
        ledger=ledger,
        components=components,
        assemblies=assemblies,
        tests=[
            DetailTest(
                id=r.id,
                template_id=r.template_id,
                test_name=r.test_name,
                result=getattr(r.result, "value", r.result),
                value=r.value,
                notes=r.notes,
                tested_at=r.tested_at.isoformat() if r.tested_at else None,
                tested_by_name=r.tested_by_user.name if r.tested_by_user else None,
            )
            for r in results
        ],
        test_templates=[
            DetailTestTemplate(
                id=t.id,
                name=t.name,
                description=t.description,
                required=t.required,
                test_type=t.test_type,
                min_value=t.min_value,
                max_value=t.max_value,
                unit=t.unit,
            )
            for t in templates
        ],
    )


class InventoryCreateResponse(BaseModel):
    """Schema for inventory creation response (may create multiple records)."""

    items: list[InventoryResponse]
    total_created: int


@router.post("", response_model=InventoryCreateResponse, status_code=status.HTTP_201_CREATED)
def create_inventory(
    db: DbSession,
    inv_in: InventoryCreate,
    user_id: CurrentUserId,
) -> InventoryCreateResponse:
    """Create inventory record(s) with OPAL number(s) for traceability.

    For SERIALIZED parts (default): Creates individual records, one per unit,
    each with its own OPAL number. Quantity determines how many records to create.

    For BULK parts: Creates a single record with the full quantity and one OPAL number.
    """
    # Verify part exists
    part = db.query(Part).filter(Part.id == inv_in.part_id, Part.deleted_at.is_(None)).first()
    if not part:
        raise HTTPException(
            status_code=status.HTTP_404_NOT_FOUND,
            detail=f"Part {inv_in.part_id} not found",
        )

    # Inventory is a physical reference — draft parts block it; activation
    # never happens as a side effect (raises DraftPartsBlocked -> 409)
    ensure_parts_active(db, [part.id], "inventory record create")

    # Tier rules, driven by the configured tier's semantic fields — the same
    # ones purchase receiving enforces
    require_lot, auto_serial = receipt_rules(part) if inv_in.enforce_tier_rules else (False, False)
    lot_number = inv_in.lot_number.strip() if inv_in.lot_number else None
    if require_lot and not lot_number:
        raise HTTPException(
            status_code=status.HTTP_422_UNPROCESSABLE_ENTITY,
            detail=(
                f"Tier {part.tier} lot-tracked part '{part.name}' requires a "
                f"lot_number when receiving."
            ),
        )
    auto_serial = auto_serial and not lot_number
    if inv_in.quantity <= 0:
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST, detail="Quantity must be greater than zero"
        )

    created_records: list[InventoryRecord] = []

    if part.tracking_type == TrackingType.SERIALIZED:
        # Create individual records with unique OPAL numbers for each unit
        qty_to_create = int(inv_in.quantity)
        if qty_to_create < 1:
            raise HTTPException(
                status_code=status.HTTP_400_BAD_REQUEST,
                detail="Quantity must be at least 1 for serialized parts",
            )

        for _ in range(qty_to_create):
            opal_number = generate_opal_number(db)
            record = InventoryRecord(
                part_id=inv_in.part_id,
                quantity=1,  # Each serialized item has quantity 1
                location=inv_in.location,
                lot_number=generate_serial_number(db, part) if auto_serial else lot_number,
                opal_number=opal_number,
                source_type=SourceType.MANUAL,
                expiration_date=inv_in.expiration_date,
            )
            db.add(record)
            db.flush()  # Get the ID
            created_records.append(record)
    else:
        # BULK parts: single record with full quantity
        opal_number = generate_opal_number(db)
        record = InventoryRecord(
            part_id=inv_in.part_id,
            quantity=inv_in.quantity,
            location=inv_in.location,
            lot_number=lot_number,
            opal_number=opal_number,
            source_type=SourceType.MANUAL,
            expiration_date=inv_in.expiration_date,
        )
        db.add(record)
        db.flush()
        created_records.append(record)

    db.commit()

    # Log all created records
    for record in created_records:
        db.refresh(record)
        log_create(db, record, user_id)
    db.commit()

    return InventoryCreateResponse(
        items=[inventory_to_response(r) for r in created_records],
        total_created=len(created_records),
    )


# ============ Stock Transfers ============
# NOTE: These routes MUST be registered before /{inventory_id} to avoid
# FastAPI matching "transfers" / "transfer" as an inventory_id parameter.


class TransferCreate(BaseModel):
    """Schema for creating a stock transfer."""

    source_inventory_id: int
    target_location: str
    quantity: Decimal
    target_lot_number: str | None = None
    notes: str | None = None


class TransferResponse(BaseModel):
    """Schema for transfer response."""

    id: int
    part_id: int
    part_name: str
    quantity: Decimal
    source_inventory_id: int | None = None
    target_inventory_id: int | None = None
    source_opal_number: str | None = None
    target_opal_number: str | None = None
    source_location: str
    target_location: str
    source_lot_number: str | None
    target_lot_number: str | None
    status: str
    notes: str | None
    transferred_by_id: int | None
    transferred_at: str | None
    created_at: str

    model_config = {"from_attributes": True}


def _transfer_response(t: StockTransfer) -> TransferResponse:
    return TransferResponse(
        id=t.id,
        part_id=t.part_id,
        part_name=t.part.name,
        quantity=t.quantity,
        source_inventory_id=t.source_inventory_id,
        target_inventory_id=t.target_inventory_id,
        source_opal_number=t.source_inventory.opal_number if t.source_inventory else None,
        target_opal_number=t.target_inventory.opal_number if t.target_inventory else None,
        source_location=t.source_location,
        target_location=t.target_location,
        source_lot_number=t.source_lot_number,
        target_lot_number=t.target_lot_number,
        status=t.status.value if hasattr(t.status, "value") else t.status,
        notes=t.notes,
        transferred_by_id=t.transferred_by_id,
        transferred_at=t.transferred_at.isoformat() if t.transferred_at else None,
        created_at=t.created_at.isoformat(),
    )


@router.post("/transfer", response_model=TransferResponse, status_code=201)
def transfer_stock(
    data: TransferCreate,
    db: DbSession,
    user_id: CurrentUserId,
) -> TransferResponse:
    """Transfer stock from one location to another.

    This deducts from the source inventory and adds to the target location.
    If the target location doesn't exist for this part/lot combo, it's created.
    """
    # Get source inventory. Join Part and require it live: stock for a
    # soft-deleted part must not be movable (the other inventory routes all
    # filter deleted_at; this one did not).
    source = (
        db.query(InventoryRecord)
        .join(Part)
        .filter(
            InventoryRecord.id == data.source_inventory_id,
            Part.deleted_at.is_(None),
        )
        .first()
    )
    if not source:
        raise HTTPException(status_code=404, detail="Source inventory record not found")

    # Validate quantity
    if data.quantity <= 0:
        raise HTTPException(status_code=400, detail="Transfer quantity must be positive")

    if float(source.quantity) < float(data.quantity):
        raise HTTPException(
            status_code=400,
            detail=f"Insufficient quantity at source (have {source.quantity}, need {data.quantity})",
        )

    # Check if transferring to same location
    target_lot = data.target_lot_number or source.lot_number
    if source.location == data.target_location and source.lot_number == target_lot:
        raise HTTPException(
            status_code=400, detail="Cannot transfer to same location with same lot number"
        )

    # Find or create target inventory record. A serialized unit is never
    # merged into another record: it keeps its own OPAL number.
    serialized = source.part.tracking_type == TrackingType.SERIALIZED
    target = (
        None
        if serialized
        else db.query(InventoryRecord)
        .filter(
            InventoryRecord.part_id == source.part_id,
            InventoryRecord.location == data.target_location,
            InventoryRecord.lot_number == target_lot,
            InventoryRecord.id != source.id,
        )
        .first()
    )

    old_source = get_model_dict(source)
    if target:
        # Merge into the stock already there. SQL-side increment avoids lost
        # updates under concurrency
        target.quantity = InventoryRecord.quantity + data.quantity
        source.quantity = InventoryRecord.quantity - data.quantity
    elif Decimal(data.quantity) == Decimal(source.quantity):
        # The whole record moves: it keeps its OPAL number, so the physical
        # item stays traceable (a serialized unit can never be split)
        source.location = data.target_location
        source.lot_number = target_lot
        target = source
    else:
        if serialized:
            raise HTTPException(status_code=400, detail="Serialized units cannot be split")
        # Partial move: the moved quantity becomes its own record with its own
        # OPAL number, so both halves stay individually traceable
        target = InventoryRecord(
            part_id=source.part_id,
            quantity=data.quantity,
            location=data.target_location,
            lot_number=target_lot,
            opal_number=generate_opal_number(db),
            source_type=SourceType.TRANSFER,
            expiration_date=source.expiration_date,
        )
        db.add(target)
        db.flush()
        source.quantity = InventoryRecord.quantity - data.quantity

    # Capture locations/lots as they were before a relocation overwrote them
    source_location = old_source["location"]
    source_lot = old_source["lot_number"]

    # Create transfer record
    transfer = StockTransfer(
        source_inventory_id=source.id,
        target_inventory_id=target.id,
        part_id=source.part_id,
        quantity=data.quantity,
        source_location=source_location,
        target_location=data.target_location,
        source_lot_number=source_lot,
        target_lot_number=target_lot,
        status=TransferStatus.COMPLETED,
        notes=data.notes,
        transferred_by_id=user_id,
        transferred_at=datetime.now(UTC),
    )
    db.add(transfer)
    db.flush()
    log_create(db, transfer, user_id)
    db.commit()
    db.refresh(transfer)
    db.refresh(source)
    log_update(db, source, old_source, user_id)
    db.commit()

    return _transfer_response(transfer)


@router.get("/transfers", response_model=list[TransferResponse])
def list_transfers(
    db: DbSession,
    part_id: int | None = Query(None),
    location: str | None = Query(None, description="Filter by source or target location"),
    limit: int = Query(50, ge=1, le=200),
) -> list[TransferResponse]:
    """List stock transfers with optional filters."""
    query = db.query(StockTransfer).join(Part, StockTransfer.part_id == Part.id)

    if part_id:
        query = query.filter(StockTransfer.part_id == part_id)
    if location:
        query = query.filter(
            (StockTransfer.source_location == location)
            | (StockTransfer.target_location == location)
        )

    transfers = query.order_by(StockTransfer.created_at.desc()).limit(limit).all()

    return [_transfer_response(t) for t in transfers]


@router.get("/transfers/{transfer_id}", response_model=TransferResponse)
def get_transfer(
    transfer_id: int,
    db: DbSession,
) -> TransferResponse:
    """Get a specific stock transfer."""
    transfer = db.query(StockTransfer).filter(StockTransfer.id == transfer_id).first()
    if not transfer:
        raise HTTPException(status_code=404, detail="Transfer not found")

    return _transfer_response(transfer)


@router.get("/{inventory_id}", response_model=InventoryResponse)
def get_inventory(
    db: DbSession,
    inventory_id: int,
) -> InventoryResponse:
    """Get a specific inventory record."""
    record = (
        db.query(InventoryRecord)
        .join(Part)
        .filter(InventoryRecord.id == inventory_id, Part.deleted_at.is_(None))
        .first()
    )
    if not record:
        raise HTTPException(
            status_code=status.HTTP_404_NOT_FOUND,
            detail=f"Inventory record {inventory_id} not found",
        )

    return inventory_to_response(record)


@router.patch("/{inventory_id}", response_model=InventoryResponse)
def update_inventory(
    db: DbSession,
    inventory_id: int,
    inv_in: InventoryUpdate,
    user_id: CurrentUserId,
) -> InventoryResponse:
    """Update an inventory record."""
    record = (
        db.query(InventoryRecord)
        .join(Part)
        .filter(InventoryRecord.id == inventory_id, Part.deleted_at.is_(None))
        .first()
    )
    if not record:
        raise HTTPException(
            status_code=status.HTTP_404_NOT_FOUND,
            detail=f"Inventory record {inventory_id} not found",
        )

    old_values = get_model_dict(record)

    update_data = inv_in.model_dump(exclude_unset=True)
    for field, value in update_data.items():
        setattr(record, field, value)

    db.commit()
    db.refresh(record)

    log_update(db, record, old_values, user_id)
    db.commit()

    return inventory_to_response(record)


@router.post("/{inventory_id}/adjust", response_model=InventoryResponse)
def adjust_inventory(
    db: DbSession,
    inventory_id: int,
    adjust_in: InventoryAdjust,
    user_id: CurrentUserId,
) -> InventoryResponse:
    """Adjust inventory quantity (add or subtract).

    Creates consumption or production records for traceability.
    Reason-based validation:
    - found: adjustment must be positive
    - damage/scrap: adjustment must be negative
    - cycle_count: also sets last_counted_at timestamp
    """
    record = (
        db.query(InventoryRecord)
        .join(Part)
        .filter(InventoryRecord.id == inventory_id, Part.deleted_at.is_(None))
        .first()
    )
    if not record:
        raise HTTPException(
            status_code=status.HTTP_404_NOT_FOUND,
            detail=f"Inventory record {inventory_id} not found",
        )

    reason = adjust_in.reason
    adjustment = adjust_in.adjustment

    # Validate reason/adjustment sign
    if reason == AdjustmentReason.FOUND and adjustment <= 0:
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail="'found' adjustments must be positive",
        )
    if reason in (AdjustmentReason.DAMAGE, AdjustmentReason.SCRAP) and adjustment >= 0:
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail=f"'{reason.value}' adjustments must be negative",
        )

    old_values = get_model_dict(record)

    new_quantity = record.quantity + adjustment
    if new_quantity < 0:
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail=f"Adjustment would result in negative quantity ({new_quantity})",
        )

    # For serialized parts, reject adjustments that would make quantity > 1
    if record.part.tracking_type == TrackingType.SERIALIZED and new_quantity > 1:
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail="Serialized parts cannot have quantity greater than 1",
        )

    record.quantity = new_quantity

    # Set last_counted_at for cycle counts
    if reason == AdjustmentReason.CYCLE_COUNT:
        record.last_counted_at = datetime.now(UTC)

    db.flush()

    # Create consumption or production record for traceability
    if adjustment < 0:
        consumption_type = (
            ConsumptionType.SCRAP
            if reason in (AdjustmentReason.DAMAGE, AdjustmentReason.SCRAP)
            else ConsumptionType.ADJUSTMENT
        )
        consumption = InventoryConsumption(
            inventory_record_id=record.id,
            quantity=abs(adjustment),
            consumption_type=consumption_type,
            usage_type=UsageType.CONSUME,
            notes=f"[{reason.value}] {adjust_in.notes}" if adjust_in.notes else f"[{reason.value}]",
            consumed_by_id=user_id,
        )
        db.add(consumption)
        db.flush()
        log_create(db, consumption, user_id)
    elif adjustment > 0:
        production = InventoryProduction(
            inventory_record_id=record.id,
            quantity=adjustment,
            notes=f"[{reason.value}] {adjust_in.notes}" if adjust_in.notes else f"[{reason.value}]",
            produced_by_id=user_id,
        )
        db.add(production)
        db.flush()
        log_create(db, production, user_id)

    db.commit()
    db.refresh(record)

    log_update(db, record, old_values, user_id)
    db.commit()

    return inventory_to_response(record)


@router.post("/{inventory_id}/count", response_model=InventoryResponse)
def record_count(
    db: DbSession,
    inventory_id: int,
    count_in: InventoryCount,
    user_id: CurrentUserId,
) -> InventoryResponse:
    """Record a physical count, updating quantity and timestamp."""
    record = (
        db.query(InventoryRecord)
        .join(Part)
        .filter(InventoryRecord.id == inventory_id, Part.deleted_at.is_(None))
        .first()
    )
    if not record:
        raise HTTPException(
            status_code=status.HTTP_404_NOT_FOUND,
            detail=f"Inventory record {inventory_id} not found",
        )

    counted = count_in.counted_quantity
    if counted < 0:
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail=f"Counted quantity cannot be negative ({counted})",
        )
    if record.part.tracking_type == TrackingType.SERIALIZED and counted > 1:
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail="Serialized parts cannot have quantity greater than 1",
        )

    old_values = get_model_dict(record)

    # A count reconciles on-hand to a physical number; record the difference as
    # a ledger row so the change is traceable, exactly like an /adjust would.
    delta = counted - record.quantity
    record.quantity = counted
    record.last_counted_at = datetime.now(UTC)
    db.flush()

    if delta < 0:
        consumption = InventoryConsumption(
            inventory_record_id=record.id,
            quantity=abs(delta),
            consumption_type=ConsumptionType.ADJUSTMENT,
            usage_type=UsageType.CONSUME,
            notes="[cycle_count]",
            consumed_by_id=user_id,
        )
        db.add(consumption)
        db.flush()
        log_create(db, consumption, user_id)
    elif delta > 0:
        production = InventoryProduction(
            inventory_record_id=record.id,
            quantity=delta,
            notes="[cycle_count]",
            produced_by_id=user_id,
        )
        db.add(production)
        db.flush()
        log_create(db, production, user_id)

    db.commit()
    db.refresh(record)

    log_update(db, record, old_values, user_id)
    db.commit()

    return inventory_to_response(record)


@router.post("/{inventory_id}/calibrate", response_model=InventoryResponse)
def record_calibration(
    db: DbSession,
    inventory_id: int,
    user_id: CurrentUserId,
) -> InventoryResponse:
    """Record a calibration event for a tooling item.

    Sets last_calibrated_at to now and computes calibration_due_at
    from the part's calibration_interval_days.
    """
    record = (
        db.query(InventoryRecord)
        .join(Part)
        .filter(InventoryRecord.id == inventory_id, Part.deleted_at.is_(None))
        .first()
    )
    if not record:
        raise HTTPException(
            status_code=status.HTTP_404_NOT_FOUND,
            detail=f"Inventory record {inventory_id} not found",
        )

    if not record.part.is_tooling:
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail="This part is not marked as tooling",
        )

    old_values = get_model_dict(record)

    now = datetime.now(UTC)
    record.last_calibrated_at = now

    if record.part.calibration_interval_days:
        record.calibration_due_at = now + timedelta(days=record.part.calibration_interval_days)
    else:
        record.calibration_due_at = None

    db.commit()
    db.refresh(record)

    log_update(db, record, old_values, user_id)
    db.commit()

    return inventory_to_response(record)


@router.delete("/{inventory_id}", status_code=status.HTTP_204_NO_CONTENT)
def delete_inventory(
    db: DbSession,
    inventory_id: int,
    user_id: CurrentUserId,
) -> None:
    """Delete an inventory record."""
    record = db.query(InventoryRecord).filter(InventoryRecord.id == inventory_id).first()
    if not record:
        raise HTTPException(
            status_code=status.HTTP_404_NOT_FOUND,
            detail=f"Inventory record {inventory_id} not found",
        )

    log_delete(db, record, user_id)
    db.delete(record)
    db.commit()


# ============ Test Results ============


class TestTemplateCreate(BaseModel):
    """Schema for creating a test template."""

    name: str
    description: str | None = None
    required: bool = False
    test_type: str = "boolean"  # boolean, numeric, text
    min_value: Decimal | None = None
    max_value: Decimal | None = None
    unit: str | None = None
    sort_order: int = 0


class TestTemplateResponse(BaseModel):
    """Schema for test template response."""

    id: int
    part_id: int
    name: str
    description: str | None
    required: bool
    test_type: str
    min_value: Decimal | None
    max_value: Decimal | None
    unit: str | None
    sort_order: int
    created_at: str

    model_config = {"from_attributes": True}


class TestResultCreate(BaseModel):
    """Schema for creating a test result."""

    test_name: str
    template_id: int | None = None
    result: str = "pending"  # pass, fail, pending
    value: str | None = None
    notes: str | None = None


class TestResultResponse(BaseModel):
    """Schema for test result response."""

    id: int
    inventory_record_id: int
    template_id: int | None
    test_name: str
    result: str
    value: str | None
    notes: str | None
    tested_at: str | None
    tested_by_id: int | None
    created_at: str

    model_config = {"from_attributes": True}


# Test Templates (Part-level)


@router.get("/parts/{part_id}/test-templates", response_model=list[TestTemplateResponse])
def list_test_templates(
    part_id: int,
    db: DbSession,
) -> list[TestTemplateResponse]:
    """List all test templates for a part."""
    part = db.query(Part).filter(Part.id == part_id, Part.deleted_at.is_(None)).first()
    if not part:
        raise HTTPException(status_code=404, detail=f"Part {part_id} not found")

    templates = (
        db.query(TestTemplate)
        .filter(TestTemplate.part_id == part_id)
        .order_by(TestTemplate.sort_order)
        .all()
    )

    return [
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
        for t in templates
    ]


@router.post(
    "/parts/{part_id}/test-templates", response_model=TestTemplateResponse, status_code=201
)
def create_test_template(
    part_id: int,
    data: TestTemplateCreate,
    db: DbSession,
    user_id: CurrentUserId,
) -> TestTemplateResponse:
    """Create a test template for a part."""
    part = db.query(Part).filter(Part.id == part_id, Part.deleted_at.is_(None)).first()
    if not part:
        raise HTTPException(status_code=404, detail=f"Part {part_id} not found")

    template = TestTemplate(
        part_id=part_id,
        name=data.name,
        description=data.description,
        required=data.required,
        test_type=data.test_type,
        min_value=data.min_value,
        max_value=data.max_value,
        unit=data.unit,
        sort_order=data.sort_order,
    )
    db.add(template)
    db.flush()
    log_create(db, template, user_id)
    db.commit()
    db.refresh(template)

    return TestTemplateResponse(
        id=template.id,
        part_id=template.part_id,
        name=template.name,
        description=template.description,
        required=template.required,
        test_type=template.test_type,
        min_value=template.min_value,
        max_value=template.max_value,
        unit=template.unit,
        sort_order=template.sort_order,
        created_at=template.created_at.isoformat(),
    )


@router.delete("/parts/{part_id}/test-templates/{template_id}", status_code=204)
def delete_test_template(
    part_id: int,
    template_id: int,
    db: DbSession,
    user_id: CurrentUserId,
) -> None:
    """Delete a test template."""
    template = (
        db.query(TestTemplate)
        .filter(TestTemplate.id == template_id, TestTemplate.part_id == part_id)
        .first()
    )
    if not template:
        raise HTTPException(status_code=404, detail="Test template not found")

    log_delete(db, template, user_id)
    db.delete(template)
    db.commit()


# Stock Test Results (Inventory-level)


@router.get("/{inventory_id}/tests", response_model=list[TestResultResponse])
def list_test_results(
    inventory_id: int,
    db: DbSession,
) -> list[TestResultResponse]:
    """List all test results for an inventory record."""
    record = db.query(InventoryRecord).filter(InventoryRecord.id == inventory_id).first()
    if not record:
        raise HTTPException(status_code=404, detail=f"Inventory record {inventory_id} not found")

    results = (
        db.query(StockTestResult)
        .filter(StockTestResult.inventory_record_id == inventory_id)
        .order_by(StockTestResult.created_at.desc())
        .all()
    )

    return [
        TestResultResponse(
            id=r.id,
            inventory_record_id=r.inventory_record_id,
            template_id=r.template_id,
            test_name=r.test_name,
            result=r.result.value if hasattr(r.result, "value") else r.result,
            value=r.value,
            notes=r.notes,
            tested_at=r.tested_at.isoformat() if r.tested_at else None,
            tested_by_id=r.tested_by_id,
            created_at=r.created_at.isoformat(),
        )
        for r in results
    ]


@router.post("/{inventory_id}/tests", response_model=TestResultResponse, status_code=201)
def create_test_result(
    inventory_id: int,
    data: TestResultCreate,
    db: DbSession,
    user_id: CurrentUserId,
) -> TestResultResponse:
    """Add a test result to an inventory record."""
    record = db.query(InventoryRecord).filter(InventoryRecord.id == inventory_id).first()
    if not record:
        raise HTTPException(status_code=404, detail=f"Inventory record {inventory_id} not found")

    # Validate result value
    try:
        result_enum = TestResult(data.result)
    except ValueError as err:
        raise HTTPException(status_code=400, detail=f"Invalid result: {data.result}") from err

    # If template_id provided, validate it
    if data.template_id:
        template = db.query(TestTemplate).filter(TestTemplate.id == data.template_id).first()
        if not template:
            raise HTTPException(
                status_code=404, detail=f"Test template {data.template_id} not found"
            )

    test_result = StockTestResult(
        inventory_record_id=inventory_id,
        template_id=data.template_id,
        test_name=data.test_name,
        result=result_enum,
        value=data.value,
        notes=data.notes,
        tested_at=datetime.now(UTC) if result_enum != TestResult.PENDING else None,
        tested_by_id=user_id,
    )
    db.add(test_result)
    db.flush()
    log_create(db, test_result, user_id)
    db.commit()
    db.refresh(test_result)

    return TestResultResponse(
        id=test_result.id,
        inventory_record_id=test_result.inventory_record_id,
        template_id=test_result.template_id,
        test_name=test_result.test_name,
        result=test_result.result.value
        if hasattr(test_result.result, "value")
        else test_result.result,
        value=test_result.value,
        notes=test_result.notes,
        tested_at=test_result.tested_at.isoformat() if test_result.tested_at else None,
        tested_by_id=test_result.tested_by_id,
        created_at=test_result.created_at.isoformat(),
    )


@router.patch("/{inventory_id}/tests/{test_id}", response_model=TestResultResponse)
def update_test_result(
    inventory_id: int,
    test_id: int,
    data: TestResultCreate,
    db: DbSession,
    user_id: CurrentUserId,
) -> TestResultResponse:
    """Update a test result."""
    test_result = (
        db.query(StockTestResult)
        .filter(StockTestResult.id == test_id, StockTestResult.inventory_record_id == inventory_id)
        .first()
    )
    if not test_result:
        raise HTTPException(status_code=404, detail="Test result not found")

    old_values = get_model_dict(test_result)

    # Validate result value
    try:
        result_enum = TestResult(data.result)
    except ValueError as err:
        raise HTTPException(status_code=400, detail=f"Invalid result: {data.result}") from err

    test_result.test_name = data.test_name
    test_result.result = result_enum
    test_result.value = data.value
    test_result.notes = data.notes

    # Set tested_at when result changes from pending
    if result_enum != TestResult.PENDING and not test_result.tested_at:
        test_result.tested_at = datetime.now(UTC)
        test_result.tested_by_id = user_id

    log_update(db, test_result, old_values, user_id)
    db.commit()
    db.refresh(test_result)

    return TestResultResponse(
        id=test_result.id,
        inventory_record_id=test_result.inventory_record_id,
        template_id=test_result.template_id,
        test_name=test_result.test_name,
        result=test_result.result.value
        if hasattr(test_result.result, "value")
        else test_result.result,
        value=test_result.value,
        notes=test_result.notes,
        tested_at=test_result.tested_at.isoformat() if test_result.tested_at else None,
        tested_by_id=test_result.tested_by_id,
        created_at=test_result.created_at.isoformat(),
    )


@router.delete("/{inventory_id}/tests/{test_id}", status_code=204)
def delete_test_result(
    inventory_id: int,
    test_id: int,
    db: DbSession,
    user_id: CurrentUserId,
) -> None:
    """Delete a test result."""
    test_result = (
        db.query(StockTestResult)
        .filter(StockTestResult.id == test_id, StockTestResult.inventory_record_id == inventory_id)
        .first()
    )
    if not test_result:
        raise HTTPException(status_code=404, detail="Test result not found")

    log_delete(db, test_result, user_id)
    db.delete(test_result)
    db.commit()


@router.get("/{inventory_id}/test-status")
def get_test_status(
    inventory_id: int,
    db: DbSession,
) -> dict:
    """Get overall test status for an inventory record.

    Returns counts of passed, failed, and pending tests,
    plus whether all required tests have passed.
    """
    record = db.query(InventoryRecord).filter(InventoryRecord.id == inventory_id).first()
    if not record:
        raise HTTPException(status_code=404, detail=f"Inventory record {inventory_id} not found")

    # Get all test results
    results = (
        db.query(StockTestResult).filter(StockTestResult.inventory_record_id == inventory_id).all()
    )

    # Count by status
    passed = sum(
        1 for r in results if (r.result.value if hasattr(r.result, "value") else r.result) == "pass"
    )
    failed = sum(
        1 for r in results if (r.result.value if hasattr(r.result, "value") else r.result) == "fail"
    )
    pending = sum(
        1
        for r in results
        if (r.result.value if hasattr(r.result, "value") else r.result) == "pending"
    )

    # Check required tests from templates
    required_templates = (
        db.query(TestTemplate)
        .filter(TestTemplate.part_id == record.part_id, TestTemplate.required == True)  # noqa: E712
        .all()
    )

    required_passed = True
    missing_required = []
    for template in required_templates:
        template_results = [r for r in results if r.template_id == template.id]
        if not template_results or not any(
            (r.result.value if hasattr(r.result, "value") else r.result) == "pass"
            for r in template_results
        ):
            required_passed = False
            missing_required.append(template.name)

    return {
        "inventory_record_id": inventory_id,
        "total_tests": len(results),
        "passed": passed,
        "failed": failed,
        "pending": pending,
        "required_tests_passed": required_passed,
        "missing_required_tests": missing_required,
        "overall_status": "pass"
        if failed == 0 and pending == 0 and required_passed and len(results) > 0
        else ("fail" if failed > 0 else "pending"),
    }
