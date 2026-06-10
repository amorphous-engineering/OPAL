"""Tests for the OPAL MCP operations tools (Phase 5).

The MCP handlers are sync-style coroutines that take ``(db, args)`` and return
a list of ``TextContent``. We import them directly and exercise them against
the in-memory test DB session, parsing the JSON payload they emit.
"""

import asyncio
import json
from typing import Any

import pytest

from opal.db.models import (
    InventoryRecord,
    MasterProcedure,
    Part,
    ProcedureOutput,
    ProcedureStep,
    Purchase,
    PurchaseLine,
    StepKit,
    Supplier,
    Workcenter,
)
from opal.mcp import server


def _call(handler, db, args: dict) -> dict[str, Any]:
    """Run a handler coroutine and return the parsed JSON payload."""
    result = asyncio.run(handler(db, args))
    assert len(result) == 1
    return json.loads(result[0].text)


def _make_part(db, **kwargs) -> Part:
    defaults = {
        "name": "Widget",
        "internal_pn": f"PN-{kwargs.get('name', 'X')}",
        "tier": 1,
    }
    defaults.update(kwargs)
    part = Part(**defaults)
    db.add(part)
    db.flush()
    return part


# ============ search_suppliers ============


def test_search_suppliers_filters_by_name(db_session):
    db_session.add_all(
        [
            Supplier(name="DigiKey Electronics", code="DK"),
            Supplier(name="Mouser", code="MO"),
        ]
    )
    db_session.flush()

    data = _call(server._search_suppliers, db_session, {"query": "digi"})
    assert data["count"] == 1
    assert data["suppliers"][0]["name"] == "DigiKey Electronics"
    assert data["suppliers"][0]["is_active"] is True


def test_search_suppliers_excludes_soft_deleted(db_session):
    from datetime import UTC, datetime

    s = Supplier(name="GhostVendor")
    db_session.add(s)
    db_session.flush()
    s.deleted_at = datetime.now(UTC)
    db_session.flush()

    data = _call(server._search_suppliers, db_session, {"query": "ghost"})
    assert data["count"] == 0


# ============ create_supplier ============


def test_create_supplier_happy(db_session):
    data = _call(
        server._create_supplier,
        db_session,
        {"name": "Acme Corp", "code": "ACME", "email": "sales@acme.test"},
    )
    assert data["success"] is True
    sid = data["supplier"]["id"]
    row = db_session.get(Supplier, sid)
    assert row is not None
    assert row.name == "Acme Corp"
    assert row.email == "sales@acme.test"


def test_create_supplier_requires_name(db_session):
    with pytest.raises(KeyError):
        _call(server._create_supplier, db_session, {"code": "NONAME"})


# ============ create_workcenter ============


def test_create_workcenter_happy(db_session):
    data = _call(
        server._create_workcenter,
        db_session,
        {"name": "Clean Room", "code": "CR1", "location": "Bldg 2"},
    )
    assert data["success"] is True
    row = db_session.get(Workcenter, data["workcenter"]["id"])
    assert row.code == "CR1"
    assert row.location == "Bldg 2"


def test_create_workcenter_derives_code_when_omitted(db_session):
    data = _call(server._create_workcenter, db_session, {"name": "Assembly Bay"})
    assert data["success"] is True
    assert data["workcenter"]["code"]  # non-empty derived code


def test_create_workcenter_duplicate_code(db_session):
    db_session.add(Workcenter(name="Existing", code="DUP"))
    db_session.flush()
    data = _call(server._create_workcenter, db_session, {"name": "New", "code": "DUP"})
    assert "error" in data
    assert "already exists" in data["error"]


def test_create_workcenter_code_case_matches_api(db_session):
    """MCP mirrors the API: case-insensitive duplicate check, stored uppercased."""
    db_session.add(Workcenter(name="Existing", code="AB1"))
    db_session.flush()
    data = _call(server._create_workcenter, db_session, {"name": "New", "code": "ab1"})
    assert "error" in data and "already exists" in data["error"]

    data = _call(server._create_workcenter, db_session, {"name": "Other", "code": "cd2"})
    assert data["success"] is True
    assert data["workcenter"]["code"] == "CD2"


