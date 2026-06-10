"""Supplier API routes."""

from datetime import UTC, datetime

from fastapi import APIRouter, HTTPException, Query, status
from pydantic import BaseModel, Field
from sqlalchemy import func, select
from sqlalchemy.exc import IntegrityError

from opal.api.deps import CurrentUserId, DbSession
from opal.core.audit import get_model_dict, log_create, log_delete, log_update
from opal.db.models import Part, Supplier, SupplierPart

router = APIRouter(prefix="/suppliers", tags=["suppliers"])


# --- Schemas ---


class SupplierCreate(BaseModel):
    """Schema for creating a supplier."""

    name: str = Field(..., min_length=1, max_length=255)
    code: str | None = Field(None, max_length=50)
    description: str | None = None
    website: str | None = Field(None, max_length=255)
    email: str | None = Field(None, max_length=255)
    phone: str | None = Field(None, max_length=50)
    address: str | None = None
    notes: str | None = None
    is_active: bool = True


class SupplierUpdate(BaseModel):
    """Schema for updating a supplier."""

    name: str | None = Field(None, min_length=1, max_length=255)
    code: str | None = Field(None, max_length=50)
    description: str | None = None
    website: str | None = Field(None, max_length=255)
    email: str | None = Field(None, max_length=255)
    phone: str | None = Field(None, max_length=50)
    address: str | None = None
    notes: str | None = None
    is_active: bool | None = None


class SupplierResponse(BaseModel):
    """Schema for supplier responses."""

    id: int
    name: str
    code: str | None
    description: str | None
    website: str | None
    email: str | None
    phone: str | None
    address: str | None
    notes: str | None
    is_active: bool
    purchase_count: int = 0

    model_config = {"from_attributes": True}


class SupplierListResponse(BaseModel):
    """Schema for paginated supplier list."""

    items: list[SupplierResponse]
    total: int
    page: int
    per_page: int


class SupplierPartCreate(BaseModel):
    """Schema for creating a supplier-part catalog entry."""

    part_id: int
    vendor_pn: str = Field(..., min_length=1, max_length=255)
    is_preferred: bool = False
    notes: str | None = None


class SupplierPartUpdate(BaseModel):
    """Schema for updating a supplier-part catalog entry."""

    vendor_pn: str | None = Field(None, min_length=1, max_length=255)
    is_preferred: bool | None = None
    notes: str | None = None


class SupplierPartResponse(BaseModel):
    """Schema for supplier-part catalog entry responses."""

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


