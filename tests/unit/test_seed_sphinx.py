"""Mojave Sphinx demo seed — content inventory and live demo-state invariants."""

import json
import re

import pytest

import opal.config as config_mod
from opal.config import PROJECT_CONFIG_KEY, get_app_setting
from opal.core.holds import get_hold_state, get_holds_payload
from opal.db.models import (
    Issue,
    MasterProcedure,
    Part,
    ProcedureInstance,
    ProcedureStep,
    ProcedureVersion,
    Requirement,
    Risk,
    StepExecution,
)
from opal.db.models.execution import InstanceStatus, StepNote
from opal.seed import seed_database


@pytest.fixture(autouse=True)
def _isolate_active_project(monkeypatch):
    monkeypatch.setattr(config_mod, "_active_project", None)


@pytest.fixture()
def seeded(db_session):
    seed_database(db_session)
    return db_session


def test_content_inventory(seeded):
    assert seeded.query(Part).count() > 150
    assert seeded.query(Part).filter(Part.lifecycle_state == "draft").count() == 3
    assert seeded.query(MasterProcedure).count() == 6
    # every procedure is published
    assert seeded.query(ProcedureVersion).count() == 6
    assert (
        seeded.query(MasterProcedure).filter(MasterProcedure.current_version_id.is_(None)).count()
        == 0
    )
    assert seeded.query(Requirement).count() == 15
    assert seeded.query(Risk).count() == 17


def test_attribution_in_project_config(seeded):
    config = json.loads(get_app_setting(seeded, PROJECT_CONFIG_KEY))
    assert "Half Cat Rocketry" in config["description"]
    assert "HCR-5100" in config["description"]


def test_vehicle_assembly_has_11_ops_with_step_kits(seeded):
    proc = (
        seeded.query(MasterProcedure)
        .filter(MasterProcedure.name == "Mojave Sphinx Vehicle Assembly")
        .one()
    )
    version = seeded.get(ProcedureVersion, proc.current_version_id)
    ops = [s for s in version.content["steps"] if s["level"] == 0]
    assert len(ops) == 11
    assert sum(len(s["step_kit"]) for s in ops) > 80


def test_step_kits_never_exceed_gather_list(seeded):
    """Step kits are a breakdown of the procedure kit, never extra demand.

    In particular no step kit may demand a mid-procedure subassembly (the ops
    BUILD those; the kit carries their raw materials) — the model has no way
    to consume same-WO production.
    """
    for version in seeded.query(ProcedureVersion).all():
        kit = {i["part_id"]: i["quantity_required"] for i in version.content["kit_items"]}
        step_demand: dict[int, float] = {}
        for step in version.content["steps"]:
            for item in step["step_kit"]:
                step_demand[item["part_id"]] = (
                    step_demand.get(item["part_id"], 0) + item["quantity_required"]
                )
        for part_id, qty in step_demand.items():
            assert kit.get(part_id, 0) >= qty, (
                f"{version.content['procedure_name']}: part {part_id} step kits demand {qty} "
                f"but the gather list carries {kit.get(part_id, 0)}"
            )


def test_op_titles_carry_no_numbering(seeded):
    """The UI renders 'OP {n}' itself — titles must not repeat it."""
    for (title,) in seeded.query(ProcedureStep.title):
        assert not re.match(r"^(OP\s*\d|\d+\.\d)", title), title


def test_component_procedures_produce_assemblies(seeded):
    valve = (
        seeded.query(MasterProcedure)
        .filter(MasterProcedure.name == "Servo-Actuated Ball Valve Assembly")
        .one()
    )
    assert [(o.part.internal_pn, float(o.quantity_produced)) for o in valve.outputs] == [
        ("SPX-F-0010", 1.0)
    ]
    fins = (
        seeded.query(MasterProcedure)
        .filter(MasterProcedure.name == "Fin Bracket Subassembly")
        .one()
    )
    assert [(o.part.internal_pn, float(o.quantity_produced)) for o in fins.outputs] == [
        ("SPX-F-0132", 4.0)
    ]
    # the vehicle kit consumes what the component procedures produce
    vehicle = (
        seeded.query(MasterProcedure)
        .filter(MasterProcedure.name == "Mojave Sphinx Vehicle Assembly")
        .one()
    )
    kit_by_pn = {k.part.internal_pn: float(k.quantity_required) for k in vehicle.kits}
    assert kit_by_pn["SPX-F-0010"] == 2.0
    assert kit_by_pn["SPX-F-0132"] == 4.0


