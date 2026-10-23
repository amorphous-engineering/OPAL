"""The execution document's view model, as JSON.

One builder assembles everything the execution page renders: the OP / step
hierarchy (redline ops interleaved before their host), the COMPLETE and SKIP
gates the server enforces, holds, sequence waits, cursors, notes, evidence,
kit and consumption state. The client renders this and decides nothing:
a control is inert exactly when the step's ``complete_blockers`` /
``skip_blockers`` are non-empty, because those lists are the same fold the
commitment endpoints refuse on.

Authoring-shaped fields (title, instructions, caution, role, images, data
schema, step kit) sit beside execution-shaped ones (status, captured data,
notes) in each step so one component can render both modes.
"""

from datetime import UTC, datetime
from typing import Any

from sqlalchemy import or_
from sqlalchemy.orm import Session, joinedload

from opal.core import execution_flow as exec_flow
from opal.core.holds import enum_value, get_hold_state
from opal.core.signoffs import derive_legacy
from opal.db.models import InventoryRecord, Kit, User
from opal.db.models.attachment import Attachment
from opal.db.models.execution import ProcedureInstance, StepExecution, StepSignoff
from opal.db.models.inventory import (
    InventoryConsumption,
    InventoryProduction,
    ProductionStatus,
)
from opal.db.models.issue import Issue
from opal.db.models.procedure import ProcedureOutput, ProcedureVersion

TERMINAL = exec_flow.TERMINAL_STEP_STATUSES


def _iso(dt: datetime | None) -> str | None:
    if dt is None:
        return None
    if dt.tzinfo is None:
        dt = dt.replace(tzinfo=UTC)
    return dt.isoformat()


def _blocker(b: exec_flow.Blocker) -> dict[str, Any]:
    return {
        "kind": b.kind,
        "message": b.message,
        "issue_id": b.issue_id,
        "issue_number": b.issue_number,
    }


def display_number(se: StepExecution, op_number: str | None) -> str:
    """Display number of a row. Sub-steps always carry their OP prefix
    ("1.2"), even when the snapshot stored a bare "2"."""
    raw = se.step_number_str or str(se.step_number)
    if se.level > 0 and "." not in raw and op_number:
        return f"{op_number}.{raw}"
    return raw


def _issue_row(i: Issue, step_numbers: dict[int, str]) -> dict[str, Any]:
    return {
        "id": i.id,
        "issue_number": i.issue_number,
        "title": i.title,
        "issue_type": enum_value(i.issue_type),
        "priority": enum_value(i.priority),
        "status": enum_value(i.status),
        "state": i.disp_state,
        "ticket_state": i.ticket_state,
        "containment": enum_value(i.containment),
        "disposition_type": enum_value(i.disposition_type),
        "is_blocking": i.is_blocking,
        "raised_step_number": step_numbers.get(i.raised_step_id) if i.raised_step_id else None,
        "created_at": _iso(i.created_at),
    }


def _hold_entry(i: Issue, kind: str) -> dict[str, Any]:
    return {
        "issue_id": i.id,
        "issue_number": i.issue_number,
        "title": i.title,
        "kind": kind,
        "disposition_state": i.disp_state,
        "ticket_state": i.ticket_state,
    }


def _capture_display(value: Any) -> str:
    """One-line rendering of a captured value (data table, report)."""
    if isinstance(value, bool):
        return "YES" if value else "NO"
    if value is None or value == "":
        return "—"
    if isinstance(value, list):
        if not value:
            return "—"
        return f"{len(value)} image(s) (" + ", ".join(f"#{v}" for v in value) + ")"
    return str(value)


