"""The completed-execution (build) report, as JSON.

Printable report content for a COMPLETED work order: end items, the
operations table, captured data (labelled from the step schema), dataset
fields enabled for charting, issues, and closeout photos. The client renders
it; nothing here is HTML.
"""

import io
from datetime import UTC, datetime
from typing import Any

from sqlalchemy.orm import Session, joinedload

from opal.core.execution_document import _capture_display, _iso
from opal.core.holds import enum_value
from opal.db.models import InventoryRecord, User
from opal.db.models.attachment import Attachment
from opal.db.models.dataset import DataPoint, Dataset
from opal.db.models.execution import ProcedureInstance, StepSignoff
from opal.db.models.inventory import InventoryProduction
from opal.db.models.issue import Issue
from opal.db.models.procedure import ProcedureOutput, ProcedureVersion


def qr_svg(url: str) -> bytes:
    import segno

    buf = io.BytesIO()
    segno.make(url).save(buf, kind="svg", scale=4, border=1)
    return buf.getvalue()


def build_execution_report(db: Session, instance: ProcedureInstance) -> dict[str, Any]:
    version = db.get(ProcedureVersion, instance.version_id)
    version_steps = {s["order"]: s for s in (version.content.get("steps", []) if version else [])}
    step_execs = sorted(instance.step_executions, key=lambda se: se.step_number)

    user_ids = {
        uid
        for se in step_execs
        for uid in (se.completed_by_id, se.signed_off_by_id)
        if uid is not None
    }
    if instance.started_by_id:
        user_ids.add(instance.started_by_id)
    signoffs_by_se: dict[int, list[StepSignoff]] = {}
    for rec in (
        db.query(StepSignoff)
        .filter(StepSignoff.step_execution_id.in_([se.id for se in step_execs] or [0]))
        .order_by(StepSignoff.slot)
    ):
        signoffs_by_se.setdefault(rec.step_execution_id, []).append(rec)
        if rec.signed_by_id:
            user_ids.add(rec.signed_by_id)
    users = {u.id: u.name for u in db.query(User).filter(User.id.in_(user_ids)).all()}

    def title_of(se) -> str:
        vs = version_steps.get(se.step_number) or {}
        return se.title or vs.get("title") or "(untitled)"

    operations = [
        {
            "step_number": se.step_number_str or str(se.step_number),
            "level": se.level,
            "title": title_of(se),
            "status": enum_value(se.status),
            "started_at": _iso(se.started_at),
            "completed_at": _iso(se.completed_at),
            "operator": users.get(se.completed_by_id),
            "signoff": users.get(se.signed_off_by_id),
            "signoff_at": _iso(se.signed_off_at),
            "signoffs": [
                {
                    "slot": r.slot,
                    "label": r.label,
                    "role": r.role,
                    "signed_by": users.get(r.signed_by_id),
                    "signed_at": _iso(r.signed_at),
                }
                for r in signoffs_by_se.get(se.id, [])
            ],
        }
        for se in step_execs
    ]

    data_collects = []
    for se in step_execs:
        if not se.data_captured or enum_value(se.status) == "skipped":
            continue
        vs = version_steps.get(se.step_number) or {}
        schema = se.required_data_schema or vs.get("required_data_schema") or {}
        defs = {f["name"]: f for f in schema.get("fields", []) if "name" in f}
        rows = [
            {
                "label": defs.get(name, {}).get("label") or name,
                "value": _capture_display(value),
                "unit": defs.get(name, {}).get("unit"),
            }
            for name, value in se.data_captured.items()
        ]
        if rows:
            data_collects.append(
                {
                    "step_number": se.step_number_str or str(se.step_number),
                    "step_title": title_of(se),
                    "rows": rows,
                }
            )

    # Datasets with chart-enabled numeric fields whose points are tied to this WO.
    chart_datasets: list[dict[str, Any]] = []
    se_ids = {se.id for se in step_execs}
    if se_ids:
        points = (
            db.query(DataPoint)
            .filter(DataPoint.step_execution_id.in_(se_ids))
            .order_by(DataPoint.recorded_at.asc())
            .all()
        )
        by_ds: dict[int, list[DataPoint]] = {}
        for p in points:
            by_ds.setdefault(p.dataset_id, []).append(p)
        if by_ds:
            for ds in db.query(Dataset).filter(
                Dataset.id.in_(by_ds.keys()), Dataset.deleted_at.is_(None)
            ):
                fields = (ds.schema or {}).get("fields", []) or []
                chart_fields = [
                    f
                    for f in fields
                    if f.get("chart") is True and f.get("type") == "number" and f.get("name")
                ]
                if not chart_fields:
                    continue
                chart_datasets.append(
                    {
                        "dataset_id": ds.id,
                        "name": ds.name,
                        "chart_fields": chart_fields,
                        "fields": fields,
                        "points": [
                            {"recorded_at": _iso(p.recorded_at), "values": p.values}
                            for p in by_ds[ds.id]
                        ],
                    }
                )

    issues = (
        db.query(Issue)
        .filter(Issue.procedure_instance_id == instance.id, Issue.deleted_at.is_(None))
        .order_by(Issue.created_at.asc())
        .all()
    )
    closeout = (
        db.query(Attachment)
        .filter(Attachment.procedure_instance_id == instance.id, Attachment.kind == "closeout")
        .order_by(Attachment.created_at.asc())
        .all()
    )
    outputs = (
        db.query(ProcedureOutput)
        .options(joinedload(ProcedureOutput.part))
        .filter(ProcedureOutput.procedure_id == instance.procedure_id)
        .all()
    )
    productions = (
        db.query(InventoryProduction)
        .options(joinedload(InventoryProduction.inventory_record).joinedload(InventoryRecord.part))
        .filter(InventoryProduction.procedure_instance_id == instance.id)
        .all()
    )

    return {
        "instance": {
            "id": instance.id,
            "work_order": instance.work_order_number,
            "status": enum_value(instance.status),
            "procedure_id": instance.procedure_id,
            "procedure_name": instance.procedure.name if instance.procedure else None,
            "version_number": version.version_number if version else None,
            "operator": users.get(instance.started_by_id),
            "started_at": _iso(instance.started_at),
            "completed_at": _iso(instance.completed_at),
        },
        "generated_at": datetime.now(UTC).isoformat(),
        "end_items": [
            {
                "part_id": p.inventory_record.part_id,
                "part_name": p.inventory_record.part.name,
                "part_number": p.inventory_record.part.internal_pn,
                "opal_number": p.produced_opal_number,
                "serial_number": p.serial_number,
                "quantity": float(p.quantity),
                "status": enum_value(p.status),
            }
            for p in productions
        ]
        or [
            {
                "part_id": o.part_id,
                "part_name": o.part.name,
                "part_number": o.part.internal_pn,
                "opal_number": None,
                "serial_number": None,
                "quantity": float(o.quantity_produced),
                "status": "planned",
            }
            for o in outputs
        ],
        "operations": operations,
        "data_collects": data_collects,
        "chart_datasets": chart_datasets,
        "issues": [
            {
                "id": i.id,
                "issue_number": i.issue_number,
                "issue_type": enum_value(i.issue_type),
                "priority": enum_value(i.priority),
                "status": enum_value(i.status),
                "title": i.title,
                "root_cause": i.root_cause,
                "disposition_type": enum_value(i.disposition_type),
                "created_at": _iso(i.created_at),
            }
            for i in issues
        ],
        "closeout_attachments": [
            {
                "id": a.id,
                "filename": a.original_filename,
                "created_at": _iso(a.created_at),
            }
            for a in closeout
        ],
    }
