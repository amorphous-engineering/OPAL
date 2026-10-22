"""Read models for the requirements UI: tree, dossier, queue, baseline events, summary.

Pure queries and shaping, no commits. The API routes call these so the web
client never re-derives business facts (verification status, staleness,
what a baseline event changed).

Allocations (PartRequirement) point at a specific revision row. A revision
chain shares one req_number, so every view here groups allocations by
req_number: a requirement's parts survive a revise, and an allocation made
against an older revision is reported as such (``against_revision``) rather
than silently disappearing from the current revision.
"""

from datetime import UTC, datetime
from typing import Any

from sqlalchemy.orm import Session

from opal.db.base import LifecycleState
from opal.db.models import (
    BaselineEvent,
    BaselineEventItem,
    Part,
    PartRequirement,
    Requirement,
    User,
)
from opal.se.dashboard import old_block_lint_drafts, overdue_tbrs, stale_requirements
from opal.se.lint import LintFinding, lint_requirement_row
from opal.se.readiness import readiness, ready_requirement_ids
from opal.se.redline import redline_segments

LIVE_STATES = (
    LifecycleState.DRAFT.value,
    LifecycleState.PRELIMINARY.value,
    LifecycleState.BASELINED.value,
)
#: Allocation statuses that count as "dealt with" for verification purposes.
_SATISFIED = ("verified", "waived")


def verification_status(allocations: list[dict[str, Any]]) -> str:
    """Roll allocation statuses into one word.

    unallocated  no part carries the requirement
    not_applicable  every allocation is marked not applicable
    verified     every applicable allocation is verified or waived
    partial      some applicable allocations are dealt with, some open
    open         none dealt with
    """
    statuses = [a["status"] for a in allocations]
    if not statuses:
        return "unallocated"
    applicable = [s for s in statuses if s != "not_applicable"]
    if not applicable:
        return "not_applicable"
    done = sum(1 for s in applicable if s in _SATISFIED)
    if done == len(applicable):
        return "verified"
    return "partial" if done else "open"


def _finding_dicts(findings: list[LintFinding]) -> list[dict[str, Any]]:
    out = []
    for f in findings:
        d = f.to_dict()
        if "span" in d:
            d["span"] = list(d["span"])
        out.append(d)
    return out


def allocations_by_number(db: Session) -> dict[str, list[dict[str, Any]]]:
    """Every allocation of a first-class requirement, keyed by req_number."""
    rows = (
        db.query(PartRequirement, Part, Requirement)
        .join(Part, PartRequirement.part_id == Part.id)
        .join(Requirement, PartRequirement.requirement_ref_id == Requirement.id)
        .filter(Part.deleted_at.is_(None))
        .order_by(Part.name)
        .all()
    )
    result: dict[str, list[dict[str, Any]]] = {}
    for pr, part, req in rows:
        result.setdefault(req.req_number, []).append(_allocation_dict(pr, part, req))
    return result


def _allocation_dict(pr: PartRequirement, part: Part, req: Requirement) -> dict[str, Any]:
    return {
        "id": pr.id,
        "part_id": part.id,
        "part_name": part.name,
        "internal_pn": part.internal_pn,
        "status": pr.status,
        "notes": pr.notes,
        "verified_at": pr.verified_at,
        "verified_by": pr.verified_by.name if pr.verified_by else None,
        "against_revision": req.revision,
    }


def _live_rows(db: Session) -> list[Requirement]:
    return (
        db.query(Requirement)
        .filter(
            Requirement.deleted_at.is_(None),
            Requirement.lifecycle_state != LifecycleState.SUPERSEDED.value,
        )
        .order_by(Requirement.req_number, Requirement.revision)
        .all()
    )


# ============ Tree ============


def requirement_tree(db: Session) -> dict[str, Any]:
    """Flat tree rows (client nests them by parent_id) with trace and lint facts.

    Orphans (parent superseded, cancelled-away or deleted) surface as roots,
    flagged so the UI can say why.
    """
    rows = _live_rows(db)
    ids = {r.id for r in rows}
    alloc = allocations_by_number(db)
    items = []
    for r in rows:
        allocations = alloc.get(r.req_number, [])
        lint = _finding_dicts(lint_requirement_row(r)) if r.is_mutable else []
        items.append(
            {
                "id": r.id,
                "req_number": r.req_number,
                "revision": r.revision,
                "lifecycle_state": r.lifecycle_state,
                "title": r.title,
                "statement": r.statement,
                "rationale": r.rationale,
                "level": r.level,
                "category": r.category,
                "verification_method": r.verification_method,
                "tbd": r.tbd,
                "tbr": r.tbr,
                "stale": r.stale,
                "parent_id": r.parent_id if r.parent_id in ids else None,
                "orphan": r.parent_id is not None and r.parent_id not in ids,
                "updated_at": r.updated_at,
                "lint": lint,
                "parts": [
                    {"part_id": a["part_id"], "name": a["part_name"], "status": a["status"]}
                    for a in allocations
                ],
                "verification": verification_status(allocations),
            }
        )
    return {"items": items, "total": len(items), "queue_count": len(ready_requirement_ids(db))}


