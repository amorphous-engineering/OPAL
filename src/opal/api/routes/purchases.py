"""Purchase order management endpoints."""

from datetime import UTC, date, datetime
from decimal import Decimal

from fastapi import APIRouter, HTTPException, Query, status
from pydantic import BaseModel, Field

from opal.api.deps import CurrentUserId, DbSession, PaginationParams
from opal.config import get_active_project
from opal.core.audit import get_model_dict, log_create, log_update
from opal.core.designators import generate_serial_number
from opal.core.inventory import generate_opal_number
from opal.core.part_lifecycle import ensure_parts_active
from opal.db.models import InventoryRecord, Part, Purchase, PurchaseExpense, PurchaseLine, Supplier
from opal.db.models.inventory import SourceType
from opal.db.models.part import TrackingType
from opal.db.models.purchase import PurchaseStatus
from opal.project import tier_semantics

router = APIRouter()


class PurchaseLineCreate(BaseModel):
    """Schema for creating a purchase line."""

    part_id: int
    qty_ordered: Decimal
    unit_cost: Decimal | None = None
    destination: str | None = Field(None, max_length=255)
    notes: str | None = None


class PurchaseLineUpdate(BaseModel):
    """Schema for updating a purchase line."""

    qty_ordered: Decimal | None = None
    unit_cost: Decimal | None = None
    destination: str | None = None
    notes: str | None = None


class PurchaseCreate(BaseModel):
    """Schema for creating a purchase order."""

    supplier: str
    supplier_id: int | None = None
    supplier_reference: str | None = Field(None, max_length=100)
    reference: str | None = Field(None, max_length=64)
    target_date: date | None = None
    destination: str | None = Field(None, max_length=255)
    notes: str | None = None
    lines: list[PurchaseLineCreate] = []


class PurchaseUpdate(BaseModel):
    """Schema for updating a purchase order."""

    supplier: str | None = None
    supplier_id: int | None = None
    supplier_reference: str | None = None
    reference: str | None = None
    target_date: date | None = None
    destination: str | None = None
    notes: str | None = None
    status: PurchaseStatus | None = None


class ReceiveLine(BaseModel):
    """Schema for receiving a line item."""

    line_id: int
    qty_received: Decimal
    location: str
    lot_number: str | None = None


class PurchaseExpenseResponse(BaseModel):
    """Expense ledger record for a PO receive event."""

    id: int
    purchase_id: int
    purchase_line_id: int | None = None
    part_id: int | None = None
    part_name: str | None = None
    quantity: Decimal
    unit_cost: Decimal | None = None
    total_cost: Decimal | None = None
    tier: int | None = None
    received_at: datetime
    notes: str | None = None

    model_config = {"from_attributes": True}


class ReceiveRequest(BaseModel):
    """Schema for receiving against a PO."""

    lines: list[ReceiveLine]


class PurchaseLineResponse(BaseModel):
    """Schema for purchase line response."""

    id: int
    part_id: int
    part_name: str
    part_external_pn: str | None
    qty_ordered: Decimal
    qty_received: Decimal
    qty_outstanding: Decimal
    unit_cost: Decimal | None
    destination: str | None
    notes: str | None
    is_complete: bool

    model_config = {"from_attributes": True}


class PurchaseResponse(BaseModel):
    """Schema for purchase order response."""

    id: int
    reference: str | None
    supplier: str
    supplier_id: int | None
    supplier_name: str | None
    supplier_reference: str | None
    status: PurchaseStatus
    target_date: str | None
    destination: str | None
    ordered_at: str | None
    received_at: str | None
    is_overdue: bool
    notes: str | None
    lines: list[PurchaseLineResponse]
    total_lines: int
    total_cost: Decimal | None
    created_at: str
    updated_at: str
    created_by_id: int | None
    created_by_name: str | None
    received_by_id: int | None
    received_by_name: str | None

    model_config = {"from_attributes": True}


class PurchaseListItem(BaseModel):
    """Schema for purchase in list view."""

    id: int
    reference: str | None
    supplier: str
    supplier_name: str | None
    status: PurchaseStatus
    target_date: str | None
    is_overdue: bool
    ordered_at: str | None
    total_lines: int
    total_cost: Decimal | None
    created_at: str

    model_config = {"from_attributes": True}


