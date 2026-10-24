"""Workcenter workload: which steps default to a workcenter and which are queued at it."""

from collections import Counter
from dataclasses import dataclass
from datetime import datetime

from sqlalchemy.orm import Session, joinedload

from opal.db.models import Workcenter
from opal.db.models.execution import InstanceStatus, ProcedureInstance, StepStatus
from opal.db.models.procedure import MasterProcedure, ProcedureStep

OPEN_INSTANCE_STATUSES = (InstanceStatus.CUT.value, InstanceStatus.IN_WORK.value)
QUEUED_STEP_STATUSES = (
    StepStatus.PENDING.value,
    StepStatus.IN_PROGRESS.value,
    StepStatus.ON_HOLD.value,
    StepStatus.AWAITING_SIGNOFF.value,
)


@dataclass
class QueuedStep:
    """One step of an open execution that is assigned to a workcenter and not yet done."""

    workcenter_id: int
    instance_id: int
    work_order_number: str | None
    procedure_id: int
    procedure_name: str
    instance_status: str
    priority: int
    target_completion_at: datetime | None
    step_number_str: str
    step_title: str | None
    step_status: str


def _value(x: object) -> str:
    return str(getattr(x, "value", x))


def _natural(number: str) -> tuple[tuple[int, str], ...]:
    """Sort key so 11.2 comes before 11.10 (numbers by value, labels like C1 by text)."""
    return tuple((int(p), "") if p.isdigit() else (0, p) for p in number.split("."))


def queued_steps(db: Session, workcenter_id: int | None = None) -> list[QueuedStep]:
    """Unfinished steps of open executions, grouped by the workcenter they run at.

    A step's workcenter is the one recorded on the execution row when set, otherwise the
    default frozen in the executed version's snapshot.
    """
    instances = (
        db.query(ProcedureInstance)
        .options(
            joinedload(ProcedureInstance.version),
            joinedload(ProcedureInstance.procedure),
            joinedload(ProcedureInstance.step_executions),
        )
        .filter(ProcedureInstance.status.in_(OPEN_INSTANCE_STATUSES))
        .all()
    )
    out: list[QueuedStep] = []
    for inst in instances:
        snapshot = {s.get("order"): s for s in inst.version.content.get("steps", [])}
        for se in inst.step_executions:
            if _value(se.status) not in QUEUED_STEP_STATUSES:
                continue
            snap = snapshot.get(se.step_number, {})
            wc_id = se.workcenter_id or snap.get("workcenter_id")
            if wc_id is None or (workcenter_id is not None and wc_id != workcenter_id):
                continue
            out.append(
                QueuedStep(
                    workcenter_id=wc_id,
                    instance_id=inst.id,
                    work_order_number=inst.work_order_number,
                    procedure_id=inst.procedure_id,
                    procedure_name=inst.procedure.name,
                    instance_status=_value(inst.status),
                    priority=inst.priority,
                    target_completion_at=inst.target_completion_at,
                    step_number_str=se.step_number_str,
                    step_title=se.title or snap.get("title"),
                    step_status=_value(se.status),
                )
            )
    out.sort(
        key=lambda q: (
            -q.priority,
            q.target_completion_at is None,
            q.target_completion_at.isoformat() if q.target_completion_at else "",
            q.work_order_number or "",
            q.instance_id,
            _natural(q.step_number_str),
        )
    )
    return out


def queued_counts(db: Session) -> Counter[int]:
    """Queued step count per workcenter id."""
    return Counter(q.workcenter_id for q in queued_steps(db))


def default_steps(db: Session, workcenter: Workcenter) -> list[ProcedureStep]:
    """Master procedure steps whose default workcenter is this one."""
    return (
        db.query(ProcedureStep)
        .join(MasterProcedure, ProcedureStep.procedure_id == MasterProcedure.id)
        .options(joinedload(ProcedureStep.procedure))
        .filter(ProcedureStep.workcenter_id == workcenter.id, MasterProcedure.deleted_at.is_(None))
        .order_by(MasterProcedure.name, ProcedureStep.order)
        .all()
    )