def _supplier_part_response(sp: SupplierPart) -> SupplierPartResponse:
    """Build a SupplierPartResponse from a SupplierPart ORM object."""
    return SupplierPartResponse(
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


def _get_active_supplier(db: DbSession, supplier_id: int) -> Supplier:
    supplier = db.execute(
        select(Supplier).where(Supplier.id == supplier_id, Supplier.deleted_at.is_(None))
    ).scalar_one_or_none()
    if not supplier:
        raise HTTPException(
            status_code=status.HTTP_404_NOT_FOUND,
            detail=f"Supplier {supplier_id} not found",
        )
    return supplier


# --- Supplier CRUD Routes ---


@router.get("", response_model=SupplierListResponse)
def list_suppliers(
    db: DbSession,
    page: int = Query(1, ge=1),
    per_page: int = Query(50, ge=1, le=100),
    search: str | None = None,
    is_active: bool | None = None,
):
    """List all suppliers with pagination and filtering."""
    query = select(Supplier).where(Supplier.deleted_at.is_(None))

    if search:
        search_filter = f"%{search}%"
        query = query.where(
            (Supplier.name.ilike(search_filter))
            | (Supplier.code.ilike(search_filter))
            | (Supplier.email.ilike(search_filter))
        )

    if is_active is not None:
        query = query.where(Supplier.is_active == is_active)

    # Get total count
    count_query = select(func.count()).select_from(query.subquery())
    total = db.execute(count_query).scalar() or 0

    # Get paginated results
    offset = (page - 1) * per_page
    query = query.order_by(Supplier.name).offset(offset).limit(per_page)
    suppliers = db.execute(query).scalars().all()

    # Build response with purchase counts
    items = []
    for s in suppliers:
        items.append(
            SupplierResponse(
                id=s.id,
                name=s.name,
                code=s.code,
                description=s.description,
                website=s.website,
                email=s.email,
                phone=s.phone,
                address=s.address,
                notes=s.notes,
                is_active=s.is_active,
                purchase_count=len(s.purchases) if s.purchases else 0,
            )
        )

    return SupplierListResponse(
        items=items,
        total=total,
        page=page,
        per_page=per_page,
    )


@router.post("", response_model=SupplierResponse, status_code=status.HTTP_201_CREATED)
def create_supplier(
    db: DbSession,
    data: SupplierCreate,
    user_id: CurrentUserId,
):
    """Create a new supplier."""
    # Check for duplicate code
    if data.code:
        existing = db.execute(
            select(Supplier).where(Supplier.code == data.code, Supplier.deleted_at.is_(None))
        ).scalar_one_or_none()
        if existing:
            raise HTTPException(
                status_code=status.HTTP_409_CONFLICT,
                detail=f"Supplier with code '{data.code}' already exists",
            )

    supplier = Supplier(**data.model_dump())
    db.add(supplier)
    db.flush()

    log_create(db, supplier, user_id)
    db.commit()
    db.refresh(supplier)

    return SupplierResponse(
        id=supplier.id,
        name=supplier.name,
        code=supplier.code,
        description=supplier.description,
        website=supplier.website,
        email=supplier.email,
        phone=supplier.phone,
        address=supplier.address,
        notes=supplier.notes,
        is_active=supplier.is_active,
        purchase_count=0,
    )


@router.get("/{supplier_id}", response_model=SupplierResponse)
def get_supplier(
    db: DbSession,
    supplier_id: int,
):
    """Get a supplier by ID."""
    supplier = _get_active_supplier(db, supplier_id)

    return SupplierResponse(
        id=supplier.id,
        name=supplier.name,
        code=supplier.code,
        description=supplier.description,
        website=supplier.website,
        email=supplier.email,
        phone=supplier.phone,
        address=supplier.address,
        notes=supplier.notes,
        is_active=supplier.is_active,
        purchase_count=len(supplier.purchases) if supplier.purchases else 0,
    )


@router.patch("/{supplier_id}", response_model=SupplierResponse)
def update_supplier(
    db: DbSession,
    supplier_id: int,
    data: SupplierUpdate,
    user_id: CurrentUserId,
):
    """Update a supplier."""
    supplier = _get_active_supplier(db, supplier_id)

    # Check for duplicate code if changing
    if data.code and data.code != supplier.code:
        existing = db.execute(
            select(Supplier).where(
                Supplier.code == data.code,
                Supplier.id != supplier_id,
                Supplier.deleted_at.is_(None),
            )
        ).scalar_one_or_none()
        if existing:
            raise HTTPException(
                status_code=status.HTTP_409_CONFLICT,
                detail=f"Supplier with code '{data.code}' already exists",
            )

    old_data = get_model_dict(supplier)

    update_data = data.model_dump(exclude_unset=True)
    for key, value in update_data.items():
        setattr(supplier, key, value)

    db.flush()
    log_update(db, supplier, old_data, user_id)
    db.commit()
    db.refresh(supplier)

    return SupplierResponse(
        id=supplier.id,
        name=supplier.name,
        code=supplier.code,
        description=supplier.description,
        website=supplier.website,
        email=supplier.email,
        phone=supplier.phone,
        address=supplier.address,
        notes=supplier.notes,
        is_active=supplier.is_active,
        purchase_count=len(supplier.purchases) if supplier.purchases else 0,
    )


@router.delete("/{supplier_id}", status_code=status.HTTP_204_NO_CONTENT)
def delete_supplier(
    db: DbSession,
    supplier_id: int,
    user_id: CurrentUserId,
):
    """Soft-delete a supplier."""
    supplier = _get_active_supplier(db, supplier_id)

    # Check if supplier has any purchases
    if supplier.purchases:
        raise HTTPException(
            status_code=status.HTTP_409_CONFLICT,
            detail="Cannot delete supplier with existing purchase orders. Deactivate instead.",
        )

    old_data = get_model_dict(supplier)
    supplier.deleted_at = datetime.now(UTC)
    db.flush()
    log_update(db, supplier, old_data, user_id)
    db.commit()


# --- Supplier-Part Catalog Sub-Resource Routes ---


@router.get("/{supplier_id}/parts", response_model=list[SupplierPartResponse])
async def list_supplier_parts(
    db: DbSession,
    supplier_id: int,
):
    """List all catalog entries (vendor PNs) for a supplier."""
    _get_active_supplier(db, supplier_id)

    entries = (
        db.execute(
            select(SupplierPart)
            .join(Part, SupplierPart.part_id == Part.id)
            .where(SupplierPart.supplier_id == supplier_id, Part.deleted_at.is_(None))
            .order_by(SupplierPart.is_preferred.desc(), SupplierPart.id)
        )
        .scalars()
        .all()
    )
    return [_supplier_part_response(sp) for sp in entries]


@router.post(
    "/{supplier_id}/parts",
    response_model=SupplierPartResponse,
    status_code=status.HTTP_201_CREATED,
)
async def create_supplier_part(
    db: DbSession,
    supplier_id: int,
    data: SupplierPartCreate,
    user_id: CurrentUserId,
):
    """Add a vendor PN / catalog entry linking a supplier to a part."""
    _get_active_supplier(db, supplier_id)

    # Validate that the part exists and is not deleted
    part = db.execute(
        select(Part).where(Part.id == data.part_id, Part.deleted_at.is_(None))
    ).scalar_one_or_none()
    if not part:
        raise HTTPException(
            status_code=status.HTTP_422_UNPROCESSABLE_ENTITY,
            detail=f"Part {data.part_id} not found",
        )

    sp = SupplierPart(
        supplier_id=supplier_id,
        part_id=data.part_id,
        vendor_pn=data.vendor_pn,
        is_preferred=data.is_preferred,
        notes=data.notes,
    )
    db.add(sp)
    try:
        db.flush()
    except IntegrityError as exc:
        db.rollback()
        raise HTTPException(
            status_code=status.HTTP_409_CONFLICT,
            detail=f"A catalog entry for supplier {supplier_id} and part {data.part_id} already exists",
        ) from exc

    log_create(db, sp, user_id)
    db.commit()
    db.refresh(sp)
    return _supplier_part_response(sp)


@router.put(
    "/{supplier_id}/parts/{entry_id}",
    response_model=SupplierPartResponse,
)
async def update_supplier_part(
    db: DbSession,
    supplier_id: int,
    entry_id: int,
    data: SupplierPartUpdate,
    user_id: CurrentUserId,
):
    """Update vendor PN, preferred flag, or notes on a catalog entry."""
    _get_active_supplier(db, supplier_id)

    sp = db.execute(
        select(SupplierPart).where(
            SupplierPart.id == entry_id, SupplierPart.supplier_id == supplier_id
        )
    ).scalar_one_or_none()
    if not sp:
        raise HTTPException(
            status_code=status.HTTP_404_NOT_FOUND,
            detail=f"Catalog entry {entry_id} not found for supplier {supplier_id}",
        )

    old_data = get_model_dict(sp)
    update_data = data.model_dump(exclude_unset=True)
    for key, value in update_data.items():
        setattr(sp, key, value)

    db.flush()
    log_update(db, sp, old_data, user_id)
    db.commit()
    db.refresh(sp)
    return _supplier_part_response(sp)


@router.delete("/{supplier_id}/parts/{entry_id}", status_code=status.HTTP_204_NO_CONTENT)
async def delete_supplier_part(
    db: DbSession,
    supplier_id: int,
    entry_id: int,
    user_id: CurrentUserId,
):
    """Remove a catalog entry linking a supplier to a part."""
    _get_active_supplier(db, supplier_id)

    sp = db.execute(
        select(SupplierPart).where(
            SupplierPart.id == entry_id, SupplierPart.supplier_id == supplier_id
        )
    ).scalar_one_or_none()
    if not sp:
        raise HTTPException(
            status_code=status.HTTP_404_NOT_FOUND,
            detail=f"Catalog entry {entry_id} not found for supplier {supplier_id}",
        )

    log_delete(db, sp, user_id)
    db.delete(sp)
    db.commit()
