"""Datasets API routes."""

import csv
import io
import re
from datetime import UTC, datetime
from typing import Any

from fastapi import APIRouter, HTTPException, Query
from fastapi.responses import StreamingResponse
from pydantic import BaseModel, Field

from opal.api.deps import CurrentUserId, DbSession
from opal.core.audit import get_model_dict, log_create, log_delete, log_update
from opal.db.models.dataset import DataPoint, Dataset
from opal.db.models.execution import StepExecution

router = APIRouter(prefix="/datasets", tags=["datasets"])


# ============ Schemas ============


class DataPointSource(BaseModel):
    """The execution step that produced a data point."""

    instance_id: int
    work_order_number: str | None = None
    step_number_str: str
    step_title: str | None = None


class DataPointResponse(BaseModel):
    """Data point response."""

    id: int
    dataset_id: int
    recorded_at: datetime
    values: dict[str, Any]
    step_execution_id: int | None = None
    source: DataPointSource | None = None
    created_at: datetime

    model_config = {"from_attributes": True}


class DatasetResponse(BaseModel):
    """Dataset response."""

    id: int
    name: str
    description: str | None = None
    data_schema: dict[str, Any] = Field(serialization_alias="schema")
    procedure_id: int | None = None
    procedure_name: str | None = None
    point_count: int = 0
    created_at: datetime
    updated_at: datetime

    model_config = {"from_attributes": True, "populate_by_name": True}


class DatasetDetailResponse(DatasetResponse):
    """Dataset with data points."""

    data_points: list[DataPointResponse] = []


class DatasetListResponse(BaseModel):
    """Paginated dataset list."""

    items: list[DatasetResponse]
    total: int
    page: int
    page_size: int


class DatasetCreate(BaseModel):
    """Create dataset request."""

    name: str = Field(..., min_length=1, max_length=255)
    description: str | None = None
    data_schema: dict[str, Any] = Field(
        ..., alias="schema", description="Schema defining fields and types"
    )
    procedure_id: int | None = None

    model_config = {"populate_by_name": True}


class DatasetUpdate(BaseModel):
    """Update dataset request."""

    name: str | None = Field(None, min_length=1, max_length=255)
    description: str | None = None
    data_schema: dict[str, Any] | None = Field(None, alias="schema")
    procedure_id: int | None = None

    model_config = {"populate_by_name": True}


class DataPointCreate(BaseModel):
    """Create data point request."""

    recorded_at: datetime | None = None
    values: dict[str, Any]
    step_execution_id: int | None = None


class ChartDataResponse(BaseModel):
    """Chart.js compatible data response."""

    labels: list[str]
    datasets: list[dict[str, Any]]


# ============ Dataset CRUD ============


def _point_source(point: DataPoint) -> DataPointSource | None:
    """Resolve the execution step behind a point (WO number, step number and title)."""
    step = point.step_execution
    if step is None:
        return None
    title = step.title
    if title is None and step.instance is not None:
        for snap in step.instance.version.content.get("steps", []):
            if snap.get("order") == step.step_number:
                title = snap.get("title")
                break
    return DataPointSource(
        instance_id=step.instance_id,
        work_order_number=step.instance.work_order_number if step.instance else None,
        step_number_str=step.step_number_str,
        step_title=title,
    )


def _point_to_response(point: DataPoint) -> DataPointResponse:
    return DataPointResponse(
        id=point.id,
        dataset_id=point.dataset_id,
        recorded_at=point.recorded_at,
        values=point.values,
        step_execution_id=point.step_execution_id,
        source=_point_source(point),
        created_at=point.created_at,
    )


def _find_dataset(db: DbSession, dataset_id: int) -> Dataset:
    dataset = (
        db.query(Dataset).filter(Dataset.id == dataset_id, Dataset.deleted_at.is_(None)).first()
    )
    if not dataset:
        raise HTTPException(status_code=404, detail="Dataset not found")
    return dataset


def _validate_values(schema: dict[str, Any], values: dict[str, Any]) -> None:
    """Reject values that do not fit the schema (unknown field, non-numeric number)."""
    fields = {f["name"]: f for f in schema.get("fields", []) if "name" in f}
    if not fields:
        return
    for name, value in values.items():
        field = fields.get(name)
        if field is None:
            raise HTTPException(status_code=422, detail=f"Unknown field '{name}'")
        if value is None:
            continue
        kind = field.get("type")
        if kind == "number" and (isinstance(value, bool) or not isinstance(value, int | float)):
            raise HTTPException(status_code=422, detail=f"Field '{name}' must be a number")
        if kind == "boolean" and not isinstance(value, bool):
            raise HTTPException(status_code=422, detail=f"Field '{name}' must be true or false")


def _dataset_to_response(dataset: Dataset) -> DatasetResponse:
    """Convert Dataset model to response."""
    return DatasetResponse(
        id=dataset.id,
        name=dataset.name,
        description=dataset.description,
        data_schema=dataset.schema,
        procedure_id=dataset.procedure_id,
        procedure_name=dataset.procedure.name if dataset.procedure else None,
        point_count=len(dataset.data_points),
        created_at=dataset.created_at,
        updated_at=dataset.updated_at,
    )


