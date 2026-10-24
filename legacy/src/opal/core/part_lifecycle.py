"""Part identity lifecycle: draft -> active.

Identity locks at first dependency — but activation is always a deliberate
act, never a side effect. Physical/financial writes refuse draft parts with
a structured error (DraftPartsBlocked) naming the remedy; the requirements
lifecycle (se/lifecycle.py) is the pattern this rhymes with.

Functions here never commit; callers own the transaction and audit logging.
"""

from collections.abc import Iterable
from datetime import UTC, datetime

from sqlalchemy.orm import Session

from opal.db.models import (
    BOMLine,
    InventoryRecord,
    Issue,
    Kit,
    Part,
    PartRequirement,
    ProcedureOutput,
    PurchaseLine,
    StepKit,
    SupplierPart,
    TestTemplate,
)

PART_DRAFT = "draft"
PART_ACTIVE = "active"

PART_LIFECYCLE_STATES = (PART_DRAFT, PART_ACTIVE)


class PartLifecycleError(Exception):
    """An operation is illegal for the part's lifecycle state."""


class DraftPartsBlocked(Exception):
    """A physical/financial commitment referenced draft parts.

    No state transition ever occurs as a side effect of referencing an
    object — the caller surfaces this as a blocker with an inline remedy.
    """

    def __init__(self, action: str, parts: list[Part]):
        self.action = action
        self.parts = parts
        pns = ", ".join(p.internal_pn or f"part {p.id}" for p in parts)
        super().__init__(f"{len(parts)} draft part(s) block {action}: {pns}")

    def payload(self, remedy: str | None = None) -> dict:
        """Structured error shared by the HTTP 409 detail and MCP JSON error."""
        return {
            "error": "draft_parts_blocked",
            "action": self.action,
            "message": str(self),
            "draft_parts": [
                {"id": p.id, "internal_pn": p.internal_pn, "name": p.name} for p in self.parts
            ],
            "remedy": remedy or "POST /api/parts/{id}/activate for each draft part, then retry",
        }


def activate_part(db: Session, part: Part, user_id: int | None, cause: str) -> Part:
    """Activate a draft part, locking its identity permanently.

    Caller does log_update(db, part, old_values, user_id) and commits.
    """
    if part.deleted_at is not None:
        raise PartLifecycleError(f"{part.internal_pn or part.id} is deleted and cannot activate")
    if part.lifecycle_state != PART_DRAFT:
        raise PartLifecycleError(f"{part.internal_pn or part.id} is already {part.lifecycle_state}")
    part.lifecycle_state = PART_ACTIVE
    part.activated_at = datetime.now(UTC)
    part.activated_by_id = user_id
    part.activation_cause = cause
    db.flush()
    return part


def ensure_parts_active(db: Session, part_ids: Iterable[int], action: str) -> None:
    """Raise DraftPartsBlocked if any of the given parts is a draft."""
    ids = {pid for pid in part_ids if pid is not None}
    if not ids:
        return
    drafts = (
        db.query(Part)
        .filter(Part.id.in_(ids), Part.lifecycle_state == PART_DRAFT)
        .order_by(Part.id)
        .all()
    )
    if drafts:
        raise DraftPartsBlocked(action, drafts)


def draft_parts_in(parts: Iterable[Part]) -> list[Part]:
    """The draft subset of an iterable of parts, deduplicated, id order."""
    seen: dict[int, Part] = {}
    for part in parts:
        if part.lifecycle_state == PART_DRAFT:
            seen.setdefault(part.id, part)
    return [seen[pid] for pid in sorted(seen)]


def ensure_identity_mutable(part: Part) -> None:
    """Guard PN/tier edits: an active part's identity is immutable forever."""
    if part.lifecycle_state != PART_DRAFT:
        raise PartLifecycleError(
            f"{part.internal_pn or part.id} is active — internal_pn and tier are "
            "immutable (supersession is the only path to a new identity)"
        )


def reference_counts(db: Session, part: Part) -> dict[str, int]:
    """Nonzero counts of everything that references this part.

    Includes design-time references (BOM edges, kits, allocations): referenced
    things leave the world by state transition, stillborn things by soft delete.
    """
    counters = {
        "bom_components": db.query(BOMLine).filter(BOMLine.assembly_id == part.id),
        "used_in_assemblies": db.query(BOMLine).filter(BOMLine.component_id == part.id),
        "kits": db.query(Kit).filter(Kit.part_id == part.id),
        "step_kits": db.query(StepKit).filter(StepKit.part_id == part.id),
        "requirement_allocations": db.query(PartRequirement).filter(
            PartRequirement.part_id == part.id
        ),
        "issues": db.query(Issue).filter(Issue.part_id == part.id),
        "procedure_outputs": db.query(ProcedureOutput).filter(ProcedureOutput.part_id == part.id),
        "supplier_entries": db.query(SupplierPart).filter(SupplierPart.part_id == part.id),
        "test_templates": db.query(TestTemplate).filter(TestTemplate.part_id == part.id),
        "child_parts": db.query(Part).filter(Part.parent_id == part.id, Part.deleted_at.is_(None)),
        "inventory_records": db.query(InventoryRecord).filter(InventoryRecord.part_id == part.id),
        "purchase_lines": db.query(PurchaseLine).filter(PurchaseLine.part_id == part.id),
    }
    return {name: count for name, query in counters.items() if (count := query.count())}


def is_referenced(db: Session, part: Part) -> bool:
    """True if anything at all references this part."""
    return bool(reference_counts(db, part))