class PurchaseListResponse(BaseModel):
    """Schema for purchase list response."""

    items: list[PurchaseListItem]
    total: int


def line_to_response(line: PurchaseLine) -> PurchaseLineResponse:
    """Convert purchase line to response."""
    return PurchaseLineResponse(
        id=line.id,
        part_id=line.part_id,
        part_name=line.part.name,
        part_external_pn=line.part.external_pn,
        qty_ordered=line.qty_ordered,
        qty_received=line.qty_received,
        qty_outstanding=line.qty_outstanding,
        unit_cost=line.unit_cost,
        destination=line.destination,
        notes=line.notes,
        is_complete=line.is_complete,
    )


def purchase_to_response(purchase: Purchase) -> PurchaseResponse:
    """Convert purchase to full response."""
    lines = [line_to_response(line) for line in purchase.lines]
    total_cost = sum(
        (line.unit_cost or Decimal(0)) * line.qty_ordered
        for line in purchase.lines
        if line.unit_cost
    )

    return PurchaseResponse(
        id=purchase.id,
        reference=purchase.reference,
        supplier=purchase.supplier,
        supplier_id=purchase.supplier_id,
        supplier_name=purchase.supplier_rel.name if purchase.supplier_rel else None,
        supplier_reference=purchase.supplier_reference,
        status=purchase.status,
        target_date=purchase.target_date.isoformat() if purchase.target_date else None,
        destination=purchase.destination,
        ordered_at=purchase.ordered_at.isoformat() if purchase.ordered_at else None,
        received_at=purchase.received_at.isoformat() if purchase.received_at else None,
        is_overdue=purchase.is_overdue,
        notes=purchase.notes,
        lines=lines,
        total_lines=len(lines),
        total_cost=total_cost if total_cost > 0 else None,
        created_at=purchase.created_at.isoformat(),
        updated_at=purchase.updated_at.isoformat(),
        created_by_id=purchase.created_by_id,
        created_by_name=purchase.created_by.name if purchase.created_by else None,
        received_by_id=purchase.received_by_id,
        received_by_name=purchase.received_by.name if purchase.received_by else None,
    )


def purchase_to_list_item(purchase: Purchase) -> PurchaseListItem:
    """Convert purchase to list item."""
    total_cost = sum(
        (line.unit_cost or Decimal(0)) * line.qty_ordered
        for line in purchase.lines
        if line.unit_cost
    )

    return PurchaseListItem(
        id=purchase.id,
        reference=purchase.reference,
        supplier=purchase.supplier,
        supplier_name=purchase.supplier_rel.name if purchase.supplier_rel else None,
        status=purchase.status,
        target_date=purchase.target_date.isoformat() if purchase.target_date else None,
        is_overdue=purchase.is_overdue,
        ordered_at=purchase.ordered_at.isoformat() if purchase.ordered_at else None,
        total_lines=len(purchase.lines),
        total_cost=total_cost if total_cost > 0 else None,
        created_at=purchase.created_at.isoformat(),
    )


@router.get("", response_model=PurchaseListResponse)
def list_purchases(
    db: DbSession,
    pagination: PaginationParams,
    status_filter: PurchaseStatus | None = Query(None, alias="status"),
    supplier: str | None = Query(None),
) -> PurchaseListResponse:
    """List purchase orders with optional filtering."""
    query = db.query(Purchase)

    if status_filter:
        query = query.filter(Purchase.status == status_filter)
    if supplier:
        query = query.filter(Purchase.supplier.ilike(f"%{supplier}%"))

    total = query.count()
    purchases = (
        query.order_by(Purchase.id.desc()).offset(pagination.skip).limit(pagination.limit).all()
    )

    return PurchaseListResponse(
        items=[purchase_to_list_item(p) for p in purchases],
        total=total,
    )


