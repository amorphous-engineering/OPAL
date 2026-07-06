"""Seed data for the Mojave Sphinx demo — a real liquid bipropellant rocket.

Demo content adapted from HCR-5100 — Mojave Sphinx Build, Integration, and
Launch Guidebook, Half Cat Rocketry, published under the GPL. The parts,
BOM, procedures, requirements, risks, and maintenance schedule are extracted
from the guidebook (lightly condensed); the live demo state (work orders,
issues, notes, purchases) is composed around real guidebook errata.

Content lives in src/opal/seed_data/sphinx/*.json; this module is the loader
plus the demo-state narrative.
"""

import json
from datetime import UTC, datetime, timedelta
from decimal import Decimal
from pathlib import Path
from typing import Any

from sqlalchemy.orm import Session

from opal.core.designators import (
    generate_issue_number,
    generate_opal_number,
    generate_requirement_number,
    generate_risk_number,
    generate_serial_number,
    generate_work_order_number,
)
from opal.db.models import (
    BOMLine,
    Issue,
    IssueComment,
    Kit,
    MasterProcedure,
    Part,
    PartRequirement,
    ProcedureInstance,
    ProcedureOutput,
    ProcedureStep,
    ProcedureVersion,
    Purchase,
    PurchaseLine,
    Requirement,
    Risk,
    RiskIssueLink,
    StepDependency,
    StepExecution,
    Supplier,
    TestTemplate,
    User,
    Workcenter,
)
from opal.db.models.execution import InstanceStatus, StepFocus, StepNote, StepStatus
from opal.db.models.inventory import (
    InventoryConsumption,
    InventoryProduction,
    InventoryRecord,
    ProductionStatus,
    SourceType,
)
from opal.db.models.issue import Containment, DispositionType, IssuePriority, IssueStatus, IssueType
from opal.db.models.procedure import ProcedureStatus, ProcedureType, StepKit, UsageType
from opal.db.models.purchase import PurchaseStatus
from opal.db.models.risk import RiskIssueRole
from opal.db.models.supplier import SupplierPart

DATA_DIR = Path(__file__).resolve().parent / "seed_data" / "sphinx"

ATTRIBUTION = (
    "Demo content adapted from HCR-5100 — Mojave Sphinx Build, Integration, "
    "and Launch Guidebook, Half Cat Rocketry, published under the GPL."
)


def _data(name: str) -> dict[str, Any]:
    return json.loads((DATA_DIR / name).read_text())


def seed_database(db: Session) -> None:
    """Populate database with Mojave Sphinx seed data."""
    now = datetime.now(UTC)

    parts_data = _data("parts.json")
    procs_data = _data("procedures.json")

    _seed_project_config(db)
    users = _seed_users(db)
    workcenters = _seed_workcenters(db)
    suppliers = _seed_suppliers(db, parts_data)
    parts = _seed_parts(db, parts_data, suppliers, users, now)
    _seed_bom(db, parts_data, parts)
    _seed_requirements(db, parts, users, now)
    procs, versions = _seed_procedures(db, procs_data, parts, workcenters)
    po_lines = _seed_purchases(db, parts, suppliers, now)
    inventory = _seed_inventory(db, parts_data, procs_data, parts, po_lines, now)
    wo = _seed_executions(db, procs, versions, parts, inventory, users, now)
    issues = _seed_issues(db, parts, procs, wo, users, now)
    _seed_risks(db, parts, users, issues)
    _seed_test_templates(db, parts)
    db.commit()

    print(f"  {db.query(Workcenter).count()} workcenters")
    print(f"  {db.query(Supplier).count()} suppliers")
    print(f"  {db.query(Part).count()} parts")
    print(f"  {db.query(BOMLine).count()} BOM lines")
    print(f"  {db.query(Requirement).count()} requirements")
    print(f"  {db.query(PartRequirement).count()} requirement allocations")
    print(f"  {db.query(InventoryRecord).count()} inventory records")
    print(f"  {db.query(MasterProcedure).count()} procedures")
    print(f"  {db.query(ProcedureStep).count()} procedure steps")
    print(f"  {db.query(ProcedureVersion).count()} published versions")
    print(f"  {db.query(ProcedureInstance).count()} executions")
    print(f"  {db.query(Purchase).count()} purchase orders")
    print(f"  {db.query(PurchaseLine).count()} PO line items")
    print(f"  {db.query(Issue).count()} issues")
    print(f"  {db.query(Risk).count()} risks")
    print(f"  {db.query(TestTemplate).count()} test templates")


# ---------------------------------------------------------------------------
# Project config
# ---------------------------------------------------------------------------


def _seed_project_config(db: Session) -> None:
    """Store the Mojave Sphinx project config in the database (never on disk)."""
    from opal.config import save_project_to_db
    from opal.project import ProjectConfig

    config = ProjectConfig(**_data("project.json")["project"])
    save_project_to_db(db, config)
    print(f"  Stored project config '{config.name}' in the database")


def _seed_users(db: Session) -> dict[str, User]:
    """Create demo users with a known password (demo data, not production).

    Usernames and password are kept from the previous demo (build/test/qa ·
    kestrel-demo) so existing docs and muscle memory survive the content swap.
    """
    from opal.core.auth import hash_password

    demo_hash = hash_password("kestrel-demo")
    items = [
        User(
            name="Build Lead",
            username="build",
            password_hash=demo_hash,
            email="build@sphinx.local",
            is_admin=True,
            needs_onboarding=False,
        ),
        User(
            name="Test Engineer",
            username="test",
            password_hash=demo_hash,
            email="test@sphinx.local",
            is_admin=False,
            needs_onboarding=False,
        ),
        User(
            name="QA Inspector",
            username="qa",
            password_hash=demo_hash,
            email="qa@sphinx.local",
            is_admin=False,
            needs_onboarding=False,
        ),
    ]
    db.add_all(items)
    db.flush()
    return {u.username: u for u in items}