def build_execution_document(
    db: Session, instance: ProcedureInstance, viewer_id: int | None = None
) -> dict[str, Any]:
    """The full document for one work order."""
    version = db.get(ProcedureVersion, instance.version_id)
    content = version.content if version else {}
    version_steps = content.get("steps", []) if version else []
    vs_map = {s["order"]: s for s in version_steps}
    inst_status = enum_value(instance.status)
    active = inst_status in ("cut", "in_work")

    step_execs = sorted(instance.step_executions, key=lambda s: s.step_number)
    se_by_order = {se.step_number: se for se in step_execs}
    se_ids = [se.id for se in step_execs]

    # ---- people ----
    cursors = exec_flow.instance_cursors(db, instance.id)
    step_notes = exec_flow.notes_by_step(db, se_ids)
    user_ids: set[int] = {c.user_id for c in cursors}
    user_ids |= {se.completed_by_id for se in step_execs if se.completed_by_id}
    user_ids |= {se.signed_off_by_id for se in step_execs if se.signed_off_by_id}
    user_ids |= {n.author_id for ns in step_notes.values() for n in ns if n.author_id}
    signoff_recs: dict[int, dict[int, StepSignoff]] = {}
    if se_ids:
        for rec in db.query(StepSignoff).filter(StepSignoff.step_execution_id.in_(se_ids)):
            signoff_recs.setdefault(rec.step_execution_id, {})[rec.slot] = rec
            if rec.signed_by_id:
                user_ids.add(rec.signed_by_id)
    for p in instance.participants or []:
        if p.get("user_id"):
            user_ids.add(p["user_id"])
    if instance.started_by_id:
        user_ids.add(instance.started_by_id)
    if version and version.created_by_id:
        user_ids.add(version.created_by_id)
    users = (
        {u.id: u for u in db.query(User).filter(User.id.in_(user_ids)).all()} if user_ids else {}
    )

    def uname(uid: int | None) -> str | None:
        u = users.get(uid) if uid else None
        return u.name if u else None

    now = datetime.now(UTC)

    def stale(u: User | None) -> bool:
        if u is None or u.last_seen_at is None:
            return True
        seen = u.last_seen_at if u.last_seen_at.tzinfo else u.last_seen_at.replace(tzinfo=UTC)
        return (now - seen).total_seconds() > exec_flow.PRESENCE_STALE_SECONDS

    cursors_by_se: dict[int, list[dict[str, Any]]] = {}
    my_cursor_order: int | None = None
    se_by_id = {se.id: se for se in step_execs}
    for c in sorted(cursors, key=lambda c: c.focused_at):
        u = users.get(c.user_id)
        cursors_by_se.setdefault(c.step_execution_id, []).append(
            {
                "user_id": c.user_id,
                "name": u.name if u else None,
                "initials": exec_flow.user_initials(u.name if u else None),
                "focused_at": _iso(c.focused_at),
                "stale": stale(u),
            }
        )
        if viewer_id is not None and c.user_id == viewer_id:
            target = se_by_id.get(c.step_execution_id)
            my_cursor_order = target.step_number if target else None

    # ---- holds & gates ----
    hold_state = get_hold_state(db, instance.id)
    raised_by_se = exec_flow.holding_ncs_by_step(db, instance.id)
    bound_by_se = dict(hold_state.start_blocked)

    linked_issues = (
        db.query(Issue)
        .filter(Issue.procedure_instance_id == instance.id, Issue.deleted_at.is_(None))
        .all()
    )
    disp_rank = {"undispositioned": 0, "open": 1, "dispositioned": 2, "closed": 3}
    linked_issues.sort(key=lambda i: (not i.is_blocking, disp_rank.get(i.disp_state, 4), -i.id))

    # Redline ops: ad-hoc rows have no snapshot entry; title / instructions live on the row.
    redline_issue_ids = {se.ad_hoc_issue_id for se in step_execs if se.ad_hoc_issue_id}
    redline_issues = {i.id: i for i in linked_issues if i.id in redline_issue_ids}
    missing = redline_issue_ids - set(redline_issues)
    if missing:
        redline_issues.update({i.id: i for i in db.query(Issue).filter(Issue.id.in_(missing))})

    # Residual trace: a dispositioned issue leaves a line on the step it was raised at.
    history_by_se: dict[int, list[dict[str, Any]]] = {}
    for iss in linked_issues:
        if iss.raised_step_id and iss.disp_state != "undispositioned":
            history_by_se.setdefault(iss.raised_step_id, []).append(
                {
                    "issue_id": iss.id,
                    "issue_number": iss.issue_number,
                    "state": iss.disp_state,
                    "ticket_state": iss.ticket_state,
                    "disposition_type": enum_value(iss.disposition_type),
                }
            )

    # ---- evidence ----
    atts_by_se: dict[int, list[Attachment]] = {}
    atts_by_note: dict[int, list[Attachment]] = {}
    wo_atts: list[Attachment] = []
    scope = Attachment.procedure_instance_id == instance.id
    if se_ids:
        scope = or_(scope, Attachment.step_execution_id.in_(se_ids))
    for att in (
        db.query(Attachment)
        .options(joinedload(Attachment.uploaded_by))
        .filter(scope)
        .order_by(Attachment.created_at.asc())
    ):
        if att.step_note_id:
            atts_by_note.setdefault(att.step_note_id, []).append(att)
        elif att.step_execution_id:
            atts_by_se.setdefault(att.step_execution_id, []).append(att)
        elif att.procedure_instance_id == instance.id:
            wo_atts.append(att)

    def att_row(a: Attachment) -> dict[str, Any]:
        return {
            "id": a.id,
            "filename": a.original_filename,
            "mime_type": a.mime_type,
            "size_bytes": a.size_bytes,
            "kind": a.kind,
            "note": a.note,
            "uploaded_by": a.uploaded_by.name if a.uploaded_by else None,
            "created_at": _iso(a.created_at),
        }

    def note_att_row(a: Attachment) -> dict[str, Any]:
        return {
            "id": a.id,
            "filename": a.original_filename,
            "mime_type": a.mime_type,
            "size_bytes": a.size_bytes,
            "url": f"/api/attachments/{a.id}/download",
            "is_image": (a.mime_type or "").startswith("image/"),
        }

    def person(uid: int | None) -> dict[str, Any] | None:
        u = users.get(uid) if uid else None
        return {"id": u.id, "name": u.name} if u else None

    # ---- consumption ----
    consumptions = (
        db.query(InventoryConsumption)
        .options(joinedload(InventoryConsumption.inventory_record).joinedload(InventoryRecord.part))
        .filter(InventoryConsumption.procedure_instance_id == instance.id)
        .order_by(InventoryConsumption.id)
        .all()
    )
    step_number_str = {se.id: se.step_number_str or str(se.step_number) for se in step_execs}

    def cons_row(c: InventoryConsumption) -> dict[str, Any]:
        rec = c.inventory_record
        return {
            "id": c.id,
            "part_id": rec.part_id,
            "part_number": rec.part.internal_pn,
            "part_name": rec.part.name,
            "opal_number": rec.opal_number,
            "quantity": float(c.quantity),
            "lot_number": rec.lot_number,
            "location": rec.location,
            "usage_type": enum_value(c.usage_type),
            "step_execution_id": c.step_execution_id,
            "step_number": step_number_str.get(c.step_execution_id)
            if c.step_execution_id
            else None,
        }

    cons_rows = [cons_row(c) for c in consumptions]
    cons_by_se: dict[int, list[dict[str, Any]]] = {}
    for row in cons_rows:
        if row["step_execution_id"]:
            cons_by_se.setdefault(row["step_execution_id"], []).append(row)

    # Part numbers for step kits (the snapshot carries names only).
    kit_part_ids = {
        sk["part_id"]
        for vs in version_steps
        for sk in (vs.get("step_kit") or [])
        if "part_id" in sk
    }
    part_pn: dict[int, str | None] = {}
    if kit_part_ids:
        from opal.db.models import Part

        part_pn = {
            p.id: p.internal_pn for p in db.query(Part).filter(Part.id.in_(kit_part_ids)).all()
        }

    # ---- step builder ----
    def build_step(se: StepExecution, op_number: str | None, is_op: bool) -> dict[str, Any]:
        vs = vs_map.get(se.step_number) or {}
        status = enum_value(se.status)
        completer = users.get(se.completed_by_id) if se.completed_by_id else None
        number = display_number(se, op_number)
        complete_b = exec_flow.complete_blockers(db, instance, se, hold_state)
        skip_b = exec_flow.skip_blockers(db, instance, se, hold_state)
        defs = exec_flow.step_signoff_defs(
            version, se, is_op and bool(children_of.get(se.step_number))
        )
        recs = signoff_recs.get(se.id, {})
        signoffs = []
        for n, d in enumerate(defs):
            rec = recs.get(n)
            can_sign, slot_b = exec_flow.slot_gate(
                db, instance, se, n, defs, recs, hold_state, complete=complete_b
            )
            signoffs.append(
                {
                    "slot": n,
                    "label": rec.label if rec else d["label"],
                    "role": rec.role if rec else d["role"],
                    "signed_by": person(rec.signed_by_id) if rec else None,
                    "signed_at": _iso(rec.signed_at) if rec else None,
                    "can_sign": can_sign,
                    "blockers": [_blocker(b) for b in slot_b],
                }
            )
        requires_signoff, first_role = derive_legacy(
            defs, is_op and bool(children_of.get(se.step_number))
        )
        schema = se.required_data_schema or vs.get("required_data_schema")
        skip_reason = None
        if status == "skipped" and isinstance(se.data_captured, dict):
            skip_reason = se.data_captured.get("skip_reason")
        return {
            "order": se.step_number,
            "execution_id": se.id,
            "number": number,
            "title": se.title or vs.get("title") or "",
            "level": se.level,
            "is_op": is_op,
            "parent_order": se.parent_step_order,
            "status": status,
            "instructions": se.instructions if se.ad_hoc_issue_id else vs.get("instructions"),
            "caution": vs.get("caution"),
            "role": first_role if signoffs else vs.get("required_role"),
            "requires_signoff": requires_signoff,
            "signoffs": signoffs,
            "is_contingency": bool(vs.get("is_contingency", False)),
            "estimated_duration_minutes": vs.get("estimated_duration_minutes"),
            "images": vs.get("images") or [],
            "step_kit": [
                {**sk, "part_number": part_pn.get(sk.get("part_id"))}
                for sk in (vs.get("step_kit") or [])
            ],
            "data_schema": schema,
            "data_captured": None if status == "skipped" else se.data_captured,
            "skip_reason": skip_reason,
            "started_at": _iso(se.started_at),
            "completed": {
                "by": completer.name if completer else None,
                "initials": exec_flow.user_initials(completer.name if completer else None),
                "at": _iso(se.completed_at),
            }
            if status in ("completed", "signed_off", "skipped")
            else None,
            "signed_off": {"by": uname(se.signed_off_by_id), "at": _iso(se.signed_off_at)}
            if se.signed_off_at
            else None,
            "duration_seconds": se.duration_seconds,
            "cursors": cursors_by_se.get(se.id, []),
            "holds": [_hold_entry(i, "bound") for i in bound_by_se.get(se.id, [])]
            + [_hold_entry(i, "raised") for i in raised_by_se.get(se.id, [])],
            "issue_history": history_by_se.get(se.id, []),
            "complete_blockers": [_blocker(b) for b in complete_b],
            "skip_blockers": [_blocker(b) for b in skip_b],
            "notes": [
                {
                    "id": n.id,
                    "author": person(n.author_id),
                    "created_at": _iso(n.created_at),
                    "body": n.body,
                    "attachments": [note_att_row(a) for a in atts_by_note.get(n.id, [])],
                }
                for n in step_notes.get(se.id, [])
            ],
            "attachments": [att_row(a) for a in atts_by_se.get(se.id, [])],
            "consumptions": cons_by_se.get(se.id, []),
            "waiting": None,  # filled per op below
        }

    children_of: dict[int, list[StepExecution]] = {}
    for se in step_execs:
        if se.parent_step_order is not None:
            children_of.setdefault(se.parent_step_order, []).append(se)

    def build_op(op_row: StepExecution) -> dict[str, Any]:
        vs = vs_map.get(op_row.step_number) or {}
        is_redline = op_row.ad_hoc_issue_id is not None
        op_number = op_row.step_number_str or str(op_row.step_number)
        kids = sorted(children_of.get(op_row.step_number, []), key=lambda s: s.step_number)
        op_step = build_step(op_row, None, True)
        steps = [build_step(k, op_number, False) for k in kids]

        # OP dependencies ("WAITING ON OP n"): prerequisites not yet terminal.
        waiting_ops: list[str] = []
        for dep in vs.get("depends_on") or []:
            prereq = se_by_order.get(dep)
            if prereq is not None and enum_value(prereq.status) not in TERMINAL:
                waiting_ops.append(prereq.step_number_str or str(dep))
        dep_text = ("WAITING ON OP " + ", ".join(waiting_ops)) if waiting_ops else None

        # strict_sequence: sub-step N waits on its earlier siblings.
        strict = bool(vs.get("strict_sequence"))
        for s in steps:
            s["waiting"] = dep_text
            if dep_text is None and strict and s["status"] == "pending" and not is_redline:
                unmet = [
                    p["number"]
                    for p in steps
                    if p["order"] < s["order"] and p["status"] not in TERMINAL
                ]
                if unmet:
                    more = f" +{len(unmet) - 1}" if len(unmet) > 1 else ""
                    s["waiting"] = f"WAITING ON {unmet[0]}{more}"
        op_step["waiting"] = dep_text

        # Undispositioned scope of the whole OP: the HELD BY blockline.
        holds: list[dict[str, Any]] = []
        seen: set[int] = set()
        for row in [op_step, *steps]:
            for h in row["holds"]:
                if h["disposition_state"] == "undispositioned" and h["issue_id"] not in seen:
                    seen.add(h["issue_id"])
                    holds.append(h)

        leaf = steps if steps else [op_step]
        done = sum(1 for s in leaf if s["status"] in ("completed", "skipped", "signed_off"))

        # Open NCs anywhere in the OP: the redline-visibility predicate.
        open_ncs: list[dict[str, Any]] = []
        if not is_redline:
            row_ids = {op_row.id, *(k.id for k in kids)}
            for iss in linked_issues:
                if (
                    enum_value(iss.issue_type) == "non_conformance"
                    and iss.raised_step_id in row_ids
                    and enum_value(iss.status) != "closed"
                ):
                    open_ncs.append(
                        {"id": iss.id, "issue_number": iss.issue_number, "title": iss.title}
                    )

        redline = None
        if is_redline:
            ri = redline_issues.get(op_row.ad_hoc_issue_id)
            redline = {
                "issue_id": op_row.ad_hoc_issue_id,
                "issue_number": ri.issue_number if ri else None,
                "title": ri.title if ri else None,
                "host_order": op_row.ad_hoc_host_order,
            }

        return {
            "order": op_row.step_number,
            "number": op_number,
            "title": op_step["title"],
            "status": op_step["status"],
            "instructions": op_step["instructions"],
            "caution": vs.get("caution"),
            "role": op_step["role"],
            "signoffs": op_step["signoffs"],
            "strict_sequence": strict,
            "is_contingency": bool(vs.get("is_contingency", False)),
            "is_ad_hoc": is_redline,
            "redline": redline,
            "waiting_on_ops": waiting_ops,
            "holds": holds,
            "open_ncs": open_ncs,
            "progress": {"done": done, "total": len(leaf)},
            "step": op_step,
            "steps": steps,
        }

    op_rows = [se for se in step_execs if se.level == 0]
    normal: list[dict[str, Any]] = []
    contingency: list[dict[str, Any]] = []
    redlines_by_host: dict[int, list[dict[str, Any]]] = {}
    for op_row in op_rows:
        op = build_op(op_row)
        if op["is_ad_hoc"]:
            redlines_by_host.setdefault(op["redline"]["host_order"], []).append(op)
        elif op["is_contingency"]:
            contingency.append(op)
        else:
            normal.append(op)

    def num_key(o: dict[str, Any]) -> tuple[int, str]:
        n = o["number"]
        return (int(n), n) if n.isdigit() else (0, n)

    normal.sort(key=num_key)
    contingency.sort(key=lambda o: o["number"])
    ops: list[dict[str, Any]] = []
    for op in normal:
        ops.extend(redlines_by_host.get(op["order"], []))
        ops.append(op)
    placed = {o["order"] for o in ops}
    for host_ops in redlines_by_host.values():  # redlines whose host is a contingency op
        ops.extend(o for o in host_ops if o["order"] not in placed)

    # ---- progress (leaf steps, contingency excluded — same as /state) ----
    exec_state = exec_flow.build_execution_state(db, instance)

    # ---- material ----
    kit_items = (
        db.query(Kit)
        .options(joinedload(Kit.part))
        .filter(Kit.procedure_id == instance.procedure_id)
    ).all()
    consumed_by_part: dict[int, float] = {}
    for c in consumptions:
        if enum_value(c.usage_type) == "consume":
            consumed_by_part[c.inventory_record.part_id] = consumed_by_part.get(
                c.inventory_record.part_id, 0
            ) + float(c.quantity)
    bom_items = []
    for k in kit_items:
        got = consumed_by_part.pop(k.part_id, 0.0)
        req = float(k.quantity_required)
        bom_items.append(
            {
                "part_id": k.part_id,
                "part_number": k.part.internal_pn,
                "part_name": k.part.name,
                "uom": k.part.unit_of_measure,
                "qty_required": req,
                "qty_consumed": got,
                "variance": got - req,
            }
        )
    part_info: dict[int, tuple[str | None, str]] = {}
    for c in consumptions:
        part_info[c.inventory_record.part_id] = (
            c.inventory_record.part.internal_pn,
            c.inventory_record.part.name,
        )
    unplanned = [
        {
            "part_id": pid,
            "part_number": part_info.get(pid, (None, "Unknown"))[0],
            "part_name": part_info.get(pid, (None, "Unknown"))[1],
            "qty_consumed": qty,
        }
        for pid, qty in consumed_by_part.items()
    ]

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
        .order_by(InventoryProduction.id)
        .all()
    )
    has_wip = any(enum_value(p.status) == ProductionStatus.WIP.value for p in productions)
    kit_relevant = bool(
        kit_items or consumptions or any(vs.get("step_kit") for vs in version_steps)
    )

    ref_atts = (
        db.query(Attachment)
        .options(joinedload(Attachment.uploaded_by))
        .filter(Attachment.procedure_id == instance.procedure_id, Attachment.kind == "reference")
        .order_by(Attachment.original_filename.asc())
        .all()
    )

    # ---- captured-data audit rows ----
    data_rows = []
    for se in step_execs:
        if not se.data_captured or enum_value(se.status) == "skipped":
            continue
        schema = se.required_data_schema or (vs_map.get(se.step_number) or {}).get(
            "required_data_schema"
        )
        labels = {f.get("name"): f for f in (schema or {}).get("fields", [])}
        for field_name, value in se.data_captured.items():
            fd = labels.get(field_name, {})
            data_rows.append(
                {
                    "step_number": step_number_str.get(se.id),
                    "step_order": se.step_number,
                    "field": fd.get("label") or field_name,
                    "unit": fd.get("unit"),
                    "value": _capture_display(value),
                    "by": uname(se.completed_by_id),
                    "at": _iso(se.completed_at or se.updated_at),
                }
            )

    activity = [
        t for t in [instance.updated_at, *(se.updated_at for se in step_execs)] if t is not None
    ]
    last_activity = max((t if t.tzinfo else t.replace(tzinfo=UTC) for t in activity), default=None)

    roster = exec_state["roster"]
    return {
        "instance": {
            "id": instance.id,
            "work_order": instance.work_order_number,
            "status": inst_status,
            "active": active,
            "priority": instance.priority,
            "procedure": {
                "id": instance.procedure_id,
                "name": instance.procedure.name,
                "type": enum_value(instance.procedure.procedure_type),
            },
            "version": {
                "id": instance.version_id,
                "number": version.version_number if version else None,
                "created_at": _iso(version.created_at) if version else None,
                "created_by": uname(version.created_by_id) if version else None,
            },
            "created_at": _iso(instance.created_at),
            "created_by": uname(instance.started_by_id),
            "started_at": _iso(instance.started_at),
            "completed_at": _iso(instance.completed_at),
            "scheduled_start_at": _iso(instance.scheduled_start_at),
            "target_completion_at": _iso(instance.target_completion_at),
            "last_activity_at": _iso(last_activity),
            "duration_seconds": instance.duration_seconds,
        },
        "progress": exec_state["instance"]["progress"],
        "ops": ops,
        "contingency_ops": contingency,
        "issues": [_issue_row(i, step_number_str) for i in linked_issues],
        "holds": exec_state["holds"],
        "roster": roster,
        "my_cursor_order": my_cursor_order,
        "kit": {"items": bom_items, "unplanned": unplanned},
        "consumptions": cons_rows,
        "outputs": [
            {
                "part_id": o.part_id,
                "part_number": o.part.internal_pn,
                "part_name": o.part.name,
                "quantity": float(o.quantity_produced),
            }
            for o in outputs
        ],
        "productions": [
            {
                "id": p.id,
                "part_id": p.inventory_record.part_id,
                "part_number": p.inventory_record.part.internal_pn,
                "part_name": p.inventory_record.part.name,
                "serial_number": p.serial_number,
                "opal_number": p.produced_opal_number,
                "quantity": float(p.quantity),
                "lot_number": p.inventory_record.lot_number,
                "location": p.inventory_record.location,
                "status": enum_value(p.status),
            }
            for p in productions
        ],
        "kit_relevant": kit_relevant,
        "material_relevant": kit_relevant or bool(productions or outputs),
        "can_finalize": inst_status == "completed" and has_wip,
        "reference_attachments": [att_row(a) for a in ref_atts],
        "attachments": [att_row(a) for a in wo_atts],
        "data_rows": data_rows,
        "generated_at": now.isoformat(),
    }
