"""Containment-derived hold computation.

Holds are never stored — they are derived, at the commitment moments
(COMPLETE, START, SKIP, instance close-out), from undispositioned issues
and their containment scope:

    containment   while undispositioned…
    step          the raised/bound step cannot COMPLETE (and its OP cannot
                  COMPLETE over it); a bound future step ("resolve by")
                  cannot COMPLETE either — there is no start moment to gate
    op            every step in the OP may run, but the OP cannot COMPLETE
    wo            the work order cannot COMPLETE/close out
    advisory      blocks nothing

Signing a disposition releases every containment the issue holds, live:
there is no stored state to flip back.
"""

from dataclasses import dataclass, field

from sqlalchemy import or_
from sqlalchemy.orm import Session

from opal.db.models.execution import ProcedureInstance, StepExecution
from opal.db.models.issue import Containment, Issue, IssueStatus


def enum_value(obj: object) -> str | None:
    """Unwrap a potentially-enum attribute to its string value.

    One home: SQLite rows come back as enums or as plain strings depending
    on how they were loaded, and every layer needs the string."""
    if obj is None:
        return None
    return obj.value if hasattr(obj, "value") else obj  # type: ignore[return-value]


_val = enum_value


def blocking_issues_for_instance(db: Session, instance_id: int) -> list[Issue]:
    """Undispositioned, non-advisory issues linked to this work order."""
    return (
        db.query(Issue)
        .filter(
            Issue.procedure_instance_id == instance_id,
            Issue.deleted_at.is_(None),
            Issue.status != IssueStatus.CLOSED,
            Issue.containment != Containment.ADVISORY,
            or_(Issue.disposition_type.is_(None), Issue.dispositioned_at.is_(None)),
        )
        .order_by(Issue.id)
        .all()
    )


@dataclass
class HoldState:
    """Derived blocking state for one work order."""

    # step_execution_id -> issues blocking that step's COMPLETE (and SKIP)
    complete_blocked: dict[int, list[Issue]] = field(default_factory=dict)
    # step_execution_id -> issues holding a bound future step ("resolve by").
    # Named start_blocked for its R2 lineage; under the focus model these
    # gate the bound step's COMPLETE (execution_flow folds them in).
    start_blocked: dict[int, list[Issue]] = field(default_factory=dict)
    # op-level step_execution_id -> issues blocking that OP's COMPLETE
    op_complete_blocked: dict[int, list[Issue]] = field(default_factory=dict)
    # issues blocking the work order's completion/close-out
    wo_blocked: list[Issue] = field(default_factory=list)

    def blockers_for_complete(self, step_exec: StepExecution) -> list[Issue]:
        """Issues that make this row's COMPLETE (or SKIP) absent."""
        blockers = list(self.complete_blocked.get(step_exec.id, []))
        if step_exec.level == 0:
            seen = {i.id for i in blockers}
            blockers += [
                i for i in self.op_complete_blocked.get(step_exec.id, []) if i.id not in seen
            ]
        return blockers

    def blockers_for_start(self, step_exec: StepExecution) -> list[Issue]:
        """Boundary holds bound to this row — gate its COMPLETE (no start
        moment exists to gate)."""
        return list(self.start_blocked.get(step_exec.id, []))


def get_hold_state(db: Session, instance_id: int) -> HoldState:
    """Compute the full blocking state for a work order."""
    state = HoldState()
    issues = blocking_issues_for_instance(db, instance_id)
    if not issues:
        return state

    steps = db.query(StepExecution).filter(StepExecution.instance_id == instance_id).all()
    by_id = {se.id: se for se in steps}
    op_by_number = {se.step_number: se for se in steps if se.level == 0}

    def op_row_for(step_exec: StepExecution) -> StepExecution | None:
        if step_exec.level == 0:
            return step_exec
        if step_exec.parent_step_order is not None:
            return op_by_number.get(step_exec.parent_step_order)
        return None

    for issue in issues:
        containment = _val(issue.containment)
        anchor = by_id.get(issue.containment_step_id) or by_id.get(issue.raised_step_id)

        if containment == Containment.WO.value:
            state.wo_blocked.append(issue)
            continue

        if anchor is None:
            # step/op containment with no resolvable step in this WO holds the
            # WO itself rather than silently blocking nothing.
            state.wo_blocked.append(issue)
            continue

        if containment == Containment.OP.value:
            op_row = op_row_for(anchor)
            if op_row is not None:
                state.op_complete_blocked.setdefault(op_row.id, []).append(issue)
            continue

        # containment == step
        bound_elsewhere = (
            issue.containment_step_id is not None
            and issue.raised_step_id is not None
            and issue.containment_step_id != issue.raised_step_id
        )
        if bound_elsewhere:
            # "resolve by 3.7": work continues up to the boundary, which
            # cannot COMPLETE until disposition.
            state.start_blocked.setdefault(anchor.id, []).append(issue)
        else:
            state.complete_blocked.setdefault(anchor.id, []).append(issue)
            op_row = op_row_for(anchor)
            if op_row is not None and op_row.id != anchor.id:
                state.op_complete_blocked.setdefault(op_row.id, []).append(issue)

    return state


