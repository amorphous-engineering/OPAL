"""Overview: one summary call for the operator landing page.

Everything on the page answers "what needs my attention now". Each list is
capped; its ``total`` says how many exist so the page can link to the full,
filtered list.
"""

from datetime import UTC, date, datetime, timedelta
from decimal import Decimal
from typing import Generic, TypeVar

from fastapi import APIRouter
from pydantic import BaseModel
from sqlalchemy import func
from sqlalchemy.orm import Session

from opal.api.deps import DbSession, RequiredUser
from opal.api.routes.audit import AuditEntry, audit_entries
from opal.core.notifications import blocked_instance_ids
from opal.db.models import (
    InventoryRecord,
    Issue,
    Part,
    ProcedureInstance,
    Purchase,
    PurchaseLine,
    Risk,
    StepExecution,
)
from opal.db.models.audit import AuditLog
from opal.db.models.execution import InstanceStatus, StepStatus
from opal.db.models.issue import IssueStatus
from opal.db.models.purchase import PurchaseStatus
from opal.risks.dispositions import OPEN_DISPOSITIONS

T = TypeVar("T")

router = APIRouter(prefix="/overview", tags=["overview"])

LIST_CAP = 8
EXPIRY_WINDOW_DAYS = 30
HIGH_RISK_SCORE = 12  # score > 12 is "high" (matches risk severity bands)
_PRIORITY_RANK = {"critical": 3, "high": 2, "medium": 1, "low": 0}
_DONE_STEPS = (StepStatus.COMPLETED, StepStatus.SIGNED_OFF, StepStatus.SKIPPED)


class IssueRow(BaseModel):
    issue_number: str
    title: str
    priority: str
    issue_type: str
    holding: bool
    assignee: str | None
    mine: bool
    href: str


class ExecutionRow(BaseModel):
    label: str
    procedure: str | None
    status: str
    steps_done: int
    steps_total: int
    blocked: bool
    overdue: bool
    target_completion_at: datetime | None
    mine: bool
    href: str


class LowStockRow(BaseModel):
    part_number: str | None
    name: str
    on_hand: float
    reorder_point: float
    uom: str
    href: str


class PurchaseRow(BaseModel):
    reference: str
    supplier: str
    status: str
    target_date: date | None
    overdue: bool
    lines_open: int
    href: str


class StockAttentionRow(BaseModel):
    opal_number: str | None
    part_number: str | None
    part_name: str
    kind: str  # calibration_overdue | expired | expiring
    due: str  # ISO 8601 date or instant
    href: str


class RiskRow(BaseModel):
    risk_number: str
    title: str
    score: int
    disposition: str
    href: str


class Capped(BaseModel, Generic[T]):
    items: list[T]
    total: int


class IssueCounts(BaseModel):
    open: int
    critical: int
    high: int
    medium: int
    low: int
    unassigned: int
    mine: int


class OverviewResponse(BaseModel):
    issue_counts: IssueCounts
    issues: Capped[IssueRow]
    executions: Capped[ExecutionRow]
    low_stock: Capped[LowStockRow]
    purchases: Capped[PurchaseRow]
    stock_attention: Capped[StockAttentionRow]
    risks: Capped[RiskRow]
    activity: list[AuditEntry]


def _enum(v: object) -> str:
    return v.value if hasattr(v, "value") else str(v)


def _issues(db: Session, user_id: int) -> tuple[IssueCounts, Capped[IssueRow]]:
    rows = (
        db.query(Issue)
        .filter(Issue.deleted_at.is_(None), Issue.status == IssueStatus.OPEN)
        .order_by(Issue.created_at.desc())
        .all()
    )
    by_priority = {"critical": 0, "high": 0, "medium": 0, "low": 0}
    for r in rows:
        by_priority[_enum(r.priority)] = by_priority.get(_enum(r.priority), 0) + 1
    counts = IssueCounts(
        open=len(rows),
        unassigned=sum(1 for r in rows if r.assigned_to_id is None),
        mine=sum(1 for r in rows if r.assigned_to_id == user_id),
        **by_priority,
    )
    # Mine first, then urgency, then newest (list is already newest first; sort is stable).
    rows.sort(
        key=lambda r: (r.assigned_to_id != user_id, -_PRIORITY_RANK.get(_enum(r.priority), 1))
    )
    items = [
        IssueRow(
            issue_number=r.issue_number,
            title=r.title,
            priority=_enum(r.priority),
            issue_type=_enum(r.issue_type),
            holding=_enum(r.containment) != "advisory" and r.dispositioned_at is None,
            assignee=r.assigned_to.name if r.assigned_to else None,
            mine=r.assigned_to_id == user_id,
            href=f"/issues/{r.id}",
        )
        for r in rows[:LIST_CAP]
    ]
    return counts, Capped(items=items, total=len(rows))