@router.get("", response_model=DatasetListResponse)
def list_datasets(
    db: DbSession,
    search: str | None = Query(None),
    procedure_id: int | None = Query(None),
    page: int = Query(1, ge=1),
    page_size: int = Query(50, ge=1, le=100),
) -> DatasetListResponse:
    """List datasets with optional filters."""
    query = db.query(Dataset).filter(Dataset.deleted_at.is_(None))

    if search:
        search_term = f"%{search}%"
        query = query.filter(Dataset.name.ilike(search_term))

    if procedure_id:
        query = query.filter(Dataset.procedure_id == procedure_id)

    total = query.count()

    datasets = (
        query.order_by(Dataset.id.desc()).offset((page - 1) * page_size).limit(page_size).all()
    )

    return DatasetListResponse(
        items=[_dataset_to_response(d) for d in datasets],
        total=total,
        page=page,
        page_size=page_size,
    )


@router.post("", response_model=DatasetResponse, status_code=201)
def create_dataset(
    data: DatasetCreate,
    db: DbSession,
    user_id: CurrentUserId,
) -> DatasetResponse:
    """Create a new dataset."""
    dataset = Dataset(
        name=data.name,
        description=data.description,
        schema=data.data_schema,
        procedure_id=data.procedure_id,
    )
    db.add(dataset)
    db.flush()

    log_create(db, dataset, user_id)
    db.commit()
    db.refresh(dataset)

    return _dataset_to_response(dataset)


@router.get("/{dataset_id}", response_model=DatasetDetailResponse)
def get_dataset(
    dataset_id: int,
    db: DbSession,
    include_points: bool = Query(True),
    limit_points: int = Query(100, ge=1, le=1000),
) -> DatasetDetailResponse:
    """Get dataset by ID with optional data points."""
    dataset = _find_dataset(db, dataset_id)

    points = []
    if include_points:
        points = (
            db.query(DataPoint)
            .filter(DataPoint.dataset_id == dataset_id)
            .order_by(DataPoint.recorded_at.desc())
            .limit(limit_points)
            .all()
        )

    return DatasetDetailResponse(
        id=dataset.id,
        name=dataset.name,
        description=dataset.description,
        data_schema=dataset.schema,
        procedure_id=dataset.procedure_id,
        procedure_name=dataset.procedure.name if dataset.procedure else None,
        point_count=len(dataset.data_points),
        created_at=dataset.created_at,
        updated_at=dataset.updated_at,
        data_points=[_point_to_response(p) for p in points],
    )


@router.patch("/{dataset_id}", response_model=DatasetResponse)
def update_dataset(
    dataset_id: int,
    data: DatasetUpdate,
    db: DbSession,
    user_id: CurrentUserId,
) -> DatasetResponse:
    """Update a dataset."""
    dataset = _find_dataset(db, dataset_id)

    old_values = get_model_dict(dataset)

    # An explicit null clears the description or the procedure link.
    sent = data.model_fields_set
    if data.name is not None:
        dataset.name = data.name
    if "description" in sent:
        dataset.description = data.description or None
    if data.data_schema is not None:
        dataset.schema = data.data_schema
    if "procedure_id" in sent:
        dataset.procedure_id = data.procedure_id

    log_update(db, dataset, old_values, user_id)
    db.commit()
    db.refresh(dataset)

    return _dataset_to_response(dataset)


@router.delete("/{dataset_id}", status_code=204)
def delete_dataset(
    dataset_id: int,
    db: DbSession,
    user_id: CurrentUserId,
) -> None:
    """Soft delete a dataset."""
    dataset = _find_dataset(db, dataset_id)

    dataset.deleted_at = datetime.now(UTC)
    log_delete(db, dataset, user_id)
    db.commit()


# ============ Data Points ============


@router.post("/{dataset_id}/points", response_model=DataPointResponse, status_code=201)
def add_data_point(
    dataset_id: int,
    data: DataPointCreate,
    db: DbSession,
    user_id: CurrentUserId,
) -> DataPointResponse:
    """Add a data point to a dataset."""
    dataset = _find_dataset(db, dataset_id)

    _validate_values(dataset.schema, data.values)
    if data.step_execution_id is not None and not db.get(StepExecution, data.step_execution_id):
        raise HTTPException(status_code=422, detail="Step execution not found")

    recorded_at = data.recorded_at or datetime.now(UTC)

    point = DataPoint(
        dataset_id=dataset_id,
        recorded_at=recorded_at,
        values=data.values,
        step_execution_id=data.step_execution_id,
    )
    db.add(point)
    db.flush()
    log_create(db, point, user_id)
    db.commit()
    db.refresh(point)

    return _point_to_response(point)