def _seed_workcenters(db: Session) -> dict[str, Workcenter]:
    items = [
        Workcenter(code="SHOP", name="Machine Shop", description="Lathe, drill press, cutting"),
        Workcenter(code="BENCH", name="Assembly Bench", description="Vehicle and GSE assembly"),
        Workcenter(
            code="ELEC", name="Electronics Bench", description="Avionics, wiring, transmitter setup"
        ),
        Workcenter(code="PAD", name="Launch Site", description="Pad operations and static fire"),
        Workcenter(code="STORE", name="Stockroom", description="Parts receiving and storage"),
    ]
    db.add_all(items)
    db.flush()
    return {w.code: w for w in items}


def _seed_suppliers(db: Session, data: dict) -> dict[str, Supplier]:
    items = [
        Supplier(name=s["name"], website=s.get("website"), notes=s.get("notes"))
        for s in data["suppliers"]
    ]
    db.add_all(items)
    db.flush()
    return {s.name: s for s in items}


# ---------------------------------------------------------------------------
# Parts & BOM
# ---------------------------------------------------------------------------

# Reorder points for the consumables the launch procedures burn through.
_REORDER = {
    "9452k226": 10,  # -238 tank O-rings — replaced every 3 firings
    "9452k15": 10,  # -007 QD O-rings — QD tube every 5 firings
    "94095k114": 2,  # graphite gaskets — replaced on TCA disassembly
    "1834": 8,  # e-matches — 4 per flight (igniter + ejection)
    "1318": 1,  # black powder
    "9v_batt": 2,  # altimeter batteries
}


def _seed_parts(
    db: Session,
    data: dict,
    suppliers: dict[str, Supplier],
    users: dict[str, User],
    now: datetime,
) -> dict[str, Part]:
    parts: dict[str, Part] = {}
    activated_at = now - timedelta(days=45)

    for entry in data["parts"]:
        active = entry["lifecycle"] == "active"
        part = Part(
            internal_pn=entry["ipn"],
            external_pn=entry.get("vendor_pn") or entry.get("guidebook_pn"),
            name=entry["name"],
            description=entry.get("description"),
            category=entry["category"],
            tier=entry["tier"],
            tracking_type=entry["tracking"],
            unit_of_measure=entry.get("uom") or "ea",
            procurement=entry["procurement"],
            is_tooling=bool(entry.get("is_tooling")),
            reorder_point=(
                Decimal(str(_REORDER[entry["key"]])) if entry["key"] in _REORDER else None
            ),
            lifecycle_state="active" if active else "draft",
            activated_at=activated_at if active else None,
            activated_by_id=users["build"].id if active else None,
            activation_cause="Baseline release for the Sphinx build campaign" if active else None,
        )
        db.add(part)
        db.flush()
        parts[entry["key"]] = part

        if entry.get("supplier") and entry.get("vendor_pn"):
            db.add(
                SupplierPart(
                    supplier_id=suppliers[entry["supplier"]].id,
                    part_id=part.id,
                    vendor_pn=entry["vendor_pn"],
                    is_preferred=True,
                )
            )

    db.flush()
    return parts


def _seed_bom(db: Session, data: dict, parts: dict[str, Part]) -> None:
    # parent_id mirrors the BOM only where a component has exactly one parent
    parent_count: dict[str, list[str]] = {}
    for line in data["bom"]:
        parent_count.setdefault(line["component"], []).append(line["assembly"])

    for line in data["bom"]:
        db.add(
            BOMLine(
                assembly_id=parts[line["assembly"]].id,
                component_id=parts[line["component"]].id,
                quantity=int(line["qty"]),
                notes=line.get("notes"),
            )
        )
        if len(parent_count[line["component"]]) == 1:
            parts[line["component"]].parent_id = parts[line["assembly"]].id
    db.flush()


# ---------------------------------------------------------------------------
# Requirements
# ---------------------------------------------------------------------------


def _seed_requirements(
    db: Session,
    parts: dict[str, Part],
    users: dict[str, User],
    now: datetime,
) -> None:
    from opal.se.baseline import write_baseline_event
    from opal.se.lifecycle import baseline

    data = _data("requirements.json")
    baselined: list[Requirement] = []

    for entry in data["requirements"]:
        req = Requirement(
            req_number=generate_requirement_number(db),
            title=entry["title"],
            statement=entry["statement"],
            rationale=entry.get("rationale"),
            category=entry["category"],
            level=1,
            verification_method=entry["verification_method"],
        )
        if entry["state"] == "tbr":
            # A TBR carries an owner and an absolute closure date.
            req.tbr = True
            req.tbr_owner_id = users["test"].id
            req.tbr_due = now + timedelta(days=21)
        db.add(req)
        db.flush()

        if entry["state"] == "baselined":
            baseline(db, req, users["build"].id)
            baselined.append(req)

        for part_key in entry.get("allocations", []):
            status = "open"
            verified_at = None
            notes = None
            if entry["title"] == "Oxidizer tank static vent":
                status = "verified"
                verified_at = now - timedelta(days=15)
                notes = "1.2 mm (0.047 in) vent drilled per OP 1; verified clear at tank assembly."
            db.add(
                PartRequirement(
                    part_id=parts[part_key].id,
                    requirement_id=req.req_number,
                    requirement_ref_id=req.id,
                    status=status,
                    verified_at=verified_at,
                    verified_by_id=users["qa"].id if verified_at else None,
                    notes=notes,
                )
            )

    write_baseline_event(
        db,
        baselined,
        users["build"].id,
        label="hcr-5100-import",
        note="Initial baseline of the HCR-5100 guidebook requirement set.",
    )
    db.flush()


# ---------------------------------------------------------------------------
# Procedures (build + publish)
# ---------------------------------------------------------------------------


