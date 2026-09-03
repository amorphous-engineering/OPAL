"""The execution document's view model.

Everything the execution page and its partials (document tab, docked bar,
rails, step rows) read from context is assembled here, once per request:
the OP/sub-step hierarchy with redlines interleaved, kit/BOM
reconciliation, material relevance, linked issues, the COMPLETE/SKIP gates,
cursors and notes. Routing stays in web/routes.py.
"""

from fastapi import Request

from opal.api.deps import DbSession
from opal.core import execution_flow as exec_flow
from opal.core.holds import get_hold_state
from opal.db.models import InventoryRecord, Kit, User
from opal.db.models.execution import InstanceStatus, ProcedureInstance
from opal.db.models.issue import Issue
from opal.db.models.procedure import ProcedureVersion
from opal.web.context import get_base_context

_BAR_ACTIONABLE = {"pending", "in_progress", "awaiting_signoff"}


def build_execution_context(
    request: Request,
    db: DbSession,
    instance: ProcedureInstance,
) -> dict:
    """Full context for the execution page and its partials (document rows,
    rail, docked bar). One builder — partial routes render fragments of the
    same facts."""
    version = db.query(ProcedureVersion).filter(ProcedureVersion.id == instance.version_id).first()

    context = get_base_context(request, db, f"{instance.work_order_number or 'Execution'} - OPAL")
    context["instance"] = instance
    context["version"] = version
    context["statuses"] = [s.value for s in InstanceStatus]

    # Build steps with execution status and organize hierarchically
    version_steps = version.content.get("steps", []) if version else []

    # Create a lookup for step executions by step order
    exec_lookup = {se.step_number: se for se in instance.step_executions}

    # Build step data with execution info
    def build_step_data(vs):
        step_exec = exec_lookup.get(vs["order"])
        return {
            "order": vs["order"],
            "step_number": vs.get("step_number", str(vs["order"])),
            "level": vs.get("level", 0),
            "parent_step_id": vs.get("parent_step_id"),
            "id": vs.get("id"),  # For linking sub-steps to parents
            "title": vs["title"],
            "instructions": vs.get("instructions"),
            "is_contingency": vs.get("is_contingency", False),
            "required_data_schema": vs.get("required_data_schema"),
            "execution": step_exec,
            "status": (
                step_exec.status.value
                if step_exec and hasattr(step_exec.status, "value")
                else (step_exec.status if step_exec else "pending")
            ),
        }

    all_steps = [build_step_data(vs) for vs in version_steps]
    context["steps"] = all_steps  # Flat list for backward compatibility

    # Organize into ops and sub-steps hierarchy
    ops = []  # Normal ops
    contingency_ops = []  # Contingency ops

    # Build lookup by step ID

    # Group sub-steps by parent
    children_map: dict[int, list] = {}
    for step in all_steps:
        parent_id = step.get("parent_step_id")
        if parent_id:
            if parent_id not in children_map:
                children_map[parent_id] = []
            children_map[parent_id].append(step)

    # Build hierarchical structure
    for step in all_steps:
        if step.get("parent_step_id") is None:  # Top-level op
            sub_steps = sorted(children_map.get(step.get("id"), []), key=lambda s: s["order"])
            # Calculate progress for this op
            total = len(sub_steps) if sub_steps else 1
            completed = (
                sum(1 for s in sub_steps if s["status"] in ["completed", "skipped"])
                if sub_steps
                else (1 if step["status"] in ["completed", "skipped"] else 0)
            )
            op_data = {
                "step": step,
                "sub_steps": sub_steps,
                "total_steps": total,
                "completed_steps": completed,
            }
            if step["is_contingency"]:
                contingency_ops.append(op_data)
            else:
                ops.append(op_data)

    # Sort ops
    def sort_key_normal(x):
        sn = x["step"].get("step_number", "0")
        return int(sn) if sn.isdigit() else 0

    def sort_key_contingency(x):
        return x["step"].get("step_number", "C0")

    ops.sort(key=sort_key_normal)
    contingency_ops.sort(key=sort_key_contingency)

    # Build redline op_data from ad-hoc StepExecution rows. These have no
    # corresponding snapshot entry — title/instructions live directly on the
    # row. Interleave them before their host op in the sidebar.
    redline_op_rows = [
        se for se in instance.step_executions if se.ad_hoc_issue_id is not None and se.level == 0
    ]
    redlines_by_host: dict[int, list] = {}
    if redline_op_rows:
        # Bulk-fetch the issues so we can show their issue_number / link.
        issue_ids = {se.ad_hoc_issue_id for se in redline_op_rows if se.ad_hoc_issue_id}
        issue_lookup = {i.id: i for i in db.query(Issue).filter(Issue.id.in_(issue_ids)).all()}
        for op_row in redline_op_rows:
            sub_rows = sorted(
                [s for s in instance.step_executions if s.parent_step_order == op_row.step_number],
                key=lambda s: s.step_number,
            )

            def _se_status(se):
                return se.status.value if hasattr(se.status, "value") else se.status

            sub_steps = [
                {
                    "order": s.step_number,
                    "step_number": s.step_number_str,
                    "level": s.level,
                    "parent_step_id": None,
                    "id": None,
                    "title": s.title or "",
                    "instructions": s.instructions,
                    "is_contingency": False,
                    "required_data_schema": s.required_data_schema,
                    "execution": s,
                    "status": _se_status(s),
                }
                for s in sub_rows
            ]
            total = len(sub_steps) if sub_steps else 1
            completed = (
                sum(1 for s in sub_steps if s["status"] in ["completed", "skipped"])
                if sub_steps
                else (1 if _se_status(op_row) in ["completed", "skipped"] else 0)
            )
            op_step = {
                "order": op_row.step_number,
                "step_number": op_row.step_number_str,
                "level": 0,
                "parent_step_id": None,
                "id": None,
                "title": op_row.title or "",
                "instructions": op_row.instructions,
                "is_contingency": False,
                "required_data_schema": op_row.required_data_schema,
                "execution": op_row,
                "status": _se_status(op_row),
                "is_ad_hoc": True,
                "ad_hoc_issue": issue_lookup.get(op_row.ad_hoc_issue_id),
                "ad_hoc_host_order": op_row.ad_hoc_host_order,
            }
            op_data = {
                "step": op_step,
                "sub_steps": sub_steps,
                "total_steps": total,
                "completed_steps": completed,
                "is_ad_hoc": True,
            }
            redlines_by_host.setdefault(op_row.ad_hoc_host_order, []).append(op_data)

    # Interleave: for each normal op, insert its redlines just before it.
    if redlines_by_host:
        interleaved: list = []
        for op_data in ops:
            host_order = op_data["step"].get("order")
            for r in redlines_by_host.get(host_order, []):
                interleaved.append(r)
            interleaved.append(op_data)
        ops = interleaved

    context["ops"] = ops
    context["contingency_ops"] = contingency_ops

    # Map step order -> version step data (for data capture schemas, requires_signoff)
    context["version_steps_map"] = {s["order"]: s for s in version_steps}

    # Get kit information
    from sqlalchemy.orm import joinedload

    kit_items = (
        db.query(Kit)
        .options(joinedload(Kit.part))
        .filter(Kit.procedure_id == instance.procedure_id)
        .all()
    )
    context["kit_items"] = kit_items

    # Get existing consumptions
    from opal.db.models.inventory import (
        InventoryConsumption,
        InventoryProduction,
    )
    from opal.db.models.procedure import ProcedureOutput

    consumptions = (
        db.query(InventoryConsumption)
        .options(joinedload(InventoryConsumption.inventory_record).joinedload(InventoryRecord.part))
        .filter(InventoryConsumption.procedure_instance_id == instance.id)
        .all()
    )
    context["consumptions"] = consumptions

    # Group consumptions by step execution ID for step-level display
    step_consumptions: dict[int, list] = {}
    for c in consumptions:
        if c.step_execution_id:
            step_consumptions.setdefault(c.step_execution_id, []).append(c)
    context["step_consumptions"] = step_consumptions

    # Step execution ID -> step number lookup
    step_exec_lookup = {
        se.id: se.step_number_str or str(se.step_number) for se in instance.step_executions
    }
    context["step_exec_lookup"] = step_exec_lookup

    # Get outputs (what this procedure produces)
    output_items = (
        db.query(ProcedureOutput)
        .filter(ProcedureOutput.procedure_id == instance.procedure_id)
        .all()
    )
    context["output_items"] = output_items

    # Get existing productions
    productions = (
        db.query(InventoryProduction)
        .options(joinedload(InventoryProduction.inventory_record).joinedload(InventoryRecord.part))
        .filter(InventoryProduction.procedure_instance_id == instance.id)
        .all()
    )
    context["productions"] = productions

    # BOM reconciliation data
    kit_items = context["kit_items"]
    consume_consumptions = [
        c
        for c in consumptions
        if (c.usage_type.value if hasattr(c.usage_type, "value") else c.usage_type) == "consume"
    ]
    consumed_by_part: dict[int, float] = {}
    for c in consume_consumptions:
        pid = c.inventory_record.part_id
        consumed_by_part[pid] = consumed_by_part.get(pid, 0) + float(c.quantity)

    bom_items = []
    for k in kit_items:
        qty_consumed = consumed_by_part.pop(k.part_id, 0)
        qty_required = float(k.quantity_required)
        bom_items.append(
            {
                "part_id": k.part_id,
                "part_pn": k.part.internal_pn,
                "part_name": k.part.name,
                "qty_required": qty_required,
                "qty_consumed": qty_consumed,
                "variance": qty_consumed - qty_required,
            }
        )
    # Unplanned consumptions (consumed but not in kit)
    unplanned = []
    for pid, qty in consumed_by_part.items():
        inv_c = next((c for c in consume_consumptions if c.inventory_record.part_id == pid), None)
        unplanned.append(
            {
                "part_id": pid,
                "part_pn": inv_c.inventory_record.part.internal_pn if inv_c else None,
                "part_name": inv_c.inventory_record.part.name if inv_c else "Unknown",
                "qty_consumed": qty,
            }
        )
    context["bom_items"] = bom_items
    context["unplanned_consumptions"] = unplanned

    # Material relevance (empty-state rule): declared intent decides where
    # content is expected; data always renders. Two predicates, one home each:
    # - kit_relevant (BOM tab): parts IN — a kit (procedure or step level) or
    #   actual consumptions. Reconciliation is meaningless without a kit side.
    # - material_relevant (KITTING tab): parts in OR out — the tab is also
    #   home to PRODUCTIONS and the FINALIZE PRODUCTION control, so an
    #   output-only procedure (ProcedureOutput, no kit) still shows it (F7);
    #   hiding it strands WIP productions with FINALIZE unreachable.
    kit_relevant = bool(
        kit_items
        or consumptions
        or any(vs.get("step_kit") for vs in context["version_steps_map"].values())
    )
    context["kit_relevant"] = kit_relevant
    context["material_relevant"] = kit_relevant or bool(productions or output_items)

    # Can finalize: instance completed + has WIP productions
    inst_status = instance.status.value if hasattr(instance.status, "value") else instance.status
    # Partials (_dockbar, _op_card, _rail) read inst_status from context —
    # only detail.html re-derives it with {% set %}.
    context["inst_status"] = inst_status
    has_wip = any(
        (p.status.value if hasattr(p.status, "value") else p.status) == "wip" for p in productions
    )
    context["can_finalize"] = inst_status == "completed" and has_wip

    # Linked issues — undispositioned holds sort first (rail ISSUES section)
    linked_issues = (
        db.query(Issue)
        .filter(
            Issue.procedure_instance_id == instance.id,
            Issue.deleted_at.is_(None),
        )
        .all()
    )
    disp_rank = {"undispositioned": 0, "open": 1, "dispositioned": 2, "closed": 3}
    linked_issues.sort(key=lambda i: (not i.is_blocking, disp_rank.get(i.disp_state, 4), -i.id))
    context["linked_issues"] = linked_issues

    # One authoritative answer per step execution for the COMPLETE and SKIP
    # controls: the full fold the server enforces (held scope + sequence for
    # COMPLETE; held scope + redline for SKIP), so a control never renders
    # active where the server would 400 it (F4/F5). Templates render the
    # controls from these — they do not re-derive gating. Keyed by
    # step_execution_id; a present, non-empty list means the control renders
    # inert (disabled) with the reason line beside it naming the blockers.
    complete_gate_by_se: dict[int, list[exec_flow.Blocker]] = {}
    skip_gate_by_se: dict[int, list[exec_flow.Blocker]] = {}
    hold_state = get_hold_state(db, instance.id)  # one pass; the same for every row
    for se in instance.step_executions:
        cg = exec_flow.complete_blockers(db, instance, se, hold_state)
        if cg:
            complete_gate_by_se[se.id] = cg
        sg = exec_flow.skip_blockers(db, instance, se, hold_state)
        if sg:
            skip_gate_by_se[se.id] = sg
    context["complete_gate_by_se"] = complete_gate_by_se
    context["skip_gate_by_se"] = skip_gate_by_se

    # Resolved-issue trace per step execution id: a dispositioned/closed issue
    # leaves a residual line on the step it was raised at — the hold clears,
    # the record stays.
    step_issue_history: dict[int, list[Issue]] = {}
    for iss in linked_issues:
        if iss.raised_step_id and iss.disp_state != "undispositioned":
            step_issue_history.setdefault(iss.raised_step_id, []).append(iss)
    context["step_issue_history"] = step_issue_history

    # Per-op aggregate of open NCs (op-level + any of its sub-steps) — the one
    # redline-visibility predicate: + REDLINE renders wherever this is
    # non-empty (step action rows and the dockbar overflow), and it populates
    # the modal's NC dropdown. Keyed by op.order; ad-hoc (redline) ops are
    # excluded below, so consumers never re-check is_ad_hoc.
    open_ncs_by_step_exec: dict[int, list[Issue]] = {}
    for iss in linked_issues:
        iss_type = iss.issue_type.value if hasattr(iss.issue_type, "value") else iss.issue_type
        iss_status = iss.status.value if hasattr(iss.status, "value") else iss.status
        if iss_type == "non_conformance" and iss.raised_step_id and iss_status != "closed":
            open_ncs_by_step_exec.setdefault(iss.raised_step_id, []).append(iss)
    open_ncs_by_op_order: dict[int, list[Issue]] = {}
    for op_data in ops + contingency_ops:
        op_step = op_data["step"]
        if op_data.get("is_ad_hoc"):
            continue
        op_exec = op_step.get("execution")
        bucket: list[Issue] = []
        if op_exec is not None:
            bucket.extend(open_ncs_by_step_exec.get(op_exec.id, []))
        for sub in op_data.get("sub_steps", []):
            sub_exec = sub.get("execution")
            if sub_exec is not None:
                bucket.extend(open_ncs_by_step_exec.get(sub_exec.id, []))
        if bucket:
            open_ncs_by_op_order[op_step["order"]] = bucket
    context["op_open_ncs_by_order"] = open_ncs_by_op_order

    # Gating lookup: top-level ops whose prerequisite ops haven't reached
    # a terminal status yet. Keyed by op.order → list of blocking step_number_str.
    exec_by_order = {se.step_number: se for se in instance.step_executions}
    gated_ops_by_order: dict[int, list[str]] = {}
    version_steps_for_gating = version.content.get("steps", []) if version else []
    for vs in version_steps_for_gating:
        if vs.get("level", 0) != 0:
            continue
        deps = vs.get("depends_on") or []
        if not deps:
            continue
        blockers: list[str] = []
        for dep_order in deps:
            prereq = exec_by_order.get(dep_order)
            if prereq is None:
                continue
            prereq_status = (
                prereq.status.value if hasattr(prereq.status, "value") else prereq.status
            )
            if prereq_status not in exec_flow.TERMINAL_STEP_STATUSES:
                blockers.append(prereq.step_number_str or str(dep_order))
        if blockers:
            gated_ops_by_order[vs["order"]] = blockers
    context["gated_ops_by_order"] = gated_ops_by_order

    # Reference documents on the procedure template (eng drawings, PDFs, etc.).
    from opal.db.models.attachment import Attachment as _Attachment

    context["reference_attachments"] = (
        db.query(_Attachment)
        .filter(
            _Attachment.procedure_id == instance.procedure_id,
            _Attachment.kind == "reference",
        )
        .order_by(_Attachment.original_filename.asc())
        .all()
    )

    # Meta tab extras: last-activity timestamp + flat data-capture audit rows.
    step_update_times = [
        se.updated_at for se in instance.step_executions if se.updated_at is not None
    ]
    candidate_times = [t for t in [instance.updated_at, *step_update_times] if t is not None]
    context["last_activity_at"] = max(candidate_times) if candidate_times else None

    data_rows = []
    for se in instance.step_executions:
        if not se.data_captured:
            continue
        step_num = se.step_number_str or str(se.step_number)
        by_name = se.completed_by_user.name if se.completed_by_user else None
        at = se.completed_at or se.updated_at
        for field, value in se.data_captured.items():
            if isinstance(value, bool):
                display = "YES" if value else "NO"
            elif value is None or value == "":
                display = "—"
            elif isinstance(value, list):
                # Multi-photo (and any future list-valued capture) — render
                # as "N image(s) (#12, #17)" rather than leaking the raw
                # storage format "[12, 17]" into the audit table.
                if value:
                    display = f"{len(value)} image(s) (" + ", ".join(f"#{v}" for v in value) + ")"
                else:
                    display = "—"
            else:
                display = str(value)
            data_rows.append(
                {
                    "step_number": step_num,
                    "step_sort": se.step_number,
                    "field": field,
                    "value": display,
                    "by": by_name,
                    "at": at,
                }
            )
    data_rows.sort(key=lambda r: (r["step_sort"], r["field"]))
    context["data_rows"] = data_rows

    # ---- Document layer: cursors, holds, evidence counts, presence ----

    cursors = exec_flow.instance_cursors(db, instance.id)
    cursor_user_ids = {c.user_id for c in cursors}
    cursor_users = (
        {u.id: u for u in db.query(User).filter(User.id.in_(cursor_user_ids)).all()}
        if cursor_user_ids
        else {}
    )
    cursors_by_se: dict[int, list[dict]] = {}
    for c in sorted(cursors, key=lambda c: c.focused_at):
        cursors_by_se.setdefault(c.step_execution_id, []).append(
            {"cursor": c, "user": cursor_users.get(c.user_id)}
        )
    context["cursors_by_se"] = cursors_by_se

    current_user = context.get("current_user")
    my_cursor = next((c for c in cursors if current_user and c.user_id == current_user.id), None)
    context["my_cursor_order"] = (
        my_cursor.step_execution.step_number
        if my_cursor is not None and my_cursor.step_execution is not None
        else None
    )

    # Bound hold points (issue_step_block) — hold COMPLETE of the bound step.
    bound_holds_by_se = exec_flow.bound_blocks_by_step(db, instance.id)
    context["bound_holds_by_se"] = bound_holds_by_se

    # Undispositioned NC holds per step execution id — derived from containment.
    holding_ncs_by_step = exec_flow.holding_ncs_by_step(db, instance.id)
    context["step_holding_ncs"] = holding_ncs_by_step

    # Undispositioned scope per op order — the op-card HELD BY blockline.
    # ONE derivation with the client updater (execdoc.js updateOpProgress):
    # raised/containment holds AND bound "resolve by" holds both fold in — a
    # bound hold on a child gates that child's COMPLETE, which holds the OP's
    # completion (check_instance_completion._row_held folds blockers_for_start),
    # so it belongs on the op header at SSR time too (F4).
    op_holds_by_order: dict[int, list] = {}
    for op_data in ops + contingency_ops:
        op_exec = op_data["step"].get("execution")
        bucket: list = []
        if op_exec is not None:
            bucket.extend(holding_ncs_by_step.get(op_exec.id, []))
            bucket.extend(bound_holds_by_se.get(op_exec.id, []))
        for sub in op_data.get("sub_steps", []):
            sub_exec = sub.get("execution")
            if sub_exec is not None:
                bucket.extend(holding_ncs_by_step.get(sub_exec.id, []))
                bucket.extend(bound_holds_by_se.get(sub_exec.id, []))
        seen_ids: set[int] = set()
        unique = [b for b in bucket if not (b.id in seen_ids or seen_ids.add(b.id))]
        if unique:
            op_holds_by_order[op_data["step"]["order"]] = unique
    context["op_holds_by_order"] = op_holds_by_order

    # strict_sequence display gating: sub-step N waits on its prior siblings.
    # Display-only — the claim API gate in core/execution_flow is authoritative.
    terminal = exec_flow.TERMINAL_STEP_STATUSES
    seq_blockers_by_order: dict[int, str] = {}
    for op_data in ops + contingency_ops:
        op_vs = context["version_steps_map"].get(op_data["step"]["order"]) or {}
        if not op_vs.get("strict_sequence"):
            continue
        for sub in op_data["sub_steps"]:
            if sub["status"] != "pending":
                continue
            unmet = [
                s["step_number"]
                for s in op_data["sub_steps"]
                if s["order"] < sub["order"] and s["status"] not in terminal
            ]
            if unmet:
                # The earliest unmet step is the one that matters; the rest
                # is a count, so a strict sequence never renders a pyramid.
                more = f" +{len(unmet) - 1}" if len(unmet) > 1 else ""
                seq_blockers_by_order[sub["order"]] = f"WAITING ON {unmet[0]}{more}"
    context["seq_blockers_by_order"] = seq_blockers_by_order

    # Evidence counts (⎙n) per step execution id.
    from opal.db.models.attachment import Attachment as _Att

    se_ids = [se.id for se in instance.step_executions]
    attach_counts: dict[int, int] = {}
    capture_attachments: dict[int, list] = {}
    if se_ids:
        for att in (
            db.query(_Att)
            .filter(_Att.step_execution_id.in_(se_ids))
            .order_by(_Att.created_at.desc())
            .all()
        ):
            attach_counts[att.step_execution_id] = attach_counts.get(att.step_execution_id, 0) + 1
            capture_attachments.setdefault(att.step_execution_id, []).append(att)
    context["attach_counts"] = attach_counts
    context["capture_attachments"] = capture_attachments

    # Step note trail per step execution id — chronological, append-only.
    context["step_notes_by_se"] = exec_flow.notes_by_step(db, se_ids)

    # Presence/progress snapshot for first paint; the page then polls /state.
    context["exec_state"] = exec_flow.build_execution_state(db, instance)

    # Active users for the issue capture's optional assignee.
    context["active_users"] = (
        db.query(User).filter(User.is_active.is_(True)).order_by(User.name.asc()).all()
    )

    return context


