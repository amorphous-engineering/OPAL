"""Purchase order management endpoints."""

import re
from datetime import UTC, date, datetime
from decimal import Decimal

from fastapi import APIRouter, HTTPException, Query, status
from pydantic import BaseModel, Field
from sqlalchemy import or_
from sqlalchemy.orm import Session, selectinload

from opal.api.deps import CurrentUserId, DbSession, PaginationParams
from opal.config import get_active_project
from opal.core.audit import get_model_dict, log_create, log_delete, log_update
from opal.core.designators import generate_serial_number
from opal.core.inventory import generate_opal_number
from opal.core.part_lifecycle import ensure_parts_active
from opal.db.models import InventoryRecord, Part, Purchase, PurchaseExpense, PurchaseLine, Supplier
from opal.db.models.inventory import SourceType
from opal.db.models.part import TrackingType
from opal.db.models.purchase import PurchaseStatus
from opal.project import tier_semantics

router = APIRouter()

# Statuses in which the order is still being worked (lines and header editable).
OPEN_STATUSES = (
    PurchaseStatus.DRAFT,
    PurchaseStatus.ORDERED,
    PurchaseStatus.PARTIAL,
    PurchaseStatus.ON_HOLD,
)

# Hand-driven status changes. RECEIVED and PARTIAL are never set by hand: they
# follow from receiving (and from editing quantities against what was received).
TRANSITIONS: dict[PurchaseStatus, set[PurchaseStatus]] = {
    PurchaseStatus.DRAFT: {PurchaseStatus.ORDERED, PurchaseStatus.CANCELLED},
    PurchaseStatus.ORDERED: {
        PurchaseStatus.DRAFT,
        PurchaseStatus.ON_HOLD,
        PurchaseStatus.CANCELLED,
    },
    PurchaseStatus.PARTIAL: {PurchaseStatus.ON_HOLD, PurchaseStatus.CANCELLED},
    PurchaseStatus.ON_HOLD: {PurchaseStatus.ORDERED, PurchaseStatus.CANCELLED},
    PurchaseStatus.RECEIVED: set(),
    PurchaseStatus.CANCELLED: set(),
}

# Non-line costs recorded against a PO. Stored as ledger rows with no part and
# no line; the kind leads the row's notes ("shipping" or "shipping: carrier").
CHARGE_KINDS = ("shipping", "tax", "duty", "fee", "other")


class PurchaseLineCreate(BaseModel):
    """Schema for creating a purchase line."""

    part_id: int
    qty_ordered: Decimal = Field(..., gt=0)
    unit_cost: Decimal | None = Field(None, ge=0)
    destination: str | None = Field(None, max_length=255)
    notes: str | None = None


class PurchaseLineUpdate(BaseModel):
    """Schema for updating a purchase line."""

    qty_ordered: Decimal | None = Field(None, gt=0)
    unit_cost: Decimal | None = Field(None, ge=0)
    destination: str | None = Field(None, max_length=255)
    notes: str | None = None


class PurchaseCreate(BaseModel):
    """Schema for creating a purchase order."""

    supplier: str | None = Field(None, max_length=255)
    supplier_id: int | None = None
    supplier_reference: str | None = Field(None, max_length=100)
    reference: str | None = Field(None, max_length=64)
    target_date: date | None = None
    destination: str | None = Field(None, max_length=255)
    notes: str | None = None
    lines: list[PurchaseLineCreate] = []


class PurchaseUpdate(BaseModel):
    """Schema for updating a purchase order."""

    supplier: str | None = Field(None, max_length=255)
    supplier_id: int | None = None
    supplier_reference: str | None = Field(None, max_length=100)
    reference: str | None = Field(None, max_length=64)
    target_date: date | None = None
    destination: str | None = Field(None, max_length=255)
    notes: str | None = None
    status: PurchaseStatus | None = None


class ReceiveLine(BaseModel):
    """Schema for receiving a line item."""

    line_id: int
    qty_received: Decimal
    location: str | None = None
    lot_number: str | None = None
    # Receiving more than is outstanding is refused unless the caller says the
    # supplier really shipped over (the receive form asks the user to confirm).
    allow_over_receipt: bool = False


class PurchaseExpenseResponse(BaseModel):
    """Expense ledger record: a receive event, or a non-line charge."""

    id: int
    purchase_id: int
    purchase_line_id: int | None = None
    part_id: int | None = None
    part_name: str | None = None
    part_internal_pn: str | None = None
    quantity: Decimal
    unit_cost: Decimal | None = None
    total_cost: Decimal | None = None
    tier: int | None = None
    received_at: datetime
    notes: str | None = None
    # shipping / tax / duty / fee / other for a charge; null for a receipt
    charge_kind: str | None = None

    model_config = {"from_attributes": True}