@router.get("/{dataset_id}/points", response_model=list[DataPointResponse])
def list_data_points(
    dataset_id: int,
    db: DbSession,
    start_date: datetime | None = Query(None),
    end_date: datetime | None = Query(None),
    limit: int = Query(100, ge=1, le=1000),
    offset: int = Query(0, ge=0),
) -> list[DataPointResponse]:
    """List data points for a dataset."""
    _find_dataset(db, dataset_id)

    query = db.query(DataPoint).filter(DataPoint.dataset_id == dataset_id)

    if start_date:
        query = query.filter(DataPoint.recorded_at >= start_date)
    if end_date:
        query = query.filter(DataPoint.recorded_at <= end_date)

    points = query.order_by(DataPoint.recorded_at.asc()).offset(offset).limit(limit).all()

    return [_point_to_response(p) for p in points]


@router.delete("/{dataset_id}/points/{point_id}", status_code=204)
def delete_data_point(
    dataset_id: int,
    point_id: int,
    db: DbSession,
    user_id: CurrentUserId,
) -> None:
    """Delete a data point."""
    point = (
        db.query(DataPoint)
        .filter(DataPoint.id == point_id, DataPoint.dataset_id == dataset_id)
        .first()
    )
    if not point:
        raise HTTPException(status_code=404, detail="Data point not found")

    log_delete(db, point, user_id)
    db.delete(point)
    db.commit()


# ============ Chart Data ============


@router.get("/{dataset_id}/chart", response_model=ChartDataResponse)
def get_chart_data(
    dataset_id: int,
    db: DbSession,
    field: str = Query(..., description="Field name from schema to chart"),
    start_date: datetime | None = Query(None),
    end_date: datetime | None = Query(None),
    limit: int = Query(100, ge=1, le=1000),
) -> ChartDataResponse:
    """Get chart-ready data for a specific field.

    Returns data in Chart.js compatible format.
    """
    _find_dataset(db, dataset_id)

    query = db.query(DataPoint).filter(DataPoint.dataset_id == dataset_id)

    if start_date:
        query = query.filter(DataPoint.recorded_at >= start_date)
    if end_date:
        query = query.filter(DataPoint.recorded_at <= end_date)

    points = query.order_by(DataPoint.recorded_at.asc()).limit(limit).all()

    labels = []
    data_values = []

    for point in points:
        labels.append(point.recorded_at.strftime("%Y-%m-%d %H:%M"))
        value = point.values.get(field)
        if value is not None:
            try:
                data_values.append(float(value))
            except (TypeError, ValueError):
                data_values.append(None)
        else:
            data_values.append(None)

    return ChartDataResponse(
        labels=labels,
        datasets=[
            {
                "label": field,
                "data": data_values,
                "borderColor": "rgb(75, 192, 192)",
                "backgroundColor": "rgba(75, 192, 192, 0.2)",
                "tension": 0.1,
            }
        ],
    )


# ============ CSV Export ============

# Characters that make a spreadsheet treat a cell as a formula/command.
_CSV_FORMULA_LEADERS = ("=", "+", "-", "@", "\t", "\r")


def _csv_safe(value: object) -> str:
    """Neutralize spreadsheet formula injection (OWASP): prefix any cell that
    starts with a formula leader with a single quote so Excel/LibreOffice treat
    it as text. Data-point values are user-supplied, so an unescaped ``=…``
    would execute when another user opens the export."""
    text = "" if value is None else str(value)
    if text and text[0] in _CSV_FORMULA_LEADERS:
        return "'" + text
    return text


def _safe_filename(name: str) -> str:
    """ASCII-only, token-safe filename component for Content-Disposition — a
    raw name could contain a quote and inject extra header parameters."""
    cleaned = re.sub(r"[^A-Za-z0-9._-]", "_", name).strip("._")
    return cleaned[:100] or "dataset"


@router.get("/{dataset_id}/export")
def export_dataset_csv(
    dataset_id: int,
    db: DbSession,
) -> StreamingResponse:
    """Export dataset data points as CSV."""
    dataset = _find_dataset(db, dataset_id)

    points = (
        db.query(DataPoint)
        .filter(DataPoint.dataset_id == dataset_id)
        .order_by(DataPoint.recorded_at.asc())
        .all()
    )

    # ORM attribute is `schema` (the Pydantic layer aliases it to data_schema);
    # `dataset.data_schema` was a latent AttributeError that 500'd every export.
    field_names = [f["name"] for f in dataset.schema.get("fields", [])]

    output = io.StringIO()
    writer = csv.writer(output)
    writer.writerow([_csv_safe(c) for c in ["recorded_at", *field_names]])

    for point in points:
        row = [point.recorded_at.strftime("%Y-%m-%dT%H:%M:%S")]
        for fname in field_names:
            row.append(point.values.get(fname, ""))
        writer.writerow([_csv_safe(c) for c in row])

    output.seek(0)
    filename = f"dataset_{dataset_id}_{_safe_filename(dataset.name)}.csv"
    return StreamingResponse(
        iter([output.getvalue()]),
        media_type="text/csv",
        headers={"Content-Disposition": f'attachment; filename="{filename}"'},
    )