@router.post("", response_model=PurchaseResponse, status_code=status.HTTP_201_CREATED)
def create_purchase(
    db: DbSession,
    po_in: PurchaseCreate,
    user_id: CurrentUserId,
) -> PurchaseResponse:
    """Create a new purchase order."""
    # Validate supplier_id if provided
    if po_in.supplier_id:
        supplier = (
            db.query(Supplier)
            .filter(Supplier.id == po_in.supplier_id, Supplier.deleted_at.is_(None))
            .first()
        )
        if not supplier:
            raise HTTPException(
                status_code=status.HTTP_404_NOT_FOUND,
                detail=f"Supplier {po_in.supplier_id} not found",
            )

    # Check for duplicate reference
    if po_in.reference:
        existing = db.query(Purchase).filter(Purchase.reference == po_in.reference).first()
        if existing:
            raise HTTPException(
                status_code=status.HTTP_409_CONFLICT,
                detail=f"PO with reference '{po_in.reference}' already exists",
            )

    # A PO line is a financial commitment — draft parts block it; activation
    # never happens as a side effect (raises DraftPartsBlocked -> 409)
    ensure_parts_active(
        db,
        [line_in.part_id for line_in in po_in.lines],
        f"PO {po_in.reference or 'create'} line add",
    )

    purchase = Purchase(
        supplier=po_in.supplier,
        supplier_id=po_in.supplier_id,
        supplier_reference=po_in.supplier_reference,
        reference=po_in.reference,
        target_date=po_in.target_date,
        destination=po_in.destination,
        notes=po_in.notes,
        status=PurchaseStatus.DRAFT,
        created_by_id=user_id,
    )
    db.add(purchase)
    db.flush()  # Get ID

    # Add lines
    for line_in in po_in.lines:
        # Verify part exists
        part = db.query(Part).filter(Part.id == line_in.part_id, Part.deleted_at.is_(None)).first()
        if not part:
            raise HTTPException(
                status_code=status.HTTP_404_NOT_FOUND,
                detail=f"Part {line_in.part_id} not found",
            )

        line = PurchaseLine(
            purchase_id=purchase.id,
            part_id=line_in.part_id,
            qty_ordered=line_in.qty_ordered,
            unit_cost=line_in.unit_cost,
            destination=line_in.destination,
            notes=line_in.notes,
        )
        db.add(line)

    db.flush()
    log_create(db, purchase, user_id)
    db.commit()

    return purchase_to_response(purchase)


@router.get("/{purchase_id}", response_model=PurchaseResponse)
def get_purchase(
    db: DbSession,
    purchase_id: int,
) -> PurchaseResponse:
    """Get a specific purchase order."""
    purchase = db.query(Purchase).filter(Purchase.id == purchase_id).first()
    if not purchase:
        raise HTTPException(
            status_code=status.HTTP_404_NOT_FOUND,
            detail=f"Purchase order {purchase_id} not found",
        )

    return purchase_to_response(purchase)


@router.patch("/{purchase_id}", response_model=PurchaseResponse)
def update_purchase(
    db: DbSession,
    purchase_id: int,
    po_in: PurchaseUpdate,
    user_id: CurrentUserId,
) -> PurchaseResponse:
    """Update a purchase order."""
    purchase = db.query(Purchase).filter(Purchase.id == purchase_id).first()
    if not purchase:
        raise HTTPException(
            status_code=status.HTTP_404_NOT_FOUND,
            detail=f"Purchase order {purchase_id} not found",
        )

    old_values = get_model_dict(purchase)

    update_data = po_in.model_dump(exclude_unset=True)

    # Handle status transitions
    if "status" in update_data:
        new_status = update_data["status"]
        if new_status == PurchaseStatus.ORDERED and purchase.status == PurchaseStatus.DRAFT:
            update_data["ordered_at"] = datetime.now(UTC)
        elif new_status == PurchaseStatus.CANCELLED:
            pass  # Allow cancellation from any state

    for field, value in update_data.items():
        setattr(purchase, field, value)

    db.commit()
    db.refresh(purchase)

    log_update(db, purchase, old_values, user_id)
    db.commit()

    return purchase_to_response(purchase)