class ChargeCreate(BaseModel):
    """A non-line cost on a purchase order."""

    kind: str
    amount: Decimal = Field(..., ge=0)
    note: str | None = Field(None, max_length=500)


class ReceiveRequest(BaseModel):
    """Schema for receiving against a PO."""

    lines: list[ReceiveLine]


class PurchaseLineResponse(BaseModel):
    """Schema for purchase line response."""

    id: int
    part_id: int
    part_name: str
    part_internal_pn: str | None = None
    part_external_pn: str | None
    unit_of_measure: str = "ea"
    tracking_type: str = "bulk"
    # Receiving rules the part's tier imposes (drives the receive form)
    lot_required: bool = False
    auto_serial: bool = False
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
    supplier_id: int | None = None
    supplier_name: str | None
    supplier_reference: str | None = None
    status: PurchaseStatus
    target_date: str | None
    is_overdue: bool
    ordered_at: str | None
    received_at: str | None = None
    total_lines: int
    lines_complete: int = 0
    total_cost: Decimal | None
    created_at: str

    model_config = {"from_attributes": True}


class PurchaseListResponse(BaseModel):
    """Schema for purchase list response."""

    items: list[PurchaseListItem]
    total: int


class ReceivedRecord(BaseModel):
    """Inventory record created by receiving against a PO line."""

    inventory_id: int
    opal_number: str | None
    part_id: int
    part_name: str
    part_internal_pn: str | None
    quantity: Decimal
    location: str
    lot_number: str | None
    purchase_line_id: int | None
    created_at: str


def _line_cost(purchase: Purchase) -> Decimal | None:
    total = sum(
        (line.unit_cost * line.qty_ordered for line in purchase.lines if line.unit_cost),
        Decimal(0),
    )
    return total if total > 0 else None


def line_to_response(line: PurchaseLine) -> PurchaseLineResponse:
    """Convert purchase line to response."""
    part = line.part
    tier_cfg = tier_semantics(get_active_project(), part.tier)
    tracking = part.tracking_type
    return PurchaseLineResponse(
        id=line.id,
        part_id=line.part_id,
        part_name=part.name,
        part_internal_pn=part.internal_pn,
        part_external_pn=part.external_pn,
        unit_of_measure=part.unit_of_measure,
        tracking_type=str(getattr(tracking, "value", tracking)),
        lot_required=bool(tier_cfg.require_lot and tracking == TrackingType.BULK),
        auto_serial=bool(tier_cfg.auto_serial and tracking == TrackingType.SERIALIZED),
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
        total_cost=_line_cost(purchase),
        created_at=purchase.created_at.isoformat(),
        updated_at=purchase.updated_at.isoformat(),
        created_by_id=purchase.created_by_id,
        created_by_name=purchase.created_by.name if purchase.created_by else None,
        received_by_id=purchase.received_by_id,
        received_by_name=purchase.received_by.name if purchase.received_by else None,
    )


def purchase_to_list_item(purchase: Purchase) -> PurchaseListItem:
    """Convert purchase to list item."""
    return PurchaseListItem(
        id=purchase.id,
        reference=purchase.reference,
        supplier=purchase.supplier,
        supplier_id=purchase.supplier_id,
        supplier_name=purchase.supplier_rel.name if purchase.supplier_rel else None,
        supplier_reference=purchase.supplier_reference,
        status=purchase.status,
        target_date=purchase.target_date.isoformat() if purchase.target_date else None,
        is_overdue=purchase.is_overdue,
        ordered_at=purchase.ordered_at.isoformat() if purchase.ordered_at else None,
        received_at=purchase.received_at.isoformat() if purchase.received_at else None,
        total_lines=len(purchase.lines),
        lines_complete=sum(1 for line in purchase.lines if line.is_complete),
        total_cost=_line_cost(purchase),
        created_at=purchase.created_at.isoformat(),
    )


