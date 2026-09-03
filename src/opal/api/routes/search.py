"""Global search endpoint.

Uses the FTS5 index tables (see opal.db.fts) when present, which makes each
per-entity lookup an index search instead of a LIKE full-table scan. Falls
back to ILIKE for queries shorter than three characters (below the trigram
tokenizer minimum) and for databases created without FTS5 support.
"""

from collections.abc import Callable
from dataclasses import dataclass
from typing import Any

from fastapi import APIRouter, Query
from pydantic import BaseModel
from sqlalchemy import literal_column, or_
from sqlalchemy.orm import Session

from opal.api.deps import DbSession
from opal.db.base import LifecycleState
from opal.db.fts import ENTITY_SPECS, FtsEntity, fts_ready, fts_table
from opal.db.models import Part, Supplier
from opal.db.models.dataset import Dataset
from opal.db.models.execution import ProcedureInstance
from opal.db.models.issue import Issue
from opal.db.models.procedure import MasterProcedure
from opal.db.models.purchase import Purchase
from opal.db.models.requirement import Requirement
from opal.db.models.risk import Risk
from opal.db.models.workcenter import Workcenter

router = APIRouter(prefix="/search", tags=["search"])


class SearchResult(BaseModel):
    """A single search result."""

    entity_type: str
    id: int
    label: str
    sublabel: str | None = None
    url: str
    status: str | None = None


def _status_value(value: Any) -> str | None:
    if value is None:
        return None
    return value.value if hasattr(value, "value") else value


def _part_result(p: Part) -> SearchResult:
    return SearchResult(
        entity_type="part",
        id=p.id,
        label=p.name,
        sublabel=p.internal_pn or p.external_pn,
        url=f"/parts/{p.id}",
    )


def _issue_result(i: Issue) -> SearchResult:
    return SearchResult(
        entity_type="issue",
        id=i.id,
        label=i.title,
        sublabel=f"#{i.id}",
        url=f"/issues/{i.id}",
        status=_status_value(i.status),
    )


def _procedure_result(p: MasterProcedure) -> SearchResult:
    return SearchResult(
        entity_type="procedure",
        id=p.id,
        label=p.name,
        sublabel=f"#{p.id}",
        url=f"/procedures/{p.id}",
        status=_status_value(p.status),
    )


def _execution_result(inst: ProcedureInstance) -> SearchResult:
    # The work order number is the execution's name; a database id never
    # renders (F12). WO-less cuts fall back to procedure name + cut date.
    procedure_name = inst.procedure.name if inst.procedure else None
    if inst.work_order_number:
        label = inst.work_order_number
        sublabel = procedure_name
    else:
        cut = inst.created_at.date().isoformat() if inst.created_at else None
        label = (
            f"{procedure_name or 'Execution'} (cut {cut})"
            if cut
            else (procedure_name or "Execution")
        )
        sublabel = None
    return SearchResult(
        entity_type="execution",
        id=inst.id,
        label=label,
        sublabel=sublabel,
        url=f"/executions/{inst.id}",
        status=_status_value(inst.status),
    )


def _risk_result(r: Risk) -> SearchResult:
    return SearchResult(
        entity_type="risk",
        id=r.id,
        label=r.title,
        sublabel=r.risk_number,
        url=f"/risks/{r.id}",
        status=_status_value(r.disposition),
    )


def _supplier_result(s: Supplier) -> SearchResult:
    return SearchResult(
        entity_type="supplier",
        id=s.id,
        label=s.name,
        sublabel=s.code,
        url=f"/suppliers/{s.id}",
    )


def _purchase_result(po: Purchase) -> SearchResult:
    return SearchResult(
        entity_type="purchase",
        id=po.id,
        label=f"PO-{po.id}",
        sublabel=po.reference,
        url=f"/purchases/{po.id}",
        status=_status_value(po.status),
    )


def _dataset_result(d: Dataset) -> SearchResult:
    return SearchResult(
        entity_type="dataset",
        id=d.id,
        label=d.name,
        sublabel=f"#{d.id}",
        url=f"/datasets/{d.id}",
    )


def _workcenter_result(w: Workcenter) -> SearchResult:
    return SearchResult(
        entity_type="workcenter",
        id=w.id,
        label=w.name,
        sublabel=w.code,
        url=f"/workcenters/{w.id}",
    )