def test_vehicle_and_launch_sequencing(seeded):
    def snapshot(name):
        proc = seeded.query(MasterProcedure).filter(MasterProcedure.name == name).one()
        version = seeded.get(ProcedureVersion, proc.current_version_id)
        ops = [s for s in version.content["steps"] if s["level"] == 0]
        return {s["step_number"]: s for s in ops}, {s["order"]: s["step_number"] for s in ops}

    veh, veh_order_to_num = snapshot("Mojave Sphinx Vehicle Assembly")
    assert veh["5"]["strict_sequence"] is True  # tank piston/bulkhead order
    deps = {num: sorted(veh_order_to_num[o] for o in s["depends_on"]) for num, s in veh.items()}
    assert deps["5"] == ["2", "3", "4"]  # tank waits on all three bulkheads
    assert deps["7"] == ["6"]  # thrust structure waits on TCA
    assert deps["11"] == ["10", "9"]  # recovery integration waits on cone + airframe

    launch, launch_order_to_num = snapshot("Launch Operations")
    assert launch["4"]["strict_sequence"] is True  # arm/fill/fire ladder
    for num, s in launch.items():
        prereqs = [launch_order_to_num[o] for o in s["depends_on"]]
        if num.startswith("C"):
            assert prereqs == []  # contingencies are never gated
        else:
            assert prereqs == ([str(int(num) - 1)] if num != "1" else [])


def test_launch_contingency_ops(seeded):
    proc = seeded.query(MasterProcedure).filter(MasterProcedure.name == "Launch Operations").one()
    version = seeded.get(ProcedureVersion, proc.current_version_id)
    ops = [s for s in version.content["steps"] if s["level"] == 0]
    contingencies = [s for s in ops if s["is_contingency"]]
    assert [(s["step_number"], s["title"]) for s in contingencies] == [
        ("C1", "Aborted Firing Safe-Down"),
        ("C2", "Misfire / No-Ignition Recovery"),
    ]
    # Contingency ops sort after every normal op.
    max_normal_order = max(s["order"] for s in ops if not s["is_contingency"])
    assert all(s["order"] > max_normal_order for s in contingencies)
    # Sub-steps inherit the C-series numbering and the flag.
    by_parent = {}
    for s in version.content["steps"]:
        if s["parent_step_id"] is not None:
            by_parent.setdefault(s["parent_step_id"], []).append(s)
    safe_down = by_parent[contingencies[0]["id"]]
    assert [s["step_number"] for s in safe_down] == [f"C1.{i}" for i in range(1, 7)]
    assert all(s["is_contingency"] for s in safe_down)
    # The safety-walk gate keeps its QA signoff after the move.
    walk = next(s for s in safe_down if s["title"] == "Safety walk — 100-foot hold")
    assert walk["requires_signoff"] and walk["required_role"] == "QA"
    # Moved, not duplicated: the nominal shutdown op keeps only its 4 nominal steps.
    shutdown = next(s for s in ops if s["title"] == "Launchpad Shutdown")
    assert len(by_parent[shutdown["id"]]) == 4
    assert not any("Aborted" in s["title"] for s in by_parent[shutdown["id"]])


def test_work_order_states(seeded):
    statuses = sorted(
        s.value if hasattr(s, "value") else s for (s,) in seeded.query(ProcedureInstance.status)
    )
    assert statuses == ["completed", "completed", "cut", "in_work"]


def test_wo2_boundary_hold_renders(seeded):
    wo2 = (
        seeded.query(ProcedureInstance)
        .filter(ProcedureInstance.status == InstanceStatus.IN_WORK)
        .one()
    )
    boundary = (
        seeded.query(StepExecution)
        .filter(StepExecution.instance_id == wo2.id, StepExecution.step_number_str == "5.4")
        .one()
    )
    holds = get_hold_state(seeded, wo2.id)
    assert holds.blockers_for_start(boundary), "resolve-by boundary must hold 5.4"
    payload = get_holds_payload(seeded, wo2.id)
    assert payload["held"]
    assert "5.4 COMPLETE" in payload["holds"][0]["blocks"]


def test_issue_disposition_variety(seeded):
    states = [i.disp_state for i in seeded.query(Issue).all()]
    assert "undispositioned" in states
    assert "dispositioned" in states
    assert "closed" in states


def test_risk_disposition_variety(seeded):
    dispositions = {r.disposition for r in seeded.query(Risk).all()}
    assert {"open", "mitigate", "watch", "accepted", "realized"} <= dispositions
    accepted = seeded.query(Risk).filter(Risk.disposition == "accepted").one()
    assert accepted.accepted_by_id is not None
    assert accepted.acceptance_rationale
    realized = seeded.query(Risk).filter(Risk.disposition == "realized").one()
    assert realized.realized_issue_id is not None


def test_requirement_lifecycle_variety(seeded):
    reqs = seeded.query(Requirement).all()
    assert sum(1 for r in reqs if r.lifecycle_state == "baselined") == 13
    tbrs = [r for r in reqs if r.tbr]
    assert len(tbrs) == 1
    assert tbrs[0].tbr_owner_id is not None
    assert tbrs[0].tbr_due is not None


def test_step_notes_exist(seeded):
    assert seeded.query(StepNote).count() >= 5