def _step_label(step_exec: StepExecution) -> str:
    return step_exec.step_number_str or str(step_exec.step_number)


def _op_label(step_exec: StepExecution) -> str:
    return f"OP {_step_label(step_exec)}"


def scope_label(step_exec: StepExecution) -> str:
    """Scope name, never a bare number: 'OP 4' for op rows, '4.1' for steps."""
    return _op_label(step_exec) if step_exec.level == 0 else _step_label(step_exec)


def holding_readout(db: Session, issue: Issue) -> list[dict]:
    """What this issue is stopping, as [{label, scope, href}] — the HOLDING
    panel, the disposition confirm sentence, and MCP holds all read from here.
    Labels are scope + verb ('OP 4 COMPLETE', '4.1 COMPLETE')."""
    if not issue.is_blocking:
        return []

    instance_id = issue.procedure_instance_id
    containment = _val(issue.containment)

    instance = (
        db.query(ProcedureInstance).filter(ProcedureInstance.id == instance_id).first()
        if instance_id
        else None
    )
    if instance is None:
        return []

    wo_label = instance.work_order_number or f"WO #{instance.id}"

    def exec_href(op_order: int | None = None) -> str:
        base = f"/executions/{instance.id}"
        return f"{base}?op={op_order}" if op_order is not None else base

    anchor = None
    anchor_id = issue.containment_step_id or issue.raised_step_id
    if anchor_id is not None:
        anchor = db.query(StepExecution).filter(StepExecution.id == anchor_id).first()

    if containment == Containment.WO.value or anchor is None:
        return [{"label": f"{wo_label} COMPLETE", "scope": wo_label, "href": exec_href()}]

    op_row = anchor
    if anchor.level != 0 and anchor.parent_step_order is not None:
        op_row = (
            db.query(StepExecution)
            .filter(
                StepExecution.instance_id == instance.id,
                StepExecution.step_number == anchor.parent_step_order,
                StepExecution.level == 0,
            )
            .first()
        ) or anchor

    if containment == Containment.OP.value:
        return [
            {
                "label": f"{_op_label(op_row)} COMPLETE",
                "scope": _op_label(op_row),
                "href": exec_href(op_row.step_number),
            }
        ]

    # step containment
    bound_elsewhere = (
        issue.containment_step_id is not None
        and issue.raised_step_id is not None
        and issue.containment_step_id != issue.raised_step_id
    )
    if bound_elsewhere:
        return [
            {
                "label": f"{scope_label(anchor)} COMPLETE",
                "scope": scope_label(anchor),
                "href": exec_href(op_row.step_number),
            }
        ]

    targets = [
        {
            "label": f"{scope_label(anchor)} COMPLETE",
            "scope": scope_label(anchor),
            "href": exec_href(op_row.step_number),
        }
    ]
    if op_row.id != anchor.id:
        targets.append(
            {
                "label": f"{_op_label(op_row)} COMPLETE",
                "scope": _op_label(op_row),
                "href": exec_href(op_row.step_number),
            }
        )
    return targets


def get_holds_payload(db: Session, instance_id: int) -> dict:
    """The controller's blocking state as JSON: every undispositioned issue on
    this work order and what it blocks."""
    issues = blocking_issues_for_instance(db, instance_id)
    holds = []
    for issue in issues:
        holds.append(
            {
                "issue_id": issue.id,
                "issue_number": issue.issue_number,
                "title": issue.title,
                "priority": _val(issue.priority),
                "containment": _val(issue.containment),
                "raised_step_id": issue.raised_step_id,
                "containment_step_id": issue.containment_step_id,
                "blocks": [t["label"] for t in holding_readout(db, issue)],
            }
        )
    return {"instance_id": instance_id, "held": bool(holds), "holds": holds}