def _seed_procedures(
    db: Session,
    data: dict,
    parts: dict[str, Part],
    wc: dict[str, Workcenter],
) -> tuple[dict[str, MasterProcedure], dict[str, ProcedureVersion]]:
    procs: dict[str, MasterProcedure] = {}
    versions: dict[str, ProcedureVersion] = {}

    for pdata in data["procedures"]:
        proc = MasterProcedure(
            name=pdata["name"],
            description=pdata["description"],
            procedure_type=(ProcedureType.BUILD if pdata["type"] == "build" else ProcedureType.OP),
            status=ProcedureStatus.ACTIVE,
        )
        db.add(proc)
        db.flush()
        procs[pdata["key"]] = proc

        for item in pdata.get("kit", []):
            db.add(
                Kit(
                    procedure_id=proc.id,
                    part_id=parts[item["part"]].id,
                    quantity_required=Decimal(str(item["qty"])),
                )
            )
        if pdata.get("output"):
            db.add(
                ProcedureOutput(
                    procedure_id=proc.id,
                    part_id=parts[pdata["output"]["part"]].id,
                    quantity_produced=Decimal(str(pdata["output"]["qty"])),
                )
            )
        db.flush()

        order = 0
        normal_count = 0
        contingency_count = 0
        op_steps: dict[int, ProcedureStep] = {}
        for op_idx, op in enumerate(pdata["ops"], start=1):
            order += 1
            is_contingency = bool(op.get("is_contingency"))
            # Contingency ops number their own C-series, like the step API does.
            if is_contingency:
                contingency_count += 1
                op_number = f"C{contingency_count}"
            else:
                normal_count += 1
                op_number = str(normal_count)
            op_step = ProcedureStep(
                procedure_id=proc.id,
                order=order,
                step_number=op_number,
                level=0,
                title=op["title"],
                instructions=op.get("instructions"),
                caution=op.get("caution"),
                is_contingency=is_contingency,
                strict_sequence=bool(op.get("strict_sequence")),
                workcenter_id=wc[op["workcenter"]].id if op.get("workcenter") else None,
            )
            db.add(op_step)
            db.flush()
            op_steps[op_idx] = op_step
            for item in op.get("step_kit", []):
                part = parts[item["part"]]
                db.add(
                    StepKit(
                        step_id=op_step.id,
                        part_id=part.id,
                        quantity_required=Decimal(str(item["qty"])),
                        usage_type=UsageType.TOOLING if part.is_tooling else UsageType.CONSUME,
                    )
                )
            for sub_idx, sub in enumerate(op.get("sub_steps", []), start=1):
                order += 1
                db.add(
                    ProcedureStep(
                        procedure_id=proc.id,
                        parent_step_id=op_step.id,
                        order=order,
                        step_number=f"{op_number}.{sub_idx}",
                        level=1,
                        title=sub["title"],
                        instructions=sub.get("instructions"),
                        caution=sub.get("caution"),
                        is_contingency=is_contingency,
                        requires_signoff=bool(sub.get("requires_signoff")),
                        required_role=sub.get("required_role"),
                        required_data_schema=sub.get("schema"),
                        workcenter_id=wc[op["workcenter"]].id if op.get("workcenter") else None,
                    )
                )
        # Op-level prerequisites (JSON lists prereq op indices, 1-based).
        for op_idx, op in enumerate(pdata["ops"], start=1):
            for dep_idx in op.get("depends_on", []):
                db.add(
                    StepDependency(
                        step_id=op_steps[op_idx].id,
                        depends_on_step_id=op_steps[dep_idx].id,
                    )
                )
        db.flush()
        versions[pdata["key"]] = _publish(db, proc)

    return procs, versions


def _publish(db: Session, proc: MasterProcedure) -> ProcedureVersion:
    """Snapshot the procedure exactly like the publish endpoint does."""
    steps = (
        db.query(ProcedureStep)
        .filter(ProcedureStep.procedure_id == proc.id)
        .order_by(ProcedureStep.order)
        .all()
    )
    step_ids = [s.id for s in steps]
    step_kit_map: dict[int, list[StepKit]] = {}
    for sk in db.query(StepKit).filter(StepKit.step_id.in_(step_ids)).all():
        step_kit_map.setdefault(sk.step_id, []).append(sk)

    # Dependencies snapshot as prerequisite `order` values (mirrors the
    # publish endpoint) so the execution engine gates ops from the frozen copy.
    step_id_to_order = {s.id: s.order for s in steps}
    depends_on_map: dict[int, list[int]] = {}
    for dep in db.query(StepDependency).filter(StepDependency.step_id.in_(step_ids)).all():
        prereq_order = step_id_to_order.get(dep.depends_on_step_id)
        if prereq_order is not None:
            depends_on_map.setdefault(dep.step_id, []).append(prereq_order)

    content = {
        "procedure_name": proc.name,
        "procedure_description": proc.description,
        "steps": [
            {
                "id": s.id,
                "order": s.order,
                "step_number": s.step_number,
                "level": s.level,
                "parent_step_id": s.parent_step_id,
                "title": s.title,
                "instructions": s.instructions,
                "required_data_schema": s.required_data_schema,
                "is_contingency": s.is_contingency,
                "requires_signoff": s.requires_signoff,
                "estimated_duration_minutes": s.estimated_duration_minutes,
                "required_role": s.required_role,
                "caution": s.caution,
                "strict_sequence": s.strict_sequence,
                "workcenter_id": s.workcenter_id,
                "depends_on": sorted(depends_on_map.get(s.id, [])),
                "images": [],
                "step_kit": [
                    {
                        "part_id": sk.part_id,
                        "part_name": sk.part.name,
                        "quantity_required": float(sk.quantity_required),
                        "usage_type": sk.usage_type.value
                        if hasattr(sk.usage_type, "value")
                        else sk.usage_type,
                        "notes": sk.notes,
                    }
                    for sk in step_kit_map.get(s.id, [])
                ],
            }
            for s in steps
        ],
        "kit_items": [
            {"part_id": k.part_id, "quantity_required": float(k.quantity_required)}
            for k in db.query(Kit).filter(Kit.procedure_id == proc.id).all()
        ],
        "output_items": [
            {"part_id": o.part_id, "quantity_produced": float(o.quantity_produced)}
            for o in db.query(ProcedureOutput).filter(ProcedureOutput.procedure_id == proc.id).all()
        ],
    }
    version = ProcedureVersion(procedure_id=proc.id, version_number=1, content=content)
    db.add(version)
    db.flush()
    proc.current_version_id = version.id
    return version


# ---------------------------------------------------------------------------
# Purchases
# ---------------------------------------------------------------------------