def _executions(db: Session, user_id: int) -> Capped[ExecutionRow]:
    active = (
        db.query(ProcedureInstance)
        .filter(ProcedureInstance.status.in_([InstanceStatus.IN_WORK, InstanceStatus.CUT]))
        .all()
    )
    ids = [i.id for i in active]
    totals: dict[int, int] = {}
    done: dict[int, int] = {}
    if ids:
        for iid, n in (
            db.query(StepExecution.instance_id, func.count())
            .filter(StepExecution.instance_id.in_(ids))
            .group_by(StepExecution.instance_id)
        ):
            totals[iid] = n
        for iid, n in (
            db.query(StepExecution.instance_id, func.count())
            .filter(StepExecution.instance_id.in_(ids), StepExecution.status.in_(_DONE_STEPS))
            .group_by(StepExecution.instance_id)
        ):
            done[iid] = n
    blocked = blocked_instance_ids(db, ids)
    now = datetime.now(UTC)

    def is_overdue(i: ProcedureInstance) -> bool:
        t = i.target_completion_at
        if t is None:
            return False
        return (t if t.tzinfo else t.replace(tzinfo=UTC)) < now

    def is_mine(i: ProcedureInstance) -> bool:
        return i.started_by_id == user_id or any(
            p.get("user_id") == user_id for p in (i.participants or [])
        )

    rows = [
        ExecutionRow(
            label=i.work_order_number or (i.procedure.name if i.procedure else "Execution"),
            procedure=i.procedure.name if i.procedure and i.work_order_number else None,
            status=_enum(i.status),
            steps_done=done.get(i.id, 0),
            steps_total=totals.get(i.id, 0),
            blocked=i.id in blocked,
            overdue=is_overdue(i),
            target_completion_at=i.target_completion_at,
            mine=is_mine(i),
            href=f"/executions/{i.id}",
        )
        for i in active
    ]
    # Needs attention first: blocked, then overdue, then mine, then in work before cut.
    rows.sort(key=lambda r: (not r.blocked, not r.overdue, not r.mine, r.status != "in_work"))
    return Capped(items=rows[:LIST_CAP], total=len(rows))


def _on_hand_subquery(db: Session):
    return (
        db.query(
            InventoryRecord.part_id.label("part_id"),
            func.coalesce(func.sum(InventoryRecord.quantity), 0).label("qty"),
        )
        .group_by(InventoryRecord.part_id)
        .subquery()
    )


def _low_stock(db: Session) -> Capped[LowStockRow]:
    sub = _on_hand_subquery(db)
    on_hand = func.coalesce(sub.c.qty, 0)
    query = (
        db.query(Part, on_hand)
        .outerjoin(sub, sub.c.part_id == Part.id)
        .filter(Part.deleted_at.is_(None), Part.reorder_point.isnot(None))
        .filter(on_hand < Part.reorder_point)
    )
    total = query.count()
    # Furthest below its reorder point first.
    rows = query.order_by((on_hand - Part.reorder_point).asc(), Part.id).limit(LIST_CAP).all()
    return Capped(
        items=[
            LowStockRow(
                part_number=p.internal_pn,
                name=p.name,
                on_hand=float(qty or Decimal(0)),
                reorder_point=float(p.reorder_point),
                uom=p.unit_of_measure,
                href=f"/parts/{p.id}",
            )
            for p, qty in rows
        ],
        total=total,
    )