def _expense_response(e: PurchaseExpense) -> PurchaseExpenseResponse:
    kind = None
    if e.part_id is None and e.purchase_line_id is None and e.notes:
        head = e.notes.split(":", 1)[0].strip().lower()
        kind = head if head in CHARGE_KINDS else "other"
    return PurchaseExpenseResponse(
        id=e.id,
        purchase_id=e.purchase_id,
        purchase_line_id=e.purchase_line_id,
        part_id=e.part_id,
        part_name=e.part.name if e.part else None,
        part_internal_pn=e.part.internal_pn if e.part else None,
        quantity=e.quantity,
        unit_cost=e.unit_cost,
        total_cost=e.total_cost,
        tier=e.tier,
        received_at=e.received_at,
        notes=e.notes,
        charge_kind=kind,
    )


def _get_purchase(db: Session, purchase_id: int) -> Purchase:
    purchase = db.query(Purchase).filter(Purchase.id == purchase_id).first()
    if not purchase:
        raise HTTPException(
            status_code=status.HTTP_404_NOT_FOUND,
            detail=f"Purchase order {purchase_id} not found",
        )
    return purchase


def _get_line(db: Session, purchase_id: int, line_id: int) -> PurchaseLine:
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
    return line


def _require_open(purchase: Purchase, action: str) -> None:
    if purchase.status not in OPEN_STATUSES:
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail=f"Cannot {action} on a purchase in {purchase.status} status",
        )


def _next_reference(db: Session) -> str:
    """Next PO-NNNN reference (one past the highest numeric suffix in use)."""
    refs = db.query(Purchase.reference).filter(Purchase.reference.like("PO-%")).all()
    numbers = [
        int(m.group(1)) for (r,) in refs if r and (m := re.fullmatch(r"PO-(\d+)", r)) is not None
    ]
    return f"PO-{(max(numbers) if numbers else 0) + 1:04d}"


def _resolve_supplier(db: Session, supplier_id: int) -> Supplier:
    supplier = (
        db.query(Supplier).filter(Supplier.id == supplier_id, Supplier.deleted_at.is_(None)).first()
    )
    if not supplier:
        raise HTTPException(
            status_code=status.HTTP_404_NOT_FOUND,
            detail=f"Supplier {supplier_id} not found",
        )
    return supplier


def _settle_receipt_status(purchase: Purchase) -> None:
    """Derive ordered / partial / received from what has been received.

    On-hold, draft and terminal orders are left alone.
    """
    if purchase.status not in (PurchaseStatus.ORDERED, PurchaseStatus.PARTIAL):
        return
    if purchase.lines and all(line.is_complete for line in purchase.lines):
        purchase.status = PurchaseStatus.RECEIVED
        purchase.received_at = datetime.now(UTC)
    elif any(line.qty_received > 0 for line in purchase.lines):
        purchase.status = PurchaseStatus.PARTIAL
    else:
        purchase.status = PurchaseStatus.ORDERED


SORT_COLUMNS = {
    "reference": Purchase.reference,
    "supplier": Purchase.supplier,
    "status": Purchase.status,
    "target_date": Purchase.target_date,
    "ordered_at": Purchase.ordered_at,
    "created_at": Purchase.created_at,
}