# PO-0001: the big McMaster kit order, fully received.
_PO1_LINES = [
    "9452k226",
    "91255a378",
    "94579a550",
    "91306a279",
    "90264a435",
    "91367a952",
    "4112t22",
    "91280a044",
    "90591a141",
    "98689a113",
    "92148a160",
    "93475a210",
    "92855a310",
    "90480a009",
    "90272a194",
    "4468k858",
    "4468k031",
    "4468k865",
    "44665k137",
    "50675k135",
    "50675k435",
    "9685t3",
    "9396t31",
    "9452k15",
    "90213a101",
    "94095k114",
    "9396k79",
    "92141a029",
    "91102a750",
    "95505a601",
    "90281a102",
    "93135a013",
    "93505a211",
    "7712k511",
    "8947t26",
    "52555t644",
    "7619a11",
]

# PO-0002: spares per the maintenance schedule, partially received.
# (received?, key) — O-ring and gasket spares arrived; the rest is backordered.
_PO2_LINES = [
    (True, "94095k114", 2),
    (True, "9452k15", 1),
    (False, "9452k226", 1),
    (False, "90281a102", 2),
    (False, "98831a028", 2),
]


def _seed_purchases(
    db: Session,
    parts: dict[str, Part],
    suppliers: dict[str, Supplier],
    now: datetime,
) -> dict[str, PurchaseLine]:
    prices = {p["key"]: p.get("price") for p in _data("parts.json")["parts"]}
    bom_qty: dict[str, float] = {}
    for line in _data("parts.json")["bom"]:
        bom_qty[line["component"]] = bom_qty.get(line["component"], 0) + line["qty"]

    po_lines: dict[str, PurchaseLine] = {}

    po1 = Purchase(
        reference="PO-0001",
        supplier="McMaster-Carr",
        supplier_id=suppliers["McMaster-Carr"].id,
        status=PurchaseStatus.RECEIVED,
        ordered_at=now - timedelta(days=34),
        received_at=now - timedelta(days=30),
        destination="STORE",
        notes="Vehicle build kit — Appendix F McMaster order.",
    )
    db.add(po1)
    db.flush()
    for key in _PO1_LINES:
        qty = Decimal(str(max(int(bom_qty.get(key, 1)), 1)))
        line = PurchaseLine(
            purchase_id=po1.id,
            part_id=parts[key].id,
            qty_ordered=qty,
            qty_received=qty,
            unit_cost=Decimal(str(prices[key])) if prices.get(key) else None,
        )
        db.add(line)
        po_lines[key] = line

    po2 = Purchase(
        reference="PO-0002",
        supplier="McMaster-Carr",
        supplier_id=suppliers["McMaster-Carr"].id,
        status=PurchaseStatus.PARTIAL,
        ordered_at=now - timedelta(days=9),
        target_date=(now + timedelta(days=6)).date(),
        destination="STORE",
        notes="Maintenance spares: tank O-rings, graphite gaskets, QD seals, studs.",
    )
    db.add(po2)
    db.flush()
    for received, key, qty in _PO2_LINES:
        db.add(
            PurchaseLine(
                purchase_id=po2.id,
                part_id=parts[key].id,
                qty_ordered=Decimal(str(qty)),
                qty_received=Decimal(str(qty)) if received else Decimal("0"),
                unit_cost=Decimal(str(prices[key])) if prices.get(key) else None,
                notes=None if received else "Backordered",
            )
        )
    db.flush()
    return po_lines


# ---------------------------------------------------------------------------
# Inventory
# ---------------------------------------------------------------------------

_LOCATION_BY_CATEGORY = {
    "Propulsion": "STORE-A1",
    "Fluid System": "STORE-A2",
    "Valves": "STORE-A2",
    "Igniter": "STORE-A3",
    "Airframe": "STORE-B1",
    "Recovery": "STORE-B2",
    "Avionics": "ELEC-SHELF",
    "Consumables": "STORE-C1",
    "GSE": "PAD-BOX",
}

# Assembly parents that exist as BOM structure, not as shelf stock.
_NO_STOCK = {
    "vehicle",
    "gse",
    "tank_assy",
    "fluid_assy",
    "valve_assy_grp",
    "tca_assy",
    "igniter_assy",
    "airframe_assy",
    "recovery_assy",
    "avbay_assy",
    "gse_control",
    "gse_fill",
    "gse_enclosure",
    "gse_integration",
}

_LOT_PARTS = {
    "9452k226": "LOT-MCM-2606-A",
    "9452k15": "LOT-MCM-2606-A",
    "9396k79": "LOT-MCM-2606-B",
    "94095k114": "LOT-MCM-2606-B",
    "1834": "LOT-CRS-2605-EM",
    "1318": "LOT-CRS-2605-BP",
    "a3_4t": "LOT-EST-2604",
    "nitrous_oxide": "LOT-N2O-FILL-06",
    "e85": "LOT-E85-2606",
    "pla_fil_2kg": "LOT-PLA-2605",
    "52555t644": "LOT-MCM-2606-C",
}


def _seed_inventory(
    db: Session,
    parts_data: dict,
    procs_data: dict,
    parts: dict[str, Part],
    po_lines: dict[str, PurchaseLine],
    now: datetime,
) -> dict[str, InventoryRecord]:
    # Kit demand across all procedures drives sensible stock quantities.
    need: dict[str, float] = {}
    for proc in procs_data["procedures"]:
        for item in proc.get("kit", []):
            need[item["part"]] = need.get(item["part"], 0) + item["qty"]

    inventory: dict[str, InventoryRecord] = {}
    for entry in parts_data["parts"]:
        key = entry["key"]
        if key in _NO_STOCK or entry["lifecycle"] == "draft":
            continue
        part = parts[key]
        if entry["tracking"] == "serialized":
            qty = Decimal("1")
        else:
            qty = Decimal(str(max(int(need.get(key, 0)) * 3, 4)))
        po_line = po_lines.get(key)
        rec = InventoryRecord(
            part_id=part.id,
            opal_number=generate_opal_number(db),
            quantity=qty,
            location="SHOP-RACK"
            if entry["procurement"] == "make"
            else _LOCATION_BY_CATEGORY.get(part.category, "STORE-A1"),
            lot_number=_LOT_PARTS.get(key),
            source_type=SourceType.PURCHASE if po_line else SourceType.MANUAL,
            source_purchase_line_id=po_line.id if po_line else None,
        )
        db.add(rec)
        inventory[key] = rec
    db.flush()
    return inventory