def _purchases(db: Session) -> Capped[PurchaseRow]:
    pos = (
        db.query(Purchase)
        .filter(Purchase.status.in_([PurchaseStatus.ORDERED, PurchaseStatus.PARTIAL]))
        .all()
    )
    open_lines: dict[int, int] = {}
    if pos:
        for pid, n in (
            db.query(PurchaseLine.purchase_id, func.count())
            .filter(
                PurchaseLine.purchase_id.in_([p.id for p in pos]),
                PurchaseLine.qty_received < PurchaseLine.qty_ordered,
            )
            .group_by(PurchaseLine.purchase_id)
        ):
            open_lines[pid] = n
    pos.sort(key=lambda p: (p.target_date is None, p.target_date or date.max, p.id))
    return Capped(
        items=[
            PurchaseRow(
                reference=p.reference or f"PO-{p.id}",
                supplier=p.supplier_rel.name if p.supplier_rel else p.supplier,
                status=_enum(p.status),
                target_date=p.target_date,
                overdue=p.is_overdue,
                lines_open=open_lines.get(p.id, 0),
                href=f"/purchases/{p.id}",
            )
            for p in pos[:LIST_CAP]
        ],
        total=len(pos),
    )


def _stock_attention(db: Session) -> Capped[StockAttentionRow]:
    today = date.today()
    now = datetime.now(UTC)
    horizon = today + timedelta(days=EXPIRY_WINDOW_DAYS)
    base = db.query(InventoryRecord).join(Part).filter(Part.deleted_at.is_(None))
    cal = (
        base.filter(
            Part.is_tooling.is_(True),
            InventoryRecord.calibration_due_at.isnot(None),
            InventoryRecord.calibration_due_at <= now,
        )
        .order_by(InventoryRecord.calibration_due_at)
        .all()
    )
    exp = (
        base.filter(
            InventoryRecord.quantity > 0,
            InventoryRecord.expiration_date.isnot(None),
            InventoryRecord.expiration_date <= horizon,
        )
        .order_by(InventoryRecord.expiration_date)
        .all()
    )

    def row(r: InventoryRecord, kind: str, due: str) -> StockAttentionRow:
        return StockAttentionRow(
            opal_number=r.opal_number,
            part_number=r.part.internal_pn,
            part_name=r.part.name,
            kind=kind,
            due=due,
            href=f"/inventory/opal/{r.opal_number}" if r.opal_number else f"/parts/{r.part_id}",
        )

    rows = [row(r, "calibration_overdue", r.calibration_due_at.isoformat()) for r in cal] + [
        row(
            r, "expired" if r.expiration_date < today else "expiring", r.expiration_date.isoformat()
        )
        for r in exp
    ]
    return Capped(items=rows[:LIST_CAP], total=len(rows))


def _risks(db: Session) -> Capped[RiskRow]:
    score = Risk.probability * Risk.impact
    query = db.query(Risk).filter(
        Risk.deleted_at.is_(None), Risk.disposition.in_(OPEN_DISPOSITIONS), score > HIGH_RISK_SCORE
    )
    total = query.count()
    rows = query.order_by(score.desc(), Risk.id).limit(LIST_CAP).all()
    return Capped(
        items=[
            RiskRow(
                risk_number=r.risk_number,
                title=r.title,
                score=r.probability * r.impact,
                disposition=_enum(r.disposition),
                href=f"/risks/{r.id}",
            )
            for r in rows
        ],
        total=total,
    )


@router.get("", response_model=OverviewResponse)
def get_overview(db: DbSession, user: RequiredUser) -> OverviewResponse:
    """Everything the landing page shows, in one call."""
    counts, issues = _issues(db, user.id)
    recent = db.query(AuditLog).order_by(AuditLog.timestamp.desc(), AuditLog.id.desc()).limit(15)
    return OverviewResponse(
        issue_counts=counts,
        issues=issues,
        executions=_executions(db, user.id),
        low_stock=_low_stock(db),
        purchases=_purchases(db),
        stock_attention=_stock_attention(db),
        risks=_risks(db),
        activity=audit_entries(db, recent.all()),
    )