def _requirement_result(req: Requirement) -> SearchResult:
    return SearchResult(
        entity_type="requirement",
        id=req.id,
        label=f"{req.req_number} — {req.title}",
        sublabel=f"rev {req.revision}",
        url=f"/requirements/{req.id}",
        status=req.lifecycle_state,
    )


@dataclass(frozen=True)
class _Searchable:
    """How to search and render one entity type."""

    entity_type: str
    model: type
    build: Callable[[Any], SearchResult]
    soft_delete: bool
    ilike_columns: tuple
    order_desc: bool = True  # ILIKE path order: id desc (True) or first column asc (False)
    filters: tuple = ()  # extra filter clauses applied on both search paths


_SEARCHABLES: tuple[_Searchable, ...] = (
    _Searchable(
        "part",
        Part,
        _part_result,
        True,
        (Part.name, Part.internal_pn, Part.external_pn, Part.description),
    ),
    _Searchable("issue", Issue, _issue_result, True, (Issue.title, Issue.description)),
    _Searchable("procedure", MasterProcedure, _procedure_result, True, (MasterProcedure.name,)),
    _Searchable(
        "execution",
        ProcedureInstance,
        _execution_result,
        False,
        (ProcedureInstance.work_order_number,),
    ),
    _Searchable("risk", Risk, _risk_result, True, (Risk.title, Risk.description)),
    _Searchable(
        "requirement",
        Requirement,
        _requirement_result,
        True,
        (Requirement.req_number, Requirement.title, Requirement.statement),
        False,
        # Superseded revisions stay searchable only through their successor
        (Requirement.lifecycle_state != LifecycleState.SUPERSEDED.value,),
    ),
    _Searchable(
        "supplier", Supplier, _supplier_result, True, (Supplier.name, Supplier.code), False
    ),
    _Searchable(
        "purchase", Purchase, _purchase_result, False, (Purchase.reference, Purchase.notes)
    ),
    _Searchable("dataset", Dataset, _dataset_result, True, (Dataset.name,)),
    _Searchable(
        "workcenter",
        Workcenter,
        _workcenter_result,
        False,
        (Workcenter.name, Workcenter.code),
        False,
    ),
)

_SPEC_BY_TYPE: dict[str, FtsEntity] = {spec.entity_type: spec for spec in ENTITY_SPECS}


def _search_fts(db: Session, searchable: _Searchable, q: str, limit: int) -> list[Any]:
    """Search one entity type through its FTS5 index, best matches first."""
    spec = _SPEC_BY_TYPE[searchable.entity_type]
    fts = fts_table(spec)
    # Quote the term so it is matched as a literal substring (trigram tokenizer)
    phrase = '"' + q.replace('"', '""') + '"'
    query = (
        db.query(searchable.model)
        .join(fts, fts.c.rowid == searchable.model.id)
        .filter(literal_column(spec.fts_table).match(phrase))
    )
    if searchable.soft_delete:
        query = query.filter(searchable.model.deleted_at.is_(None))
    if searchable.filters:
        query = query.filter(*searchable.filters)
    return query.order_by(literal_column(f"{spec.fts_table}.rank")).limit(limit).all()


def _search_ilike(db: Session, searchable: _Searchable, q: str, limit: int) -> list[Any]:
    """Fallback LIKE scan, matching the FTS substring semantics."""
    term = f"%{q}%"
    query = db.query(searchable.model).filter(
        or_(*(col.ilike(term) for col in searchable.ilike_columns))
    )
    if searchable.soft_delete:
        query = query.filter(searchable.model.deleted_at.is_(None))
    if searchable.filters:
        query = query.filter(*searchable.filters)
    if searchable.order_desc:
        query = query.order_by(searchable.model.id.desc())
    else:
        query = query.order_by(searchable.ilike_columns[0])
    return query.limit(limit).all()


@router.get("", response_model=list[SearchResult])
def search(
    db: DbSession,
    q: str = Query(..., min_length=1, description="Search query"),
    limit: int = Query(5, ge=1, le=20, description="Max results per entity type"),
) -> list[SearchResult]:
    """Search across all entity types."""
    # Trigram FTS needs at least 3 characters; shorter queries scan
    use_fts = len(q) >= 3 and fts_ready(db.get_bind())

    results: list[SearchResult] = []
    for searchable in _SEARCHABLES:
        if use_fts:
            entities = _search_fts(db, searchable, q, limit)
        else:
            entities = _search_ilike(db, searchable, q, limit)
        results.extend(searchable.build(entity) for entity in entities)
    return results