# ---------------------------------------------------------------------------
# Executions — the live demo state
# ---------------------------------------------------------------------------


def _cut_instance(
    db: Session,
    proc: MasterProcedure,
    version: ProcedureVersion,
    status: InstanceStatus,
    started_by: User | None,
    started_at: datetime | None = None,
    completed_at: datetime | None = None,
) -> tuple[ProcedureInstance, dict[str, StepExecution]]:
    """Create an instance with one StepExecution per snapshot step (all PENDING).

    Returns the instance and a step_number_str -> StepExecution map.
    """
    inst = ProcedureInstance(
        procedure_id=proc.id,
        version_id=version.id,
        work_order_number=generate_work_order_number(db),
        status=status,
        started_by_id=started_by.id if started_by else None,
        started_at=started_at,
        completed_at=completed_at,
    )
    db.add(inst)
    db.flush()

    steps = version.content["steps"]
    id_to_order = {s["id"]: s["order"] for s in steps}
    by_number: dict[str, StepExecution] = {}
    for s in steps:
        se = StepExecution(
            instance_id=inst.id,
            step_number=s["order"],
            step_number_str=s["step_number"],
            level=s["level"],
            parent_step_order=id_to_order.get(s["parent_step_id"]),
            status=StepStatus.PENDING,
        )
        db.add(se)
        by_number[s["step_number"]] = se
    db.flush()
    return inst, by_number


def _complete_step(
    se: StepExecution,
    step: dict,
    at: datetime,
    user: User,
    data: dict | None = None,
) -> None:
    se.status = StepStatus.SIGNED_OFF if step["requires_signoff"] else StepStatus.COMPLETED
    se.started_at = at
    se.completed_at = at + timedelta(minutes=9)
    se.completed_by_id = user.id
    if step["requires_signoff"]:
        se.signed_off_at = se.completed_at
        se.signed_off_by_id = user.id
    if data is not None:
        se.data_captured = data


# Captured values for WO-1 (verbatim spec values from the guidebook steps).
_WO1_DATA = {
    "1.1": {"ends_square": "Square against machinist square — no light gap either end"},
    "5.4": {"piston_depth": 12.19},
    "5.9": {"fuel_hose_union_torque": 80},
    "5.10": {"fuel_hose_valve_torque": 80},
    "10.9": {"verified_7x_91306a279_screws_install": "All 7 install and thread freely"},
    "10.10": {"verified_8x_90272a194_screws_install": "8x aligned; simulated install OK"},
    "10.11": {"verified_4x_93135a013_shear_pins_seat": "4x seat flush through both tubes"},
}

_WO1_NOTES = [
    (
        "1.4",
        "test",
        timedelta(days=15, hours=6),
        "Drill jig bushing (93320A215) snug after the second hole — re-clamped and "
        "finished the pattern. All 8x 5/16 in holes gauge clean.",
    ),
    (
        "5.4",
        "build",
        timedelta(days=15, hours=2),
        "Piston seated at 12.19 in from the tube end on the marked PVC pusher — "
        "inside the 12.125-12.25 in window on the first push.",
    ),
    (
        "5.9",
        "build",
        timedelta(days=15, hours=1),
        "50675K135 union pulled to wrench-tight, call it 80 ft-lb per the step. Flare faces clean.",
    ),
    (
        "8.8",
        "test",
        timedelta(days=14, hours=20),
        "Both Quarks beep out continuity on drogue and main channels with the 9V packs installed.",
    ),
    (
        "11.20",
        "qa",
        timedelta(days=14, hours=3),
        "Final stack check done — shear pins flush, rail buttons clear the 1515 "
        "test rail section. Vehicle to transport crate as SN 001.",
    ),
]