# ============ Dossier ============


def requirement_dossier(db: Session, req: Requirement) -> dict[str, Any]:
    """Everything the requirement page shows, in one payload."""
    chain: list[Requirement] = []
    seen = {req.id}
    cursor = req.parent
    while cursor is not None and cursor.id not in seen:
        chain.append(cursor)
        seen.add(cursor.id)
        cursor = cursor.parent

    children = (
        db.query(Requirement)
        .filter(
            Requirement.parent_id == req.id,
            Requirement.deleted_at.is_(None),
            Requirement.lifecycle_state != LifecycleState.SUPERSEDED.value,
        )
        .order_by(Requirement.req_number)
        .all()
    )
    revisions = (
        db.query(Requirement)
        .filter(Requirement.req_number == req.req_number, Requirement.deleted_at.is_(None))
        .order_by(Requirement.revision)
        .all()
    )
    own_allocations = allocations_by_number(db).get(req.req_number, [])
    baselined_by = db.get(User, req.baselined_by_id) if req.baselined_by_id else None
    predecessor = db.get(Requirement, req.supersedes_id) if req.supersedes_id else None
    baseline_events = [
        {
            "event_id": item.event_id,
            "label": item.event.label,
            "created_at": item.event.created_at,
            "revision": item.requirement.revision,
        }
        for r in revisions
        for item in db.query(BaselineEventItem).filter_by(requirement_id=r.id).all()
    ]
    return {
        "id": req.id,
        "req_number": req.req_number,
        "revision": req.revision,
        "lifecycle_state": req.lifecycle_state,
        "title": req.title,
        "statement": req.statement,
        "rationale": req.rationale,
        "category": req.category,
        "level": req.level,
        "parent_id": req.parent_id,
        "verification_method": req.verification_method,
        "tbd": req.tbd,
        "tbr": req.tbr,
        "tbr_owner_id": req.tbr_owner_id,
        "tbr_owner": req.tbr_owner.name if req.tbr_owner else None,
        "tbr_due": req.tbr_due,
        "stale": req.stale,
        "baselined_at": req.baselined_at,
        "baselined_by": baselined_by.name if baselined_by else None,
        "supersedes_id": req.supersedes_id,
        "predecessor_revision": predecessor.revision if predecessor else None,
        "created_at": req.created_at,
        "updated_at": req.updated_at,
        "parent_chain": [
            {"id": p.id, "req_number": p.req_number, "title": p.title} for p in reversed(chain)
        ],
        "children": [
            {
                "id": c.id,
                "req_number": c.req_number,
                "title": c.title,
                "lifecycle_state": c.lifecycle_state,
                "level": c.level,
                "stale": c.stale,
            }
            for c in children
        ],
        "allocations": own_allocations,
        "verification": verification_status(own_allocations),
        "revisions": [
            {
                "id": r.id,
                "revision": r.revision,
                "lifecycle_state": r.lifecycle_state,
                "statement": r.statement,
                "baselined_at": r.baselined_at,
            }
            for r in revisions
        ],
        "baseline_events": baseline_events,
        "readiness": readiness(db, req) if req.is_mutable else None,
        "lint": _finding_dicts(lint_requirement_row(req)) if req.is_mutable else [],
        # Spec 4.3: delete is for stillborn drafts only.
        "can_delete": req.is_mutable and not children and not own_allocations,
    }


# ============ Redline ============


def redline(old: Requirement, new: Requirement) -> dict[str, Any]:
    return {
        "rev_a": old.revision,
        "rev_b": new.revision,
        "title": redline_segments(old.title, new.title),
        "statement": redline_segments(old.statement, new.statement),
        "rationale": redline_segments(old.rationale or "", new.rationale or ""),
    }


# ============ Queue ============