@router.get("", response_model=PurchaseListResponse)
def list_purchases(
    db: DbSession,
    pagination: PaginationParams,
    status_filter: PurchaseStatus | None = Query(None, alias="status"),
    open_only: bool = Query(False, alias="open", description="Draft, ordered, partial, on hold"),
    overdue: bool = Query(False),
    supplier: str | None = Query(None, description="Supplier name contains"),
    supplier_id: int | None = Query(None),
    q: str | None = Query(None, description="Reference, supplier, or supplier reference"),
    target_from: date | None = Query(None),
    target_to: date | None = Query(None),
    sort: str = Query("created_at"),
    dir: str = Query("desc", pattern="^(asc|desc)$"),
) -> PurchaseListResponse:
    """List purchase orders with optional filtering."""
    if sort not in SORT_COLUMNS:
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail=f"Unknown sort '{sort}' (expected one of {', '.join(SORT_COLUMNS)})",
        )
    query = db.query(Purchase)

    if status_filter:
        query = query.filter(Purchase.status == status_filter)
    if open_only:
        query = query.filter(Purchase.status.in_([s.value for s in OPEN_STATUSES]))
    if overdue:
        query = query.filter(
            Purchase.target_date < date.today(),
            Purchase.status.notin_([PurchaseStatus.RECEIVED.value, PurchaseStatus.CANCELLED.value]),
        )
    if supplier_id is not None:
        query = query.filter(Purchase.supplier_id == supplier_id)
    if supplier:
        query = query.filter(Purchase.supplier.ilike(f"%{supplier}%"))
    if q:
        term = f"%{q}%"
        query = query.filter(
            or_(
                Purchase.reference.ilike(term),
                Purchase.supplier.ilike(term),
                Purchase.supplier_reference.ilike(term),
            )
        )
    if target_from:
        query = query.filter(Purchase.target_date >= target_from)
    if target_to:
        query = query.filter(Purchase.target_date <= target_to)

    total = query.count()
    column = SORT_COLUMNS[sort]
    ordering = column.asc() if dir == "asc" else column.desc()
    purchases = (
        query.options(selectinload(Purchase.lines))
        .order_by(ordering, Purchase.id.desc())
        .offset(pagination.skip)
        .limit(pagination.limit)
        .all()
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
    """Create a new purchase order (always as a draft)."""
    supplier_name = (po_in.supplier or "").strip()
    if po_in.supplier_id:
        supplier = _resolve_supplier(db, po_in.supplier_id)
        supplier_name = supplier_name or supplier.name
    if not supplier_name:
        raise HTTPException(
            status_code=status.HTTP_422_UNPROCESSABLE_ENTITY,
            detail="supplier: choose a supplier or enter a supplier name",
        )

    reference = (po_in.reference or "").strip() or None
    if reference:
        existing = db.query(Purchase).filter(Purchase.reference == reference).first()
        if existing:
            raise HTTPException(
                status_code=status.HTTP_409_CONFLICT,
                detail=f"PO with reference '{reference}' already exists",
            )
    else:
        reference = _next_reference(db)

    # A PO line is a financial commitment — draft parts block it; activation
    # never happens as a side effect (raises DraftPartsBlocked -> 409)
    ensure_parts_active(
        db,
        [line_in.part_id for line_in in po_in.lines],
        f"PO {reference} line add",
    )

    purchase = Purchase(
        supplier=supplier_name,
        supplier_id=po_in.supplier_id,
        supplier_reference=po_in.supplier_reference,
        reference=reference,
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
    return purchase_to_response(_get_purchase(db, purchase_id))


@router.patch("/{purchase_id}", response_model=PurchaseResponse)
def update_purchase(
    db: DbSession,
    purchase_id: int,
    po_in: PurchaseUpdate,
    user_id: CurrentUserId,
) -> PurchaseResponse:
    """Update a purchase order's header or move it through its lifecycle."""
    purchase = _get_purchase(db, purchase_id)
    old_values = get_model_dict(purchase)
    update_data = po_in.model_dump(exclude_unset=True)

    # A closed order keeps its record; only the notes stay editable
    if purchase.status not in OPEN_STATUSES and set(update_data) - {"notes", "status"}:
        raise HTTPException(
            status_code=status.HTTP_409_CONFLICT,
            detail=f"A {purchase.status} purchase order can only have its notes edited",
        )

    if "supplier" in update_data and update_data["supplier"] is None:
        update_data.pop("supplier")
    if "reference" in update_data:
        ref = (update_data["reference"] or "").strip() or None
        if ref is None or ref == purchase.reference:
            update_data.pop("reference")
        else:
            clash = db.query(Purchase).filter(Purchase.reference == ref).first()
            if clash:
                raise HTTPException(
                    status_code=status.HTTP_409_CONFLICT,
                    detail=f"PO with reference '{ref}' already exists",
                )
            update_data["reference"] = ref

    if update_data.get("supplier_id"):
        supplier = _resolve_supplier(db, update_data["supplier_id"])
        # Re-pointing at a registered supplier brings its name along
        if "supplier" not in update_data:
            update_data["supplier"] = supplier.name

    if "status" in update_data:
        new_status = update_data.pop("status")
        if new_status is not None and new_status != purchase.status:
            if new_status not in TRANSITIONS[purchase.status]:
                raise HTTPException(
                    status_code=status.HTTP_409_CONFLICT,
                    detail=f"Cannot move a purchase from {purchase.status} to {new_status}",
                )
            if new_status == PurchaseStatus.ORDERED and purchase.status == PurchaseStatus.DRAFT:
                if not purchase.lines:
                    raise HTTPException(
                        status_code=status.HTTP_400_BAD_REQUEST,
                        detail="Add at least one line before placing the order",
                    )
                purchase.ordered_at = datetime.now(UTC)
            elif new_status == PurchaseStatus.DRAFT:
                purchase.ordered_at = None
            purchase.status = new_status
            if new_status == PurchaseStatus.ORDERED and any(
                line.qty_received > 0 for line in purchase.lines
            ):
                # Resuming a held order that already took deliveries
                purchase.status = PurchaseStatus.PARTIAL

    for field, value in update_data.items():
        setattr(purchase, field, value)

    db.flush()
    log_update(db, purchase, old_values, user_id)
    db.commit()
    db.refresh(purchase)

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
    purchase = _get_purchase(db, purchase_id)
    _require_open(purchase, "add lines")

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
        destination=line_in.destination,
        notes=line_in.notes,
    )
    db.add(line)
    db.flush()
    log_create(db, line, user_id)
    db.refresh(purchase)
    _settle_receipt_status(purchase)
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
    purchase = _get_purchase(db, purchase_id)
    _require_open(purchase, "edit lines")
    line = _get_line(db, purchase_id, line_id)

    update_data = line_in.model_dump(exclude_unset=True)
    if "qty_ordered" in update_data and update_data["qty_ordered"] is None:
        update_data.pop("qty_ordered")
    new_qty = update_data.get("qty_ordered")
    if new_qty is not None and new_qty < line.qty_received:
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail=f"Quantity cannot be below the {line.qty_received} already received",
        )
    if (
        "unit_cost" in update_data
        and update_data["unit_cost"] != line.unit_cost
        and line.qty_received > 0
    ):
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail="Unit cost is locked once the line has been received (expense records exist)",
        )

    old_values = get_model_dict(line)
    for field, value in update_data.items():
        setattr(line, field, value)

    db.flush()
    log_update(db, line, old_values, user_id)
    db.refresh(purchase)
    _settle_receipt_status(purchase)
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
    purchase = _get_purchase(db, purchase_id)
    _require_open(purchase, "remove lines")
    line = _get_line(db, purchase_id, line_id)

    if line.qty_received > 0:
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail="Cannot delete line that has been partially received",
        )

    log_delete(db, line, user_id)
    db.delete(line)
    db.flush()
    db.refresh(purchase)
    _settle_receipt_status(purchase)
    db.commit()