def set_bar_step(context: dict, step_order: int | None) -> None:
    """Resolve the docked bar's step: the requested order, else the session
    user's cursor, else the first actionable row of the document."""
    rows: list[tuple[dict, dict]] = []
    for op_data in context["ops"] + context["contingency_ops"]:
        rows.append((op_data, op_data["step"]))
        rows.extend((op_data, sub) for sub in op_data["sub_steps"])

    target = None
    if step_order is not None:
        target = next(((od, r) for od, r in rows if r["order"] == step_order), None)
    if target is None and context.get("my_cursor_order") is not None:
        target = next(((od, r) for od, r in rows if r["order"] == context["my_cursor_order"]), None)
    if target is None:
        leaf_rows = [(od, r) for od, r in rows if not od["sub_steps"] or r is not od["step"]]
        target = next(((od, r) for od, r in leaf_rows if r["status"] in _BAR_ACTIONABLE), None) or (
            leaf_rows[0] if leaf_rows else None
        )

    if target is None:
        context["bar_step"] = None
        return

    op_data, row = target
    vs = context["version_steps_map"].get(row["order"], {})
    is_op = row is op_data["step"]
    number = row["step_number"]
    if "." not in number and not is_op:
        number = f"{op_data['step']['step_number']}.{number}"
    context["bar_step"] = {
        "exec": row.get("execution"),
        "order": row["order"],
        "number": number,
        "title": row["title"],
        "status": row["status"],
        "is_op": is_op,
        "has_children": is_op and bool(op_data["sub_steps"]),
        "schema": row.get("required_data_schema") or vs.get("required_data_schema"),
        "caution": vs.get("caution"),
        "op_order": op_data["step"]["order"],
        "op_number": op_data["step"]["step_number"],
        "op_is_ad_hoc": bool(op_data.get("is_ad_hoc")),
        "op_open_ncs": (context.get("op_open_ncs_by_order") or {}).get(
            op_data["step"]["order"], []
        ),
        "step_kit": vs.get("step_kit") or [],
        # Single per-row gate answer (F4): the COMPLETE/SKIP controls render
        # from these, never re-derived in the template. Non-empty => control
        # inert (disabled), reason line beside it.
        "complete_blockers": (
            context.get("complete_gate_by_se", {}).get(row["execution"].id, [])
            if row.get("execution") is not None
            else []
        ),
        "skip_blockers": (
            context.get("skip_gate_by_se", {}).get(row["execution"].id, [])
            if row.get("execution") is not None
            else []
        ),
    }