def queue_items(db: Session) -> list[dict[str, Any]]:
    """The ready set with the context a reviewer needs on one screen."""
    ids = ready_requirement_ids(db)
    if not ids:
        return []
    rows = db.query(Requirement).filter(Requirement.id.in_(ids)).all()
    rows.sort(key=lambda r: (r.level, r.req_number))
    by_id = {r.id: r for r in db.query(Requirement).filter(Requirement.deleted_at.is_(None))}
    alloc = allocations_by_number(db)

    def chain(r: Requirement) -> list[dict[str, Any]]:
        out: list[dict[str, Any]] = []
        seen = {r.id}
        cursor = by_id.get(r.parent_id) if r.parent_id else None
        while cursor is not None and cursor.id not in seen:
            out.append(
                {
                    "id": cursor.id,
                    "req_number": cursor.req_number,
                    "title": cursor.title,
                    "lifecycle_state": cursor.lifecycle_state,
                }
            )
            seen.add(cursor.id)
            cursor = by_id.get(cursor.parent_id) if cursor.parent_id else None
        return list(reversed(out))

    items = []
    for r in rows:
        children = [c for c in by_id.values() if c.parent_id == r.id]
        predecessor = by_id.get(r.supersedes_id) if r.supersedes_id else None
        items.append(
            {
                "id": r.id,
                "req_number": r.req_number,
                "revision": r.revision,
                "title": r.title,
                "statement": r.statement,
                "rationale": r.rationale,
                "level": r.level,
                "verification_method": r.verification_method,
                "stale": r.stale,
                "children_count": len(children),
                "parts": [a["part_name"] for a in alloc.get(r.req_number, [])],
                "chain": chain(r),
                "warnings": [
                    c["detail"]
                    for c in readiness(db, r)["checks"]
                    if c["severity"] == "warning" and not c["passed"] and c["detail"]
                ],
                "change": redline(predecessor, r) if predecessor else None,
            }
        )
    return items


# ============ Baseline events ============


def event_summary(event: BaselineEvent) -> dict[str, Any]:
    return {
        "id": event.id,
        "label": event.label,
        "note": event.note,
        "signed_by": event.signed_by.name if event.signed_by else None,
        "created_at": event.created_at,
        "locked": len(event.items),
        "revised": sum(1 for i in event.items if i.requirement.supersedes_id is not None),
    }


def event_detail(db: Session, event: BaselineEvent) -> dict[str, Any]:
    """The locked set, each item with what it changed against its predecessor."""
    items = []
    for item in sorted(event.items, key=lambda i: i.requirement.req_number):
        r = item.requirement
        predecessor = db.get(Requirement, r.supersedes_id) if r.supersedes_id else None
        changed: list[str] = []
        diff = None
        if predecessor:
            for field in ("title", "statement", "rationale", "category", "level"):
                if (getattr(predecessor, field) or "") != (getattr(r, field) or ""):
                    changed.append(field)
            if predecessor.verification_method != r.verification_method:
                changed.append("verification_method")
            if predecessor.parent_id != r.parent_id:
                changed.append("parent")
            diff = redline(predecessor, r)
        items.append(
            {
                "id": r.id,
                "req_number": r.req_number,
                "revision": r.revision,
                "title": r.title,
                "statement": r.statement,
                "lifecycle_state": r.lifecycle_state,
                "previous_revision": predecessor.revision if predecessor else None,
                "changed": changed,
                "diff": diff,
            }
        )
    return {**event_summary(event), "items": items}


# ============ Summary (the SE dashboard) ============


def requirements_summary(db: Session) -> dict[str, Any]:
    """Coverage, verification, staleness, and what is red.

    Counts cover the current revision of every live requirement. Red lists
    carry just enough to link to the row.
    """
    rows = [r for r in _live_rows(db) if r.lifecycle_state in LIVE_STATES]
    alloc = allocations_by_number(db)
    by_state: dict[str, int] = {}
    for r in _live_rows(db):
        by_state[r.lifecycle_state] = by_state.get(r.lifecycle_state, 0) + 1

    child_parents = {r.parent_id for r in rows if r.parent_id}
    verification = {"verified": 0, "partial": 0, "open": 0, "unallocated": 0, "not_applicable": 0}
    for r in rows:
        verification[verification_status(alloc.get(r.req_number, []))] += 1

    def ref(r: Requirement) -> dict[str, Any]:
        return {"id": r.id, "req_number": r.req_number, "title": r.title}

    now = datetime.now(UTC)
    return {
        "total": len(rows),
        "by_state": by_state,
        "coverage": {
            # leaf requirements are the ones that must be allocated to hardware
            "leaves": sum(1 for r in rows if r.id not in child_parents),
            "leaves_allocated": sum(
                1 for r in rows if r.id not in child_parents and alloc.get(r.req_number)
            ),
            "with_verification_method": sum(1 for r in rows if r.verification_method),
        },
        "verification": verification,
        "ready_to_baseline": len(ready_requirement_ids(db)),
        "stale": [ref(r) for r in stale_requirements(db)],
        "overdue_tbrs": [
            {
                **ref(item["req"]),
                "owner": item["owner_name"],
                "days_over": item["days_over"],
                "tbr_due": item["req"].tbr_due,
            }
            for item in overdue_tbrs(db)
        ],
        "stuck_drafts": [ref(r) for r in old_block_lint_drafts(db)],
        "as_of": now,
    }
