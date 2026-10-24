"""Inventory utility functions including OPAL number generation."""

import re
from dataclasses import dataclass, field
from datetime import UTC, datetime
from decimal import Decimal

from sqlalchemy.orm import Session

# Re-export from new designators module for backward compatibility
from opal.core.designators import generate_opal_number  # noqa: F401
from opal.db.models.inventory import InventoryRecord


def get_inventory_by_opal(db: Session, opal_number: str) -> InventoryRecord | None:
    """Look up an inventory record by its OPAL number.

    Args:
        db: Database session
        opal_number: The OPAL number (e.g., "OPAL-00042")

    Returns:
        The InventoryRecord if found, None otherwise.
    """
    return db.query(InventoryRecord).filter(InventoryRecord.opal_number == opal_number).first()


# ============ Receipt rules ============


def receipt_rules(part) -> tuple[bool, bool]:
    """Tier rules that govern receiving stock of ``part``.

    Returns ``(require_lot, auto_serial)`` from the active project's tier
    semantics: ``require_lot`` applies to bulk parts (a receipt must carry a
    lot number); ``auto_serial`` applies to serialized parts (units received
    without a lot number get generated serials, one per physical unit).
    """
    from opal.config import get_active_project
    from opal.db.models.part import TrackingType
    from opal.project import tier_semantics

    tier_cfg = tier_semantics(get_active_project(), part.tier)
    return (
        bool(tier_cfg.require_lot and part.tracking_type == TrackingType.BULK),
        bool(tier_cfg.auto_serial and part.tracking_type == TrackingType.SERIALIZED),
    )


# ============ Ledger ============

_REASON_PREFIX = re.compile(r"^\[([a-z_]+)\]\s*(.*)$", re.DOTALL)


def split_reason(notes: str | None) -> tuple[str | None, str | None]:
    """Adjustment ledger notes are stored as ``[reason] free text``."""
    if not notes:
        return None, None
    match = _REASON_PREFIX.match(notes)
    if not match:
        return None, notes
    return match.group(1), match.group(2) or None


@dataclass
class LedgerEntry:
    """One line of an inventory record's ledger (oldest first once built)."""

    # received | produced | planned | consumed | tooling | scrapped | adjusted | counted
    # | moved_in | moved_out | moved
    kind: str
    timestamp: datetime
    delta: Decimal
    balance: Decimal = Decimal(0)
    instance_id: int | None = None
    notes: str | None = None
    reason: str | None = None
    user_name: str | None = None
    from_location: str | None = None
    to_location: str | None = None
    counterpart_opal: str | None = None
    serial_number: str | None = None
    quantity: Decimal | None = None
    extra: dict = field(default_factory=dict)


def _aware(value: datetime) -> datetime:
    return value if value.tzinfo else value.replace(tzinfo=UTC)


def build_ledger(record: InventoryRecord) -> list[LedgerEntry]:
    """Reconstruct the quantity ledger of ``record``, oldest first, with a
    running balance.

    On-hand only ever changes through consumptions (out), productions and
    adjustments (in), and transfers (in/out), so the opening quantity is
    whatever is left once every ledger delta is taken off the current
    quantity. A non-zero opening is the receipt itself.
    """
    entries: list[LedgerEntry] = []

    for c in record.consumptions:
        ctype = getattr(c.consumption_type, "value", c.consumption_type)
        usage = getattr(c.usage_type, "value", c.usage_type)
        reason, notes = split_reason(c.notes)
        if usage == "tooling":
            kind, delta = "tooling", Decimal(0)
        elif ctype == "scrap":
            kind, delta = "scrapped", -c.quantity
        elif ctype == "adjustment":
            kind, delta = ("counted" if reason == "cycle_count" else "adjusted"), -c.quantity
        else:
            kind, delta = "consumed", -c.quantity
        entries.append(
            LedgerEntry(
                kind=kind,
                timestamp=c.created_at,
                delta=delta,
                quantity=c.quantity,
                instance_id=c.procedure_instance_id,
                notes=notes if reason else c.notes,
                reason=reason,
                user_name=c.consumed_by_user.name if c.consumed_by_user else None,
            )
        )

    for p in record.productions:
        status = getattr(p.status, "value", p.status)
        reason, notes = split_reason(p.notes)
        if p.procedure_instance_id is None:
            kind, delta = ("counted" if reason == "cycle_count" else "adjusted"), p.quantity
        elif status == "completed":
            kind, delta = "produced", p.quantity
        else:
            kind, delta = "planned", Decimal(0)
        entries.append(
            LedgerEntry(
                kind=kind,
                timestamp=p.created_at,
                delta=delta,
                quantity=p.quantity,
                instance_id=p.procedure_instance_id,
                notes=notes if reason else p.notes,
                reason=reason,
                user_name=p.produced_by_user.name if p.produced_by_user else None,
                serial_number=p.serial_number,
            )
        )

    for t in record.outgoing_transfers:
        same = t.target_inventory_id == record.id
        entries.append(
            LedgerEntry(
                kind="moved" if same else "moved_out",
                timestamp=t.transferred_at or t.created_at,
                delta=Decimal(0) if same else -t.quantity,
                quantity=t.quantity,
                notes=t.notes,
                user_name=t.transferred_by_user.name if t.transferred_by_user else None,
                from_location=t.source_location,
                to_location=t.target_location,
                counterpart_opal=(
                    t.target_inventory.opal_number if t.target_inventory and not same else None
                ),
            )
        )
    for t in record.incoming_transfers:
        if t.source_inventory_id == record.id:
            continue  # whole-record relocation, already listed as outgoing
        entries.append(
            LedgerEntry(
                kind="moved_in",
                timestamp=t.transferred_at or t.created_at,
                delta=t.quantity,
                quantity=t.quantity,
                notes=t.notes,
                user_name=t.transferred_by_user.name if t.transferred_by_user else None,
                from_location=t.source_location,
                to_location=t.target_location,
                counterpart_opal=t.source_inventory.opal_number if t.source_inventory else None,
            )
        )

    opening = record.quantity - sum((e.delta for e in entries), Decimal(0))
    if opening != 0:
        entries.append(LedgerEntry(kind="received", timestamp=record.created_at, delta=opening))

    # Oldest first; the receipt always leads when timestamps tie.
    entries.sort(key=lambda e: (_aware(e.timestamp), 0 if e.kind == "received" else 1))
    balance = Decimal(0)
    for e in entries:
        balance += e.delta
        e.balance = balance
    return entries