# ============ get_inventory_summary ============


def test_get_inventory_summary_totals_and_locations(db_session):
    part = _make_part(db_session, name="Bolt", internal_pn="PN-BOLT")
    db_session.add_all(
        [
            InventoryRecord(part_id=part.id, quantity=10, location="A1", opal_number="OPAL-1"),
            InventoryRecord(part_id=part.id, quantity=5, location="B2", opal_number="OPAL-2"),
        ]
    )
    db_session.flush()

    data = _call(server._get_inventory_summary, db_session, {"part_id": part.id})
    assert data["total_qty"] == 15.0
    assert data["record_count"] == 2
    locations = {row["location"] for row in data["by_location"]}
    assert locations == {"A1", "B2"}
    assert data["is_tooling"] is False
    assert "calibration_status" not in data


def test_get_inventory_summary_tooling_calibration(db_session):
    from datetime import UTC, datetime, timedelta

    part = _make_part(
        db_session,
        name="Torque Wrench",
        internal_pn="PN-TW",
        tier=2,
        is_tooling=True,
        calibration_interval_days=365,
    )
    db_session.add(
        InventoryRecord(
            part_id=part.id,
            quantity=1,
            location="TOOLCRIB",
            opal_number="OPAL-TW",
            calibration_due_at=datetime.now(UTC) - timedelta(days=1),
        )
    )
    db_session.flush()

    data = _call(server._get_inventory_summary, db_session, {"part_id": part.id})
    assert data["is_tooling"] is True
    assert data["calibration_status"] == "overdue"
    assert data["calibration_interval_days"] == 365


def test_get_inventory_summary_unknown_part(db_session):
    data = _call(server._get_inventory_summary, db_session, {"part_id": 999999})
    assert "error" in data


# ============ bulk_create_parts ============


def test_bulk_create_parts_happy(db_session):
    data = _call(
        server._bulk_create_parts,
        db_session,
        {
            "parts": [
                {"name": "Part A", "tier": 1},
                {"name": "Part B", "tier": 2},
                {"name": "Part C", "tier": 3, "tracking_type": "bulk"},
            ]
        },
    )
    assert data["success"] is True
    assert data["count"] == 3
    for p in data["parts"]:
        assert p["internal_pn"]
    # tier-2 forced to tooling
    tier2 = next(p for p in data["parts"] if p["tier"] == 2)
    assert tier2["is_tooling"] is True
    tier1 = next(p for p in data["parts"] if p["tier"] == 1)
    assert tier1["is_tooling"] is False


def test_bulk_create_parts_bad_parent_rejects_batch(db_session):
    before = db_session.query(Part).count()
    data = _call(
        server._bulk_create_parts,
        db_session,
        {
            "parts": [
                {"name": "Good"},
                {"name": "Orphan", "parent_id": 424242},
            ]
        },
    )
    assert "error" in data
    # whole batch rejected — nothing created
    assert db_session.query(Part).count() == before


# ============ create_purchase_order ============


def test_create_purchase_order_happy(db_session):
    supplier = Supplier(name="Vendor X")
    db_session.add(supplier)
    db_session.flush()
    part = _make_part(db_session, name="Resistor", internal_pn="PN-R")

    data = _call(
        server._create_purchase_order,
        db_session,
        {
            "supplier_id": supplier.id,
            "lines": [{"part_id": part.id, "quantity": 100, "unit_cost": 0.05}],
        },
    )
    assert data["success"] is True
    assert data["po_number"].startswith("PO-")
    assert data["line_count"] == 1
    assert data["status"] == "draft"

    po = db_session.get(Purchase, data["purchase_id"])
    assert po.supplier == "Vendor X"
    assert po.supplier_id == supplier.id
    lines = db_session.query(PurchaseLine).filter(PurchaseLine.purchase_id == po.id).all()
    assert len(lines) == 1
    assert lines[0].qty_ordered == 100
    assert float(lines[0].unit_cost) == 0.05