@router.post(
    "/{purchase_id}/lines", response_model=PurchaseLineResponse, status_code=status.HTTP_201_CREATED
)
def add_purchase_line(
    db: DbSession,
    purchase_id: int,
    line_in: PurchaseLineCreate,
    user_id: CurrentUserId,
) -> PurchaseLineResponse:
    """Add a line to a purchase order."""
    purchase = db.query(Purchase).filter(Purchase.id == purchase_id).first()
    if not purchase:
        raise HTTPException(
            status_code=status.HTTP_404_NOT_FOUND,
            detail=f"Purchase order {purchase_id} not found",
        )

    if purchase.status not in (PurchaseStatus.DRAFT, PurchaseStatus.ORDERED):
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail=f"Cannot add lines to purchase in {purchase.status} status",
        )

    # Verify part exists
    part = db.query(Part).filter(Part.id == line_in.part_id, Part.deleted_at.is_(None)).first()
    if not part:
        raise HTTPException(
            status_code=status.HTTP_404_NOT_FOUND,
            detail=f"Part {line_in.part_id} not found",
        )

    ensure_parts_active(db, [line_in.part_id], f"PO {purchase.reference or purchase_id} line add")

    line = PurchaseLine(
        purchase_id=purchase_id,
        part_id=line_in.part_id,
        qty_ordered=line_in.qty_ordered,
        unit_cost=line_in.unit_cost,
    )
    db.add(line)
    db.commit()
    db.refresh(line)

    return line_to_response(line)


@router.patch("/{purchase_id}/lines/{line_id}", response_model=PurchaseLineResponse)
def update_purchase_line(
    db: DbSession,
    purchase_id: int,
    line_id: int,
    line_in: PurchaseLineUpdate,
    user_id: CurrentUserId,
) -> PurchaseLineResponse:
    """Update a purchase line."""
    line = (
        db.query(PurchaseLine)
        .filter(PurchaseLine.id == line_id, PurchaseLine.purchase_id == purchase_id)
        .first()
    )
    if not line:
        raise HTTPException(
            status_code=status.HTTP_404_NOT_FOUND,
            detail=f"Purchase line {line_id} not found",
        )

    update_data = line_in.model_dump(exclude_unset=True)
    for field, value in update_data.items():
        setattr(line, field, value)

    db.commit()
    db.refresh(line)

    return line_to_response(line)


@router.delete("/{purchase_id}/lines/{line_id}", status_code=status.HTTP_204_NO_CONTENT)
def delete_purchase_line(
    db: DbSession,
    purchase_id: int,
    line_id: int,
    user_id: CurrentUserId,
) -> None:
    """Delete a purchase line."""
    line = (
        db.query(PurchaseLine)
        .filter(PurchaseLine.id == line_id, PurchaseLine.purchase_id == purchase_id)
        .first()
    )
    if not line:
        raise HTTPException(
            status_code=status.HTTP_404_NOT_FOUND,
            detail=f"Purchase line {line_id} not found",
        )

    if line.qty_received > 0:
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail="Cannot delete line that has been partially received",
        )

    db.delete(line)
    db.commit()