@router.post("/{purchase_id}/receive", response_model=PurchaseResponse)
def receive_purchase(
    db: DbSession,
    purchase_id: int,
    receive_in: ReceiveRequest,
    user_id: CurrentUserId,
) -> PurchaseResponse:
    """Receive items against a purchase order."""
    purchase = _get_purchase(db, purchase_id)

    if purchase.status not in (PurchaseStatus.ORDERED, PurchaseStatus.PARTIAL):
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail=f"Cannot receive against purchase in {purchase.status} status",
        )
    if not receive_in.lines:
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail="Enter a quantity for at least one line",
        )

    old_values = get_model_dict(purchase)
    seen: set[int] = set()

    for recv in receive_in.lines:
        line = _get_line(db, purchase_id, recv.line_id)
        if recv.line_id in seen:
            raise HTTPException(
                status_code=status.HTTP_400_BAD_REQUEST,
                detail="A line can appear only once per receipt",
            )
        seen.add(recv.line_id)

        if recv.qty_received <= 0:
            raise HTTPException(
                status_code=status.HTTP_400_BAD_REQUEST,
                detail="Received quantity must be positive",
            )
        outstanding = line.qty_ordered - line.qty_received
        if recv.qty_received > outstanding and not recv.allow_over_receipt:
            raise HTTPException(
                status_code=status.HTTP_409_CONFLICT,
                detail=(
                    f"{line.part.name}: receiving {float(recv.qty_received):g} exceeds the "
                    f"{float(max(outstanding, 0)):g} outstanding; confirm the over-receipt to proceed"
                ),
            )
        location = (recv.location or "").strip() or line.destination or purchase.destination
        if not location:
            raise HTTPException(
                status_code=status.HTTP_422_UNPROCESSABLE_ENTITY,
                detail=f"{line.part.name}: a location is required to receive this line",
            )

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

            if tracking == TrackingType.SERIALIZED and recv.qty_received != int(recv.qty_received):
                raise HTTPException(
                    status_code=status.HTTP_400_BAD_REQUEST,
                    detail=f"{part.name} is serialized: receive whole units",
                )

        # Update line received quantity
        line.qty_received += recv.qty_received

        if part and part.tracking_type == TrackingType.SERIALIZED:
            # Serialized parts: create individual inventory records with unique OPAL numbers
            # Each physical unit gets its own OPAL for full traceability
            qty_to_create = int(recv.qty_received)
            for _ in range(qty_to_create):
                opal_number = generate_opal_number(db)
                inv_record = InventoryRecord(
                    part_id=line.part_id,
                    quantity=1,  # Individual unit
                    location=location,
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
                location=location,
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
    _settle_receipt_status(purchase)
    if purchase.status == PurchaseStatus.RECEIVED:
        purchase.received_by_id = user_id

    db.flush()
    log_update(db, purchase, old_values, user_id)
    db.commit()
    db.refresh(purchase)

    return purchase_to_response(purchase)


@router.get("/{purchase_id}/inventory", response_model=list[ReceivedRecord])
def list_received_inventory(db: DbSession, purchase_id: int) -> list[ReceivedRecord]:
    """Inventory records created by receiving against this purchase order."""
    _get_purchase(db, purchase_id)
    records = (
        db.query(InventoryRecord)
        .join(PurchaseLine, InventoryRecord.source_purchase_line_id == PurchaseLine.id)
        .filter(PurchaseLine.purchase_id == purchase_id)
        .order_by(InventoryRecord.id)
        .all()
    )
    return [
        ReceivedRecord(
            inventory_id=r.id,
            opal_number=r.opal_number,
            part_id=r.part_id,
            part_name=r.part.name,
            part_internal_pn=r.part.internal_pn,
            quantity=r.quantity,
            location=r.location,
            lot_number=r.lot_number,
            purchase_line_id=r.source_purchase_line_id,
            created_at=r.created_at.isoformat(),
        )
        for r in records
    ]


@router.get("/{purchase_id}/expenses", response_model=list[PurchaseExpenseResponse])
def list_purchase_expenses(
    db: DbSession,
    purchase_id: int,
) -> list[PurchaseExpenseResponse]:
    """List the expense ledger: receive events and non-line charges."""
    _get_purchase(db, purchase_id)
    expenses = (
        db.query(PurchaseExpense)
        .filter(PurchaseExpense.purchase_id == purchase_id)
        .order_by(PurchaseExpense.received_at, PurchaseExpense.id)
        .all()
    )
    return [_expense_response(e) for e in expenses]


@router.post(
    "/{purchase_id}/expenses",
    response_model=PurchaseExpenseResponse,
    status_code=status.HTTP_201_CREATED,
)
def add_purchase_charge(
    db: DbSession,
    purchase_id: int,
    charge_in: ChargeCreate,
    user_id: CurrentUserId,
) -> PurchaseExpenseResponse:
    """Record a non-line cost (shipping, tax, duty, fee) against a purchase order."""
    purchase = _get_purchase(db, purchase_id)
    if purchase.status == PurchaseStatus.CANCELLED:
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail="Cannot add charges to a cancelled purchase",
        )
    kind = charge_in.kind.strip().lower()
    if kind not in CHARGE_KINDS:
        raise HTTPException(
            status_code=status.HTTP_422_UNPROCESSABLE_ENTITY,
            detail=f"kind: expected one of {', '.join(CHARGE_KINDS)}",
        )
    note = (charge_in.note or "").strip()
    expense = PurchaseExpense(
        purchase_id=purchase_id,
        quantity=Decimal(1),
        unit_cost=charge_in.amount,
        total_cost=charge_in.amount,
        received_at=datetime.now(UTC),
        notes=f"{kind}: {note}" if note else kind,
    )
    db.add(expense)
    db.flush()
    log_create(db, expense, user_id)
    db.commit()
    db.refresh(expense)
    return _expense_response(expense)


@router.delete("/{purchase_id}/expenses/{expense_id}", status_code=status.HTTP_204_NO_CONTENT)
def delete_purchase_charge(
    db: DbSession,
    purchase_id: int,
    expense_id: int,
    user_id: CurrentUserId,
) -> None:
    """Remove a non-line charge. Receive records are immutable and cannot be removed."""
    _get_purchase(db, purchase_id)
    expense = (
        db.query(PurchaseExpense)
        .filter(PurchaseExpense.id == expense_id, PurchaseExpense.purchase_id == purchase_id)
        .first()
    )
    if not expense:
        raise HTTPException(
            status_code=status.HTTP_404_NOT_FOUND, detail=f"Expense {expense_id} not found"
        )
    if expense.part_id is not None or expense.purchase_line_id is not None:
        raise HTTPException(
            status_code=status.HTTP_409_CONFLICT,
            detail="Receive records are immutable; only charges can be removed",
        )
    log_delete(db, expense, user_id)
    db.delete(expense)
    db.commit()