def _seed_executions(
    db: Session,
    procs: dict[str, MasterProcedure],
    versions: dict[str, ProcedureVersion],
    parts: dict[str, Part],
    inventory: dict[str, InventoryRecord],
    users: dict[str, User],
    now: datetime,
) -> dict[str, Any]:
    build, test, qa = users["build"], users["test"], users["qa"]
    veh_proc, veh_version = procs["vehicle_assembly"], versions["vehicle_assembly"]
    veh_steps = {s["step_number"]: s for s in veh_version.content["steps"]}

    # ── WO-1: Vehicle Assembly, COMPLETED ───────────────────────
    wo1_start = now - timedelta(days=16)
    wo1, wo1_steps = _cut_instance(
        db,
        veh_proc,
        veh_version,
        InstanceStatus.COMPLETED,
        build,
        started_at=wo1_start,
        completed_at=now - timedelta(days=14),
    )
    t = wo1_start
    for s in veh_version.content["steps"]:
        se = wo1_steps[s["step_number"]]
        user = (build, test, qa)[s["order"] % 3]
        _complete_step(se, s, t, user, _WO1_DATA.get(s["step_number"]))
        t += timedelta(minutes=20)
    for step_num, username, ago, body in _WO1_NOTES:
        db.add(
            StepNote(
                step_execution_id=wo1_steps[step_num].id,
                author_id=users[username].id,
                body=body,
                created_at=now - ago,
            )
        )

    # Consume the vehicle kit from bulk stock (WO-1 built SN 001).
    kit_items = db.query(Kit).filter(Kit.procedure_id == veh_proc.id).all()
    part_key_by_id = {p.id: k for k, p in parts.items()}
    for item in kit_items:
        key = part_key_by_id[item.part_id]
        rec = inventory.get(key)
        tracking = parts[key].tracking_type
        tracking = tracking.value if hasattr(tracking, "value") else tracking
        if rec is None or tracking == "serialized":
            continue
        qty = min(item.quantity_required, rec.quantity)
        rec.quantity -= qty
        db.add(
            InventoryConsumption(
                inventory_record_id=rec.id,
                quantity=qty,
                procedure_instance_id=wo1.id,
                consumed_by_id=build.id,
            )
        )

    # Produced vehicle SN 001.
    veh_part = parts["vehicle"]
    veh_rec = InventoryRecord(
        part_id=veh_part.id,
        quantity=Decimal("1"),
        location="TRANSPORT-CRATE",
        lot_number=wo1.work_order_number,
        opal_number=generate_opal_number(db),
        source_type=SourceType.PRODUCTION,
    )
    db.add(veh_rec)
    db.flush()
    production = InventoryProduction(
        inventory_record_id=veh_rec.id,
        quantity=Decimal("1"),
        procedure_instance_id=wo1.id,
        serial_number=generate_serial_number(db, veh_part),
        produced_opal_number=veh_rec.opal_number,
        status=ProductionStatus.COMPLETED,
        produced_by_id=build.id,
    )
    db.add(production)
    db.flush()
    veh_rec.source_production_id = production.id

    # ── WO-2: Vehicle Assembly, IN WORK mid-OP-5 (tank assembly) ─
    wo2_start = now - timedelta(hours=26)
    wo2, wo2_steps = _cut_instance(
        db, veh_proc, veh_version, InstanceStatus.IN_WORK, build, started_at=wo2_start
    )
    # SN 002 allocation, planned until closeout.
    wo2_rec = InventoryRecord(
        part_id=veh_part.id,
        quantity=Decimal("0"),
        location="",
        lot_number=wo2.work_order_number,
        opal_number=generate_opal_number(db),
        source_type=SourceType.PRODUCTION,
    )
    db.add(wo2_rec)
    db.flush()
    wo2_prod = InventoryProduction(
        inventory_record_id=wo2_rec.id,
        quantity=Decimal("1"),
        procedure_instance_id=wo2.id,
        serial_number=generate_serial_number(db, veh_part),
        produced_opal_number=wo2_rec.opal_number,
        status=ProductionStatus.WIP,
        produced_by_id=build.id,
    )
    db.add(wo2_prod)
    db.flush()
    wo2_rec.source_production_id = wo2_prod.id

    t = wo2_start
    for s in veh_version.content["steps"]:
        num = s["step_number"]
        se = wo2_steps[num]
        op = int(num.split(".")[0])
        # OPs 1-4 fully complete; OP 5 (tank assembly) is mid-flight (its op
        # row stays PENDING until the op completes under the focus model).
        done = op <= 4 or num in ("5.1", "5.2", "5.3")
        if done:
            user = (build, test)[s["order"] % 2]
            _complete_step(
                se,
                s,
                t,
                user,
                {"ends_square": "Square — checked both ends"} if num == "1.1" else None,
            )
            t += timedelta(minutes=11)
    # The crew's position is presence (cursor), not status — the step ahead
    # of the completed work stays PENDING with a focus row.
    cursor = wo2_steps["5.4"]
    cursor.first_focused_at = now - timedelta(minutes=45)
    db.add(
        StepFocus(
            instance_id=wo2.id,
            step_execution_id=cursor.id,
            user_id=build.id,
            focused_at=now - timedelta(minutes=12),
        )
    )
    db.add(
        StepNote(
            step_execution_id=wo2_steps["5.1"].id,
            author_id=build.id,
            body="Step text calls for QTY 5 '-230' O-rings; the OP 5 kit is 4x "
            "9452K226 -238 (2x bulkheads, 2x piston). Greased the four -238s.",
            created_at=now - timedelta(hours=1, minutes=30),
        )
    )
    db.add(
        StepNote(
            step_execution_id=cursor.id,
            author_id=test.id,
            body="Holding before piston insertion until the O-ring callout NC is "
            "dispositioned — seals are inaccessible after this step.",
            created_at=now - timedelta(minutes=40),
        )
    )

    # ── WO-3: Launch Operations, CUT (staged, untouched) ────────
    wo3, _wo3_steps = _cut_instance(
        db, procs["launch_ops"], versions["launch_ops"], InstanceStatus.CUT, build
    )

    # ── WO-4: Servo-Actuated Ball Valve Assembly, COMPLETED ─────
    # The GSE fill valve build — shows the component flow end to end:
    # kit consumption in, serialized assembly out.
    valve_proc, valve_version = procs["valve_assembly"], versions["valve_assembly"]
    wo4_start = now - timedelta(days=3, hours=5)
    wo4, wo4_steps = _cut_instance(
        db,
        valve_proc,
        valve_version,
        InstanceStatus.COMPLETED,
        test,
        started_at=wo4_start,
        completed_at=now - timedelta(days=3, hours=3),
    )
    t = wo4_start
    for s in valve_version.content["steps"]:
        _complete_step(wo4_steps[s["step_number"]], s, t, test)
        t += timedelta(minutes=13)
    for item in db.query(Kit).filter(Kit.procedure_id == valve_proc.id).all():
        key = part_key_by_id[item.part_id]
        rec = inventory.get(key)
        tracking = parts[key].tracking_type
        tracking = tracking.value if hasattr(tracking, "value") else tracking
        if rec is None or tracking == "serialized":
            continue
        qty = min(item.quantity_required, rec.quantity)
        rec.quantity -= qty
        db.add(
            InventoryConsumption(
                inventory_record_id=rec.id,
                quantity=qty,
                procedure_instance_id=wo4.id,
                consumed_by_id=test.id,
            )
        )
    valve_part = parts["sabv_assy"]
    valve_rec = InventoryRecord(
        part_id=valve_part.id,
        quantity=Decimal("1"),
        location="STORE-A2",
        lot_number=wo4.work_order_number,
        opal_number=generate_opal_number(db),
        source_type=SourceType.PRODUCTION,
    )
    db.add(valve_rec)
    db.flush()
    valve_prod = InventoryProduction(
        inventory_record_id=valve_rec.id,
        quantity=Decimal("1"),
        procedure_instance_id=wo4.id,
        serial_number=generate_serial_number(db, valve_part),
        produced_opal_number=valve_rec.opal_number,
        status=ProductionStatus.COMPLETED,
        produced_by_id=test.id,
    )
    db.add(valve_prod)
    db.flush()
    valve_rec.source_production_id = valve_prod.id

    db.flush()
    return {
        "wo1": wo1,
        "wo1_steps": wo1_steps,
        "wo2": wo2,
        "wo2_steps": wo2_steps,
        "wo3": wo3,
        "veh_steps": veh_steps,
    }


