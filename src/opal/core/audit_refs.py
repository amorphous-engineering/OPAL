"""Turn audit rows (table_name, record_id) into something a person can read.

An audit row points at a record by table and database id. Ids never render
(voice rule 7), so this module resolves each pointer to the record's own
name (part number, issue number, WO, OPAL number ...) and the SPA route that
shows it. Child rows (PO lines, step executions, procedure steps ...) resolve
to the parent they live on. Records that were hard-deleted, or tables with
no page, resolve to an empty ref and render as the entity type alone.
"""

from collections.abc import Callable, Iterable
from dataclasses import dataclass
from typing import Any

from sqlalchemy.orm import Session

from opal.db.base import Base

#: Display name per audit table.
ENTITY_LABELS: dict[str, str] = {
    "part": "Part",
    "inventory_record": "Stock",
    "master_procedure": "Template",
    "procedure_step": "Template step",
    "procedure_version": "Template version",
    "procedure_instance": "Execution",
    "step_execution": "Execution step",
    "issue": "Issue",
    "issue_comment": "Issue comment",
    "risk": "Risk",
    "purchase": "Purchase",
    "purchase_line": "PO line",
    "supplier": "Supplier",
    "dataset": "Dataset",
    "data_point": "Data point",
    "workcenter": "Workcenter",
    "user": "User",
    "kit": "Kit",
    "step_kit": "Step kit",
    "inventory_consumption": "Consumption",
    "inventory_production": "Production",
    "attachment": "Attachment",
    "stock_transfer": "Transfer",
    "stock_test_result": "Test result",
    "test_template": "Test template",
    "requirement": "Requirement",
    "app_setting": "Setting",
    "baseline_event": "Baseline",
}


def entity_label(table_name: str) -> str:
    return ENTITY_LABELS.get(table_name, table_name.replace("_", " ").capitalize())


@dataclass(frozen=True)
class EntityRef:
    label: str | None
    href: str | None


EMPTY = EntityRef(None, None)

Resolver = Callable[[Session, Any], EntityRef]


def _part(db: Session, r: Any) -> EntityRef:
    return EntityRef(r.internal_pn or r.name, f"/parts/{r.id}")


def _inventory(db: Session, r: Any) -> EntityRef:
    if r.opal_number:
        return EntityRef(r.opal_number, f"/inventory/opal/{r.opal_number}")
    return EMPTY


def _procedure(db: Session, r: Any) -> EntityRef:
    return EntityRef(r.name, f"/procedures/{r.id}")


def _execution(db: Session, r: Any) -> EntityRef:
    label = r.work_order_number or (r.procedure.name if r.procedure else None)
    return EntityRef(label, f"/executions/{r.id}")


def _issue(db: Session, r: Any) -> EntityRef:
    return EntityRef(r.issue_number, f"/issues/{r.id}")


def _risk(db: Session, r: Any) -> EntityRef:
    return EntityRef(r.risk_number, f"/risks/{r.id}")


def _purchase(db: Session, r: Any) -> EntityRef:
    return EntityRef(r.reference or f"PO-{r.id}", f"/purchases/{r.id}")


def _supplier(db: Session, r: Any) -> EntityRef:
    return EntityRef(r.name, f"/suppliers/{r.id}")


def _dataset(db: Session, r: Any) -> EntityRef:
    return EntityRef(r.name, f"/datasets/{r.id}")


def _workcenter(db: Session, r: Any) -> EntityRef:
    return EntityRef(r.name, f"/workcenters/{r.id}")


def _user(db: Session, r: Any) -> EntityRef:
    return EntityRef(r.name, f"/users/{r.id}")


def _requirement(db: Session, r: Any) -> EntityRef:
    return EntityRef(r.req_number, f"/requirements/{r.id}")


def _via(table: str, attr: str, resolver: Resolver) -> Resolver:
    """Resolve a child row to the parent record named by foreign key ``attr``."""

    def resolve(db: Session, r: Any) -> EntityRef:
        parent = _model(table)
        pid = getattr(r, attr, None)
        row = db.get(parent, pid) if parent is not None and pid is not None else None
        return resolver(db, row) if row is not None else EMPTY

    return resolve


_RESOLVERS: dict[str, Resolver] = {
    "part": _part,
    "inventory_record": _inventory,
    "master_procedure": _procedure,
    "procedure_instance": _execution,
    "issue": _issue,
    "risk": _risk,
    "purchase": _purchase,
    "supplier": _supplier,
    "dataset": _dataset,
    "workcenter": _workcenter,
    "user": _user,
    "requirement": _requirement,
    "purchase_line": _via("purchase", "purchase_id", _purchase),
    "step_execution": _via("procedure_instance", "instance_id", _execution),
    "procedure_step": _via("master_procedure", "procedure_id", _procedure),
    "procedure_version": _via("master_procedure", "procedure_id", _procedure),
    "issue_comment": _via("issue", "issue_id", _issue),
    "data_point": _via("dataset", "dataset_id", _dataset),
}


def _model(table_name: str) -> Any | None:
    for mapper in Base.registry.mappers:
        if mapper.local_table.name == table_name:
            return mapper.class_
    return None


def resolve_entities(
    db: Session, pairs: Iterable[tuple[str, int]]
) -> dict[tuple[str, int], EntityRef]:
    """Batch-resolve (table, id) pairs. Missing records map to an empty ref."""
    out: dict[tuple[str, int], EntityRef] = {}
    wanted: dict[str, set[int]] = {}
    for table, rid in pairs:
        wanted.setdefault(table, set()).add(rid)
    for table, ids in wanted.items():
        resolver = _RESOLVERS.get(table)
        model = _model(table) if resolver else None
        rows: dict[int, Any] = {}
        if model is not None:
            rows = {r.id: r for r in db.query(model).filter(model.id.in_(ids)).all()}
        for rid in ids:
            row = rows.get(rid)
            out[(table, rid)] = resolver(db, row) if resolver and row is not None else EMPTY
    return out