def test_create_purchase_order_unknown_part(db_session):
    supplier = Supplier(name="Vendor Y")
    db_session.add(supplier)
    db_session.flush()
    before = db_session.query(Purchase).count()

    data = _call(
        server._create_purchase_order,
        db_session,
        {"supplier_id": supplier.id, "lines": [{"part_id": 999999, "quantity": 1}]},
    )
    assert "error" in data
    assert db_session.query(Purchase).count() == before


def test_create_purchase_order_missing_supplier(db_session):
    data = _call(
        server._create_purchase_order,
        db_session,
        {"supplier_id": 999999, "lines": [{"part_id": 1, "quantity": 1}]},
    )
    assert "error" in data
    assert "Supplier" in data["error"]


# ============ build_procedure ============


def test_build_procedure_full(db_session):
    p1 = _make_part(db_session, name="Comp1", internal_pn="PN-C1")
    p2 = _make_part(db_session, name="Comp2", internal_pn="PN-C2")
    out_part = _make_part(db_session, name="Assembly", internal_pn="PN-ASM")
    wc = Workcenter(name="Bench", code="BNCH")
    db_session.add(wc)
    db_session.flush()

    data = _call(
        server._build_procedure,
        db_session,
        {
            "name": "Build Widget",
            "procedure_type": "build",
            "description": "Full build",
            "steps": [
                {
                    "title": "Prep",
                    "instructions": "Get parts",
                    "required_role": "QE",
                    "caution": "High voltage",
                    "requires_signoff": True,
                    "workcenter_id": wc.id,
                    "step_kits": [
                        {"part_id": p1.id, "quantity_required": 2, "usage_type": "consume"},
                        {"part_id": p2.id, "quantity_required": 1, "usage_type": "tooling"},
                    ],
                },
                {"title": "Assemble"},
            ],
            "kit": [{"part_id": p1.id, "quantity_required": 2}],
            "outputs": [{"part_id": out_part.id, "quantity_produced": 1}],
        },
    )
    assert data["success"] is True
    assert data["step_count"] == 2
    assert data["step_kit_count"] == 2
    assert data["kit_item_count"] == 1
    assert data["output_count"] == 1

    proc = db_session.get(MasterProcedure, data["procedure_id"])
    assert proc is not None
    steps = (
        db_session.query(ProcedureStep)
        .filter(ProcedureStep.procedure_id == proc.id)
        .order_by(ProcedureStep.order)
        .all()
    )
    assert [s.step_number for s in steps] == ["1", "2"]
    assert all(s.level == 0 for s in steps)
    assert steps[0].required_role == "QE"
    assert steps[0].caution == "High voltage"
    assert steps[0].workcenter_id == wc.id

    sks = db_session.query(StepKit).filter(StepKit.step_id == steps[0].id).all()
    assert len(sks) == 2
    outs = db_session.query(ProcedureOutput).filter(ProcedureOutput.procedure_id == proc.id).all()
    assert len(outs) == 1


def test_build_procedure_unknown_part_rejects(db_session):
    before = db_session.query(MasterProcedure).count()
    data = _call(
        server._build_procedure,
        db_session,
        {
            "name": "Bad Build",
            "steps": [{"title": "S1", "step_kits": [{"part_id": 999999, "quantity_required": 1}]}],
        },
    )
    assert "error" in data
    # nothing committed
    assert db_session.query(MasterProcedure).count() == before


def test_build_procedure_step_missing_title(db_session):
    data = _call(
        server._build_procedure,
        db_session,
        {"name": "No Title", "steps": [{"instructions": "x"}]},
    )
    assert "error" in data
    assert "title" in data["error"]