def test_every_published_kit_line_is_stocked(seeded):
    """A fresh WO of any published procedure can kit: on-hand stock covers
    every procedure kit line and every consuming step-kit line — and the
    vehicle and GSE builds can kit simultaneously (their summed demand for
    the shared valve assembly is covered)."""
    from opal.db.models.inventory import InventoryRecord

    on_hand: dict[int, float] = {}
    for rec in seeded.query(InventoryRecord).filter(InventoryRecord.quantity > 0).all():
        on_hand[rec.part_id] = on_hand.get(rec.part_id, 0) + float(rec.quantity)

    summed: dict[int, float] = {}
    for version in seeded.query(ProcedureVersion).all():
        name = version.content["procedure_name"]
        for item in version.content["kit_items"]:
            required = item["quantity_required"]
            summed[item["part_id"]] = summed.get(item["part_id"], 0) + required
            assert on_hand.get(item["part_id"], 0) >= required, (
                f"{name}: kit needs {required} of part {item['part_id']}, "
                f"on hand {on_hand.get(item['part_id'], 0)}"
            )
        for step in version.content["steps"]:
            for item in step["step_kit"]:
                if item["usage_type"] != "consume":
                    continue
                assert on_hand.get(item["part_id"], 0) >= item["quantity_required"], (
                    f"{name} step {step['step_number']}: needs {item['quantity_required']} "
                    f"of part {item['part_id']}, on hand {on_hand.get(item['part_id'], 0)}"
                )

    # Serialized kit demand is covered across procedures, not just per line.
    serialized = {
        p.id: p.internal_pn
        for p in seeded.query(Part).filter(Part.tracking_type == "serialized").all()
    }
    for part_id, required in summed.items():
        if part_id in serialized:
            assert on_hand.get(part_id, 0) >= required, (
                f"serialized {serialized[part_id]}: total kit demand {required}, "
                f"on hand {on_hand.get(part_id, 0)}"
            )


def test_serialized_stock_is_unit_records(seeded):
    """Serialized means one OPAL number per physical unit — every serialized
    stock record holds quantity exactly 1 (0 once consumed)."""
    from opal.db.models.inventory import InventoryRecord

    rows = (
        seeded.query(InventoryRecord)
        .join(Part, Part.id == InventoryRecord.part_id)
        .filter(Part.tracking_type == "serialized")
        .all()
    )
    assert rows
    assert all(float(r.quantity) in (0.0, 1.0) for r in rows)


def test_completed_wos_consumed_their_serialized_kit(seeded):
    """WO-1 built SN 001 — its serialized kit components (bulkheads, ring,
    valves, TCA parts...) must appear in its consumption set as distinct
    unit records, not sit untouched in stock."""
    from opal.db.models.inventory import InventoryConsumption, InventoryRecord

    serialized_ids = {
        p.id for p in seeded.query(Part).filter(Part.tracking_type == "serialized").all()
    }
    completed = (
        seeded.query(ProcedureInstance)
        .filter(ProcedureInstance.status == InstanceStatus.COMPLETED)
        .all()
    )
    assert completed
    exercised = 0
    for wo in completed:
        version = seeded.get(ProcedureVersion, wo.version_id)
        consumed: dict[int, float] = {}
        rows = (
            seeded.query(InventoryConsumption, InventoryRecord)
            .join(InventoryRecord, InventoryConsumption.inventory_record_id == InventoryRecord.id)
            .filter(InventoryConsumption.procedure_instance_id == wo.id)
            .all()
        )
        for cons, rec in rows:
            consumed[rec.part_id] = consumed.get(rec.part_id, 0) + float(cons.quantity)
            if rec.part_id in serialized_ids:
                assert float(cons.quantity) == 1.0  # one consumption per unit
                assert float(rec.quantity) == 0.0  # the unit is gone from stock
        for item in version.content["kit_items"]:
            if item["part_id"] in serialized_ids:
                exercised += 1
                assert consumed.get(item["part_id"], 0) == item["quantity_required"], (
                    f"{wo.work_order_number}: serialized part {item['part_id']} required "
                    f"{item['quantity_required']}, consumed {consumed.get(item['part_id'], 0)}"
                )
    assert exercised >= 10  # the vehicle kit carries the serialized components


def test_po_sourced_stock_never_exceeds_received(seeded):
    """A stock record citing a PO line must be covered by what that line
    received — including what was already consumed out of the record."""
    from decimal import Decimal

    from opal.db.models import PurchaseLine
    from opal.db.models.inventory import InventoryRecord

    records = (
        seeded.query(InventoryRecord)
        .filter(InventoryRecord.source_purchase_line_id.isnot(None))
        .all()
    )
    assert len(records) > 20  # the McMaster kit order feeds most of the shelf

    received_claim: dict[int, Decimal] = {}
    for rec in records:
        consumed = sum((c.quantity for c in rec.consumptions), Decimal(0))
        received_claim[rec.source_purchase_line_id] = (
            received_claim.get(rec.source_purchase_line_id, Decimal(0)) + rec.quantity + consumed
        )
    for line_id, claimed in received_claim.items():
        line = seeded.get(PurchaseLine, line_id)
        assert claimed <= line.qty_received, (
            f"PO line {line_id} (part {line.part_id}) received {line.qty_received} "
            f"but sourced stock accounts for {claimed}"
        )