@router.post("/{purchase_id}/receive", response_model=PurchaseResponse)
def receive_purchase(
    db: DbSession,
    purchase_id: int,
    receive_in: ReceiveRequest,
    user_id: CurrentUserId,
) -> PurchaseResponse:
    """Receive items against a purchase order."""
    purchase = db.query(Purchase).filter(Purchase.id == purchase_id).first()
    if not purchase:
        raise HTTPException(
            status_code=status.HTTP_404_NOT_FOUND,
            detail=f"Purchase order {purchase_id} not found",
        )

    if purchase.status not in (PurchaseStatus.ORDERED, PurchaseStatus.PARTIAL):
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail=f"Cannot receive against purchase in {purchase.status} status",
        )

    old_values = get_model_dict(purchase)

    for recv in receive_in.lines:
        line = (
            db.query(PurchaseLine)
            .filter(PurchaseLine.id == recv.line_id, PurchaseLine.purchase_id == purchase_id)
            .first()
        )
        if not line:
            raise HTTPException(
                status_code=status.HTTP_404_NOT_FOUND,
                detail=f"Purchase line {recv.line_id} not found",
            )

        if recv.qty_received <= 0:
            raise HTTPException(
                status_code=status.HTTP_400_BAD_REQUEST,
                detail="Received quantity must be positive",
            )

        # Update line received quantity
        line.qty_received += recv.qty_received

        # Get the part to check tracking type
        part = db.query(Part).filter(Part.id == line.part_id).first()

        # Defense-in-depth: line parts are active by construction (line
        # creation is guarded), but receiving creates inventory — never
        # against a draft
        ensure_parts_active(
            db, [line.part_id], f"receive against PO {purchase.reference or purchase_id}"
        )

        # Tier enforcement, driven by the configured tier's semantic fields
        auto_serial = False
        if part:
            tier_cfg = tier_semantics(get_active_project(), part.tier)
            tracking = part.tracking_type

            # Lot-tracked tiers: bulk receipts must carry a lot_number
            if tier_cfg.require_lot and tracking == TrackingType.BULK and not recv.lot_number:
                raise HTTPException(
                    status_code=422,
                    detail=(
                        f"Tier {part.tier} lot-tracked part '{part.name}' requires a "
                        f"lot_number when receiving."
                    ),
                )

            # Serial-issuing tiers: auto-generate serial numbers if not provided —
            # per physical unit, inside the record loop below
            auto_serial = (
                tier_cfg.auto_serial and tracking == TrackingType.SERIALIZED and not recv.lot_number
            )

        if part and part.tracking_type == TrackingType.SERIALIZED:
            # Serialized parts: create individual inventory records with unique OPAL numbers
            # Each physical unit gets its own OPAL for full traceability
            qty_to_create = int(recv.qty_received)
            for _ in range(qty_to_create):
                opal_number = generate_opal_number(db)
                inv_record = InventoryRecord(
                    part_id=line.part_id,
                    quantity=1,  # Individual unit
                    location=recv.location,
                    lot_number=generate_serial_number(db, part) if auto_serial else recv.lot_number,
                    opal_number=opal_number,
                    source_type=SourceType.PURCHASE,
                    source_purchase_line_id=line.id,
                )
                db.add(inv_record)
                db.flush()  # Ensure OPAL is committed before generating next
        else:
            # Bulk parts: one OPAL number for the entire received quantity
            opal_number = generate_opal_number(db)
            inv_record = InventoryRecord(
                part_id=line.part_id,
                quantity=recv.qty_received,
                location=recv.location,
                lot_number=recv.lot_number,
                opal_number=opal_number,
                source_type=SourceType.PURCHASE,
                source_purchase_line_id=line.id,
            )
            db.add(inv_record)
            db.flush()

        # Expense ledger: one immutable record per received line
        unit_cost = line.unit_cost
        expense = PurchaseExpense(
            purchase_id=purchase.id,
            purchase_line_id=line.id,
            part_id=line.part_id,
            quantity=recv.qty_received,
            unit_cost=unit_cost,
            total_cost=(unit_cost * recv.qty_received) if unit_cost is not None else None,
            tier=part.tier if part else None,
            received_at=datetime.now(UTC),
        )
        db.add(expense)
        db.flush()
        log_create(db, expense, user_id)

    # Update purchase status
    all_complete = all(line.is_complete for line in purchase.lines)
    any_received = any(line.qty_received > 0 for line in purchase.lines)

    if all_complete:
        purchase.status = PurchaseStatus.RECEIVED
        purchase.received_at = datetime.now(UTC)
    elif any_received:
        purchase.status = PurchaseStatus.PARTIAL

    db.commit()
    db.refresh(purchase)

    log_update(db, purchase, old_values, user_id)
    db.commit()

    return purchase_to_response(purchase)


@router.get("/{purchase_id}/expenses", response_model=list[PurchaseExpenseResponse])
async def list_purchase_expenses(
    db: DbSession,
    purchase_id: int,
) -> list[PurchaseExpenseResponse]:
    """List the expense ledger records written when this PO was received."""
    purchase = db.query(Purchase).filter(Purchase.id == purchase_id).first()
    if not purchase:
        raise HTTPException(
            status_code=status.HTTP_404_NOT_FOUND,
            detail=f"Purchase order {purchase_id} not found",
        )

    expenses = (
        db.query(PurchaseExpense)
        .filter(PurchaseExpense.purchase_id == purchase_id)
        .order_by(PurchaseExpense.received_at, PurchaseExpense.id)
        .all()
    )
    return [
        PurchaseExpenseResponse(
            id=e.id,
            purchase_id=e.purchase_id,
            purchase_line_id=e.purchase_line_id,
            part_id=e.part_id,
            part_name=e.part.name if e.part else None,
            quantity=e.quantity,
            unit_cost=e.unit_cost,
            total_cost=e.total_cost,
            tier=e.tier,
            received_at=e.received_at,
            notes=e.notes,
        )
        for e in expenses
    ]