# ---------------------------------------------------------------------------
# Issues — drawn from real guidebook errata (bom.json / ops meta.extraction_gaps)
# ---------------------------------------------------------------------------


def _seed_issues(
    db: Session,
    parts: dict[str, Part],
    procs: dict[str, MasterProcedure],
    wo: dict[str, Any],
    users: dict[str, User],
    now: datetime,
) -> dict[str, Issue]:
    build, test, qa = users["build"], users["test"], users["qa"]
    issues: dict[str, Issue] = {}

    # 1. Undispositioned NC on WO-2 (STEP containment, resolve-by boundary).
    #    Real erratum: the tank-assembly step text (guidebook OP 6, now OP 5)
    #    calls the tank seals "-230" (QTY 5); the gather list and BOM say
    #    4x 9452K226 -238.
    nc_oring = Issue(
        issue_number=generate_issue_number(db),
        title="OP 5 tank O-ring callout mismatch: '-230' x5 vs kit -238 x4",
        description=(
            "Raised during tank assembly on WO "
            f"{wo['wo2'].work_order_number}. The published step text and the "
            "kit disagree on both dash size and count; the installed seals "
            "follow the kit. Disposition before the piston goes in — the "
            "seals are unreachable afterwards."
        ),
        issue_type=IssueType.NON_CONFORMANCE,
        status=IssueStatus.OPEN,
        priority=IssuePriority.HIGH,
        containment=Containment.STEP,
        containment_step_id=wo["wo2_steps"]["5.4"].id,
        part_id=parts["9452k226"].id,
        procedure_id=procs["vehicle_assembly"].id,
        procedure_instance_id=wo["wo2"].id,
        raised_step_id=wo["wo2_steps"]["5.2"].id,
        raised_by_id=test.id,
        assigned_to_id=build.id,
        should_be="OP 5 gather list: 4x 9452K226 -238 Buna-N O-rings (2x bulkheads, 2x piston)",
        actual="Steps 1-3 text: 'a liberal amount of grease to the 5x Buna-N O-rings (-230)' "
        "— dash size and quantity disagree with the kit",
        created_at=now - timedelta(hours=1, minutes=10),
    )
    db.add(nc_oring)
    db.flush()
    db.add(
        IssueComment(
            issue_id=nc_oring.id,
            body="Physical parts on the bench are -238 from LOT-MCM-2606-A and match "
            "the tank gland drawings. Recommending USE AS IS with a doc redline "
            "against the step text.",
            created_at=now - timedelta(minutes=50),
        )
    )
    issues["nc_oring"] = nc_oring

    # 2. Advisory issue: airframe fabrication (guidebook OP 12, now OP 10)
    #    references a template missing from its gather list.
    adv = Issue(
        issue_number=generate_issue_number(db),
        title="OP 10 step 8 uses template TMPLT-AF-UPR2-416 absent from gather list",
        description=(
            "OP 10 step 8 calls out drill template TMPLT-AF-UPR2-416; the OP 10 "
            "gather list only carries TMPLT-AF-UPR-416 and the backing plug. "
            "Advisory — the on-hand template covers the hole pattern."
        ),
        issue_type=IssueType.NON_CONFORMANCE,
        status=IssueStatus.OPEN,
        priority=IssuePriority.LOW,
        containment=Containment.ADVISORY,
        part_id=parts["tmplt_af_upr_416"].id,
        procedure_id=procs["vehicle_assembly"].id,
        procedure_instance_id=wo["wo2"].id,
        raised_by_id=build.id,
        created_at=now - timedelta(days=1),
    )
    db.add(adv)
    issues["adv_template"] = adv

    # 3. Dispositioned USE AS IS (signed) — Appendix F stud-count duplication.
    stud = Issue(
        issue_number=generate_issue_number(db),
        title="Appendix F lists 16x 90281A102 studs; Section IV totals 14",
        description=(
            "Kitting for the first vehicle pulled 16 studs per Appendix F, which "
            "lists 90281A102 on two lines (qty 14 + qty 2); Section IV totals 14 "
            "(8x chamber tie rods + 6x airframe/coupler studs)."
        ),
        issue_type=IssueType.NON_CONFORMANCE,
        status=IssueStatus.OPEN,
        priority=IssuePriority.MEDIUM,
        containment=Containment.STEP,
        part_id=parts["90281a102"].id,
        procedure_id=procs["vehicle_assembly"].id,
        procedure_instance_id=wo["wo1"].id,
        raised_step_id=wo["wo1_steps"]["7.1"].id,
        containment_step_id=wo["wo1_steps"]["7.1"].id,
        raised_by_id=qa.id,
        should_be="Section IV usage: 8x TCA tie rods + 6x coupler/recovery studs = 14",
        actual="Appendix F vehicle McMaster table carries 90281A102 twice (14 + 2 = 16)",
        disposition_type=DispositionType.USE_AS_IS,
        disposition_rationale=(
            "Installed count verified against Section IV: 8 + 6 = 14. The Appendix F "
            "second line is a duplication; the two extra studs go to spares stock."
        ),
        dispositioned_at=now - timedelta(days=15, hours=4),
        dispositioned_by_id=qa.id,
        created_at=now - timedelta(days=15, hours=6),
    )
    db.add(stud)
    issues["stud_count"] = stud

    # 4. Closed NC — recovery screws PN/link discrepancy, corrected at receiving.
    screws = Issue(
        issue_number=generate_issue_number(db),
        title="Recovery BOM cites 94735A707; link and Appendix F use 93135A013",
        description=(
            "Recovery System BOM line 14 prints PN 94735A707, but both the "
            "Section IV link and the Appendix F order table point to 93135A013 "
            "(2-56 nylon pan head screws)."
        ),
        issue_type=IssueType.NON_CONFORMANCE,
        status=IssueStatus.CLOSED,
        priority=IssuePriority.LOW,
        containment=Containment.STEP,
        part_id=parts["93135a013"].id,
        raised_by_id=qa.id,
        should_be="One part number per part — BOM line, link, and order table agree",
        actual="BOM line prints 94735A707; the hardware received and both source "
        "links are 93135A013",
        root_cause="Typo on the printed BOM line; the ordering tables were correct.",
        corrective_action="Part record normalized to 93135A013; received stock "
        "verified against the McMaster label.",
        disposition_type=DispositionType.NO_DEFECT,
        disposition_rationale="Hardware on hand matches 93135A013 in both thread and "
        "material; document-only error.",
        dispositioned_at=now - timedelta(days=28),
        dispositioned_by_id=build.id,
        created_at=now - timedelta(days=29),
    )
    db.add(screws)
    issues["screws_pn"] = screws

    # 5. Field finding that realizes the recovery risk (maintenance trigger:
    #    insulated shock cord is replaced on tears or serious burns).
    shock = Issue(
        issue_number=generate_issue_number(db),
        title="Shock cord thermal damage found at recovery inspection",
        description=(
            "Post-flight inspection of SN 001 found burn-through of the insulated "
            "section of the 5/8 in tubular nylon shock cord. Maintenance schedule "
            "action: replace insulated shock cord on tears or serious burns — "
            "lack of maintenance may cause airframe/propulsion separation."
        ),
        issue_type=IssueType.NON_CONFORMANCE,
        status=IssueStatus.OPEN,
        priority=IssuePriority.HIGH,
        containment=Containment.ADVISORY,
        part_id=parts["rec_tnsc_3klb"].id,
        raised_by_id=test.id,
        assigned_to_id=build.id,
        should_be="Insulated shock cord free of tears and burn damage",
        actual="Burn-through of the Nomex-protected section adjacent to the drogue "
        "charge well; nylon core intact but glazed",
        created_at=now - timedelta(days=7),
    )
    db.add(shock)
    issues["shock_cord"] = shock

    # 6. Mitigation task for the N2O decomposition risk.
    clean = Issue(
        issue_number=generate_issue_number(db),
        title="Add contamination controls for N2O-wetted plumbing",
        description=(
            "Keep hydrocarbon contamination out of everything N2O touches: clean "
            "fittings and hoses before assembly, cap open lines between "
            "operations, and inspect the fill line and QD before each fill."
        ),
        issue_type=IssueType.TASK,
        status=IssueStatus.OPEN,
        priority=IssuePriority.HIGH,
        containment=Containment.ADVISORY,
        assigned_to_id=build.id,
        raised_by_id=qa.id,
        created_at=now - timedelta(days=11),
    )
    db.add(clean)
    issues["n2o_cleanliness"] = clean

    db.flush()
    return issues


# ---------------------------------------------------------------------------
# Risks — HCR-5100 §1.4 hazards, with P/I estimates from the extraction
# ---------------------------------------------------------------------------


def _seed_risks(
    db: Session,
    parts: dict[str, Part],
    users: dict[str, User],
    issues: dict[str, Issue],
) -> None:
    from opal.risks.dispositions import accept, set_disposition

    build, test, qa = users["build"], users["test"], users["qa"]
    owners = [build, test, qa]

    for i, entry in enumerate(_data("risks.json")["risks"]):
        risk = Risk(
            risk_number=generate_risk_number(db),
            title=entry["title"],
            description=entry["description"],
            condition=entry["condition"],
            departure=entry["departure"],
            asset_part_id=parts[entry["asset_part"]].id if entry.get("asset_part") else None,
            asset_text=entry.get("asset_text"),
            consequence=entry["consequence"],
            probability=entry["probability"],
            impact=entry["impact"],
            owner_id=owners[i % 3].id,
        )
        db.add(risk)
        db.flush()

        plan = entry.get("disposition")
        if plan == "mitigate":
            risk.residual_probability, risk.residual_impact = entry["residual"]
            db.add(
                RiskIssueLink(
                    risk_id=risk.id,
                    issue_id=issues[entry["mitigation_issue"]].id,
                    role=RiskIssueRole.MITIGATION.value,
                )
            )
            db.flush()
            set_disposition(db, risk, "mitigate", build.id)
        elif plan == "watch":
            risk.watch_observable = entry["watch_observable"]
            risk.watch_threshold = entry["watch_threshold"]
            risk.watch_contingency = entry["watch_contingency"]
            set_disposition(db, risk, "watch", build.id)
        elif plan == "accepted":
            risk.owner_id = qa.id
            # The signature moment goes through the core accept path so the
            # readiness rules hold for the demo row.
            accept(
                db,
                risk,
                build.id,
                rationale=(
                    "Exposure is brief skin contact during hose handling; PPE per "
                    "§7.1 (nitrile gloves, safety glasses) is already a launch-"
                    "procedure gate and the credible outcome is a minor cold burn. "
                    "Guidebook mitigation: " + entry["description"]
                ),
            )
        elif plan == "realized":
            risk.realized_issue_id = issues[entry["realized_issue"]].id
            db.flush()
            set_disposition(
                db,
                risk,
                "realized",
                test.id,
                note="Shock cord burn-through found at recovery inspection of SN 001.",
            )

    db.flush()


# ---------------------------------------------------------------------------
# Test templates — the two numeric checks the guidebook states outright
# ---------------------------------------------------------------------------


def _seed_test_templates(db: Session, parts: dict[str, Part]) -> None:
    db.add_all(
        [
            TestTemplate(
                part_id=parts["9v_batt"].id,
                name="Altimeter Battery Voltage",
                description="Measure open-circuit voltage. Replace below 8.2 V "
                "(HCR-5100 Table 2.10 spares guidance).",
                required=True,
                test_type="numeric",
                min_value=Decimal("8.2"),
                max_value=Decimal("9.9"),
                unit="V",
                sort_order=1,
            ),
            TestTemplate(
                part_id=parts["tank_36l_047v2x8x313c"].id,
                name="Static Vent Clear",
                description="Verify the 1.2 mm (0.047 in) static vent orifice is "
                "unobstructed (launch procedure 7.1 check).",
                required=True,
                test_type="boolean",
                sort_order=1,
            ),
        ]
    )
    db.flush()
