"""The execution document endpoint: /api/procedure-instances/{id}/document.

Ported from the old HTML-rendering tests. The document is the computed view
model the SPA renders: gates, holds, sequence waits, safety fields, notes,
evidence and material. Controls are inert exactly when the step's
``complete_blockers`` / ``skip_blockers`` are non-empty.
"""

from datetime import UTC, datetime

import pytest
from fastapi.testclient import TestClient
from sqlalchemy.orm import Session

from opal.db.models.execution import InstanceStatus, ProcedureInstance
from tests.conftest import grant_client_roles


@pytest.fixture(autouse=True)
def _template_roles(client, db_session):
    """Template roles must exist; the client holds the ones used here."""
    grant_client_roles(db_session, "TC", "QE", "MFG-LEAD")


# ============ builders ============


def _create_procedure_with_steps(client: TestClient, titles=("Step 1", "Step 2", "Step 3")) -> int:
    proc_id = client.post("/api/procedures", json={"name": "Doc Procedure"}).json()["id"]
    for title in titles:
        client.post(f"/api/procedures/{proc_id}/steps", json={"title": title})
    client.post(f"/api/procedures/{proc_id}/publish")
    return proc_id


def _create_instance(client: TestClient) -> int:
    proc_id = _create_procedure_with_steps(client)
    resp = client.post("/api/procedure-instances", json={"procedure_id": proc_id})
    assert resp.status_code == 201, resp.text
    return resp.json()["id"]


def _doc(client: TestClient, instance_id: int, headers: dict | None = None) -> dict:
    resp = client.get(f"/api/procedure-instances/{instance_id}/document", headers=headers or {})
    assert resp.status_code == 200, resp.text
    return resp.json()


def _step(doc: dict, order: int) -> dict:
    """A row (op row or sub-step) by snapshot order."""
    for op in doc["ops"] + doc["contingency_ops"]:
        if op["step"]["order"] == order:
            return op["step"]
        for s in op["steps"]:
            if s["order"] == order:
                return s
    raise AssertionError(f"step {order} not in document")


def _op(doc: dict, order: int) -> dict:
    return next(o for o in doc["ops"] + doc["contingency_ops"] if o["order"] == order)


def _build_instance_with_sub_steps(client: TestClient) -> tuple[int, dict[str, int]]:
    """OP 1 with two sub-steps; returns (instance_id, order by display number)."""
    proc_id = client.post("/api/procedures", json={"name": "Hold Doc Proc"}).json()["id"]
    op = client.post(f"/api/procedures/{proc_id}/steps", json={"title": "Assemble manifold"}).json()
    for title in ("Torque fasteners", "Inspect torque stripe"):
        client.post(
            f"/api/procedures/{proc_id}/steps", json={"title": title, "parent_step_id": op["id"]}
        )
    client.post(f"/api/procedures/{proc_id}/publish")
    inst = client.post("/api/procedure-instances", json={"procedure_id": proc_id}).json()
    return inst["id"], {s["step_number_str"]: s["step_number"] for s in inst["step_executions"]}


def _raise_nc(client: TestClient, instance_id: int, step_number: int, **extra) -> dict:
    resp = client.post(
        f"/api/procedure-instances/{instance_id}/steps/{step_number}/nc",
        json={"title": "Torque out of spec", "priority": "high", **extra},
    )
    assert resp.status_code == 201, resp.text
    return resp.json()


def _upload_capture(client: TestClient, se_id: int, note: str) -> dict:
    resp = client.post(
        "/api/attachments/upload",
        files={"file": ("evidence.png", b"\x89PNG\r\n\x1a\nfake", "image/png")},
        data={"step_execution_id": str(se_id), "kind": "capture", "note": note},
    )
    assert resp.status_code == 201, resp.text
    return resp.json()


# ============ structure ============


def test_document_structure(client: TestClient):
    instance_id = _create_instance(client)
    doc = _doc(client, instance_id)

    assert doc["instance"]["id"] == instance_id
    assert doc["instance"]["status"] == "cut"
    assert doc["instance"]["active"] is True
    assert doc["instance"]["procedure"]["name"] == "Doc Procedure"
    assert doc["instance"]["version"]["number"] == 1
    assert [o["number"] for o in doc["ops"]] == ["1", "2", "3"]
    assert doc["progress"] == {"done": 0, "total": 3}
    # A flat OP is its own leaf: no sub-steps, its row carries the body.
    assert doc["ops"][0]["steps"] == []
    assert doc["ops"][0]["step"]["title"] == "Step 1"


def test_document_404(client: TestClient):
    assert client.get("/api/procedure-instances/9999/document").status_code == 404


def test_document_requires_auth(app):
    anon = TestClient(app)
    assert anon.get("/api/procedure-instances/1/document").status_code == 401


def test_sub_steps_carry_op_prefix_and_progress(client: TestClient):
    instance_id, by_label = _build_instance_with_sub_steps(client)
    doc = _doc(client, instance_id)
    op = doc["ops"][0]
    assert [s["number"] for s in op["steps"]] == ["1.1", "1.2"]
    assert op["progress"] == {"done": 0, "total": 2}

    client.post(f"/api/procedure-instances/{instance_id}/steps/{by_label['1.1']}/complete", json={})
    op = _doc(client, instance_id)["ops"][0]
    assert op["progress"] == {"done": 1, "total": 2}
    assert op["steps"][0]["status"] == "completed"
    assert op["steps"][0]["completed"]["at"] is not None


def test_completed_op_status_is_terminal_pending_is_not(client: TestClient):
    """The client collapses terminal rows and keeps the rest open; the status
    is the only input to that policy."""
    instance_id = _create_instance(client)
    client.post(f"/api/procedure-instances/{instance_id}/steps/1/complete", json={})
    doc = _doc(client, instance_id)
    assert doc["ops"][0]["status"] == "completed"
    assert doc["ops"][1]["status"] == "pending"
    assert doc["instance"]["status"] == "in_work"
    assert doc["progress"] == {"done": 1, "total": 3}


def test_role_caution_and_images_fields(client: TestClient):
    proc_id = client.post("/api/procedures", json={"name": "Role Caution Proc"}).json()["id"]
    client.post(
        f"/api/procedures/{proc_id}/steps",
        json={"title": "Crimp leads", "required_role": "TC", "caution": "HOT SURFACE"},
    )
    client.post(f"/api/procedures/{proc_id}/publish")
    instance_id = client.post("/api/procedure-instances", json={"procedure_id": proc_id}).json()[
        "id"
    ]
    row = _doc(client, instance_id)["ops"][0]["step"]
    assert row["role"] == "TC"
    assert row["caution"] == "HOT SURFACE"
    assert row["images"] == []


def test_safety_fields_on_op_and_sub_step(client: TestClient):
    proc_id = client.post("/api/procedures", json={"name": "Hazardous Proc"}).json()["id"]
    op = client.post(
        f"/api/procedures/{proc_id}/steps",
        json={"title": "Pressurize system", "caution": "HIGH PRESSURE GAS", "required_role": "QE"},
    ).json()
    client.post(
        f"/api/procedures/{proc_id}/steps",
        json={
            "title": "Open valve",
            "parent_step_id": op["id"],
            "caution": "Stand clear of vent",
            "required_role": "MFG-LEAD",
        },
    )
    client.post(f"/api/procedures/{proc_id}/publish")
    inst = client.post("/api/procedure-instances", json={"procedure_id": proc_id}).json()

    op_doc = _doc(client, inst["id"])["ops"][0]
    assert op_doc["caution"] == "HIGH PRESSURE GAS"
    assert op_doc["role"] == "QE"
    sub = op_doc["steps"][0]
    assert sub["caution"] == "Stand clear of vent"
    assert sub["role"] == "MFG-LEAD"


def test_data_schema_and_captured_values(client: TestClient):
    proc_id = client.post("/api/procedures", json={"name": "Schema Doc Proc"}).json()["id"]
    client.post(
        f"/api/procedures/{proc_id}/steps",
        json={
            "title": "Torque bolts",
            "required_data_schema": {
                "fields": [
                    {
                        "name": "torque",
                        "label": "TORQUE",
                        "type": "number",
                        "required": True,
                        "unit": "Nm",
                    }
                ]
            },
        },
    )
    client.post(f"/api/procedures/{proc_id}/publish")
    instance_id = client.post("/api/procedure-instances", json={"procedure_id": proc_id}).json()[
        "id"
    ]
    step = _step(_doc(client, instance_id), 1)
    assert step["data_schema"]["fields"][0]["name"] == "torque"
    assert step["data_captured"] is None

    client.post(
        f"/api/procedure-instances/{instance_id}/steps/1/complete",
        json={"data_captured": {"torque": 12.5}},
    )
    doc = _doc(client, instance_id)
    assert _step(doc, 1)["data_captured"] == {"torque": 12.5}
    assert doc["data_rows"][0]["field"] == "TORQUE"
    assert doc["data_rows"][0]["value"] == "12.5"
    assert doc["data_rows"][0]["unit"] == "Nm"


# ============ sequence gates ============


def test_strict_sequence_and_op_dependency_waits(client: TestClient):
    proc_id = client.post("/api/procedures", json={"name": "Gated"}).json()["id"]
    op1 = client.post(f"/api/procedures/{proc_id}/steps", json={"title": "OP One"}).json()
    client.post(
        f"/api/procedures/{proc_id}/steps",
        json={"title": "A", "parent_step_id": op1["id"]},
    )
    op2 = client.post(
        f"/api/procedures/{proc_id}/steps", json={"title": "OP Two", "strict_sequence": True}
    ).json()
    for t in ("B", "C"):
        client.post(
            f"/api/procedures/{proc_id}/steps", json={"title": t, "parent_step_id": op2["id"]}
        )
    client.put(
        f"/api/procedures/{proc_id}/steps/{op2['id']}/dependencies",
        json={"depends_on": [op1["id"]]},
    )
    client.post(f"/api/procedures/{proc_id}/publish")
    instance_id = client.post("/api/procedure-instances", json={"procedure_id": proc_id}).json()[
        "id"
    ]

    doc = _doc(client, instance_id)
    op2_doc = doc["ops"][1]
    assert op2_doc["waiting_on_ops"] == ["1"]
    assert op2_doc["steps"][0]["waiting"] == "WAITING ON OP 1"
    assert any(b["kind"] == "dependency" for b in op2_doc["steps"][0]["complete_blockers"])

    # Finish OP 1: the dependency clears, the strict sequence takes over.
    client.post(f"/api/procedure-instances/{instance_id}/steps/2/complete", json={})
    doc = _doc(client, instance_id)
    op2_doc = doc["ops"][1]
    assert op2_doc["waiting_on_ops"] == []
    assert op2_doc["steps"][0]["waiting"] is None
    assert op2_doc["steps"][1]["waiting"] == f"WAITING ON {op2_doc['steps'][0]['number']}"
    assert any(b["kind"] == "sequence" for b in op2_doc["steps"][1]["complete_blockers"])


def test_op_over_open_children_has_children_blocker(client: TestClient):
    """An OP row over open children shows the standard gated control: an inert
    COMPLETE with the children reason (display numbers), never an absent one."""
    instance_id, by_label = _build_instance_with_sub_steps(client)
    op_row = _doc(client, instance_id)["ops"][0]["step"]
    kinds = {b["kind"]: b["message"] for b in op_row["complete_blockers"]}
    assert kinds["children"] == "Waiting on sub-steps 1.1, 1.2"


# ============ holds ============


def test_held_step_has_blockers_and_hold_chip(client: TestClient):
    instance_id, by_label = _build_instance_with_sub_steps(client)
    nc = _raise_nc(client, instance_id, by_label["1.1"])

    doc = _doc(client, instance_id)
    held = _step(doc, by_label["1.1"])
    complete = [b for b in held["complete_blockers"] if b["kind"] == "nc"]
    assert complete and complete[0]["issue_number"] == nc["issue_number"]
    assert complete[0]["issue_id"] == nc["id"]
    # SKIP inherits the held scope: a hold cannot be skipped around.
    assert any(b["kind"] == "nc" for b in held["skip_blockers"])
    assert held["holds"][0]["issue_number"] == nc["issue_number"]
    assert held["holds"][0]["kind"] == "raised"
    assert held["holds"][0]["disposition_state"] == "undispositioned"

    # The OP is held too, and its header names the issue.
    op = _op(doc, by_label["1"])
    assert [h["issue_number"] for h in op["holds"]] == [nc["issue_number"]]
    assert any(b["kind"] == "nc" for b in op["step"]["complete_blockers"])

    # Rail list: undispositioned hold names the steps it blocks.
    assert doc["holds"][0]["issue_number"] == nc["issue_number"]
    assert "1.1" in doc["holds"][0]["blocks"]
    assert doc["issues"][0]["state"] == "undispositioned"
    assert doc["issues"][0]["raised_step_number"] == "1.1"


def test_bound_hold_gates_boundary_step(client: TestClient):
    """A 'resolve by' boundary which the server refuses to COMPLETE reports
    blockers, so the client never renders an active control the server 400s."""
    proc_id = _create_procedure_with_steps(client)
    instance_id = client.post("/api/procedure-instances", json={"procedure_id": proc_id}).json()[
        "id"
    ]
    nc = client.post(
        f"/api/procedure-instances/{instance_id}/steps/1/nc",
        json={"title": "Bent pin found", "containment": "step", "containment_step_number": 3},
    )
    assert nc.status_code == 201, nc.text
    number = nc.json()["issue_number"]

    doc = _doc(client, instance_id)
    step3 = _step(doc, 3)
    assert [h["kind"] for h in step3["holds"]] == ["bound"]
    assert step3["holds"][0]["issue_number"] == number
    assert any(b["issue_number"] == number for b in step3["complete_blockers"])
    refused = client.post(f"/api/procedure-instances/{instance_id}/steps/3/complete", json={})
    assert refused.status_code == 400
    assert number in refused.json()["detail"]
    assert doc["holds"][0]["issue_number"] == number


def test_bound_hold_on_child_shows_in_op_header(client: TestClient):
    """A bound hold on a child gates that child's COMPLETE and so holds its OP;
    the OP's HELD BY line carries it, the raised OP's does not."""
    proc_id = client.post("/api/procedures", json={"name": "Bound op header"}).json()["id"]
    op1 = client.post(f"/api/procedures/{proc_id}/steps", json={"title": "OP One"}).json()
    client.post(
        f"/api/procedures/{proc_id}/steps", json={"title": "Sub 1.1", "parent_step_id": op1["id"]}
    )
    op2 = client.post(f"/api/procedures/{proc_id}/steps", json={"title": "OP Two"}).json()
    client.post(
        f"/api/procedures/{proc_id}/steps", json={"title": "Sub 2.1", "parent_step_id": op2["id"]}
    )
    client.post(f"/api/procedures/{proc_id}/publish")
    instance_id = client.post("/api/procedure-instances", json={"procedure_id": proc_id}).json()[
        "id"
    ]

    # Orders: OP1=1, 1.1=2, OP2=3, 2.1=4. Raised at 1.1, resolve by 2.1.
    nc = client.post(
        f"/api/procedure-instances/{instance_id}/steps/2/nc",
        json={"title": "Resolve downstream", "containment": "step", "containment_step_number": 4},
    )
    assert nc.status_code == 201, nc.text
    number = nc.json()["issue_number"]

    doc = _doc(client, instance_id)
    assert [h["issue_number"] for h in _op(doc, 3)["holds"]] == [number]
    assert _op(doc, 1)["holds"] == []


def test_signed_disposition_restores_controls(client: TestClient):
    instance_id, by_label = _build_instance_with_sub_steps(client)
    nc = _raise_nc(client, instance_id, by_label["1.1"])

    resp = client.post(
        f"/api/issues/{nc['id']}/disposition",
        json={"disposition_type": "use_as_is", "disposition_rationale": "within margin"},
    )
    assert resp.status_code == 200

    doc = _doc(client, instance_id)
    row = _step(doc, by_label["1.1"])
    assert not [b for b in row["complete_blockers"] if b["kind"] == "nc"]
    assert row["skip_blockers"] == []
    assert _op(doc, by_label["1"])["holds"] == []
    # The hold clears, the record stays: a residual line on the step it was raised at.
    assert row["issue_history"][0]["issue_number"] == nc["issue_number"]
    assert row["issue_history"][0]["disposition_type"] == "use_as_is"


def test_open_nc_makes_redline_available_only_on_its_op(client: TestClient):
    instance_id, by_label = _build_instance_with_sub_steps(client)
    assert _op(_doc(client, instance_id), by_label["1"])["open_ncs"] == []

    nc = _raise_nc(client, instance_id, by_label["1.1"])
    op = _op(_doc(client, instance_id), by_label["1"])
    assert [n["issue_number"] for n in op["open_ncs"]] == [nc["issue_number"]]


def test_redline_op_is_interleaved_before_its_host(client: TestClient):
    instance_id, by_label = _build_instance_with_sub_steps(client)
    nc = _raise_nc(client, instance_id, by_label["1.1"])
    resp = client.post(
        f"/api/procedure-instances/{instance_id}/ad-hoc-ops",
        json={
            "issue_id": nc["id"],
            "title": "Re-torque",
            "steps": [{"title": "Loosen"}, {"title": "Torque to spec"}],
        },
    )
    assert resp.status_code == 201, resp.text

    doc = _doc(client, instance_id)
    assert [o["is_ad_hoc"] for o in doc["ops"]] == [True, False]
    redline = doc["ops"][0]
    assert redline["number"] == "1R1"
    assert redline["redline"]["issue_number"] == nc["issue_number"]
    assert [s["number"] for s in redline["steps"]] == ["1R1.1", "1R1.2"]
    # The redline gates its host OP's steps.
    host = doc["ops"][1]
    assert any(b["kind"] == "redline" for b in host["steps"][1]["complete_blockers"])
    # A redline op is not itself a redline host.
    assert redline["open_ncs"] == []


# ============ presence ============


def test_cursor_is_presence_not_a_start(client: TestClient, auth_headers: dict, test_user):
    instance_id = _create_instance(client)
    focus = client.post(
        f"/api/procedure-instances/{instance_id}/focus",
        json={"step_number": 2},
        headers=auth_headers,
    )
    assert focus.status_code == 200, focus.text

    doc = _doc(client, instance_id, auth_headers)
    step2 = _step(doc, 2)
    assert [c["user_id"] for c in step2["cursors"]] == [test_user.id]
    assert step2["status"] == "pending"
    assert doc["my_cursor_order"] == 2
    assert doc["roster"][0]["step_number"] == "2"
    # Another viewer sees the cursor but does not own it.
    other = _doc(client, instance_id)
    assert other["my_cursor_order"] is None
    assert _step(other, 2)["cursors"][0]["name"] == test_user.name


# ============ notes, evidence, facts ============


def test_notes_are_ordered_and_authored(client: TestClient):
    instance_id = _create_instance(client)
    first = client.post(
        f"/api/procedure-instances/{instance_id}/steps/1/notes",
        json={"body": "coolant pressure drifting"},
    )
    assert first.status_code == 201, first.text
    client.post(
        f"/api/procedure-instances/{instance_id}/steps/1/notes", json={"body": "second observation"}
    )
    notes = _step(_doc(client, instance_id), 1)["notes"]
    assert [n["body"] for n in notes] == ["coolant pressure drifting", "second observation"]
    assert notes[0]["created_at"][:19] == first.json()["created_at"][:19]
    assert notes[0]["author"]["name"] == "Test Client"
    assert notes[0]["attachments"] == []


def test_notes_survive_closeout(client: TestClient, db_session: Session):
    """A note is a record, not a control: a completed work order still takes them."""
    instance_id = _create_instance(client)
    instance = db_session.query(ProcedureInstance).filter(ProcedureInstance.id == instance_id).one()
    instance.status = InstanceStatus.COMPLETED
    instance.completed_at = datetime.now(UTC)
    db_session.commit()

    resp = client.post(
        f"/api/procedure-instances/{instance_id}/steps/1/notes", json={"body": "post-mortem"}
    )
    assert resp.status_code == 201
    doc = _doc(client, instance_id)
    assert doc["instance"]["active"] is False
    assert _step(doc, 1)["notes"][0]["body"] == "post-mortem"


def test_step_evidence_and_reference_docs(client: TestClient):
    instance_id = _create_instance(client)
    se_id = next(
        se["id"]
        for se in client.get(f"/api/procedure-instances/{instance_id}").json()["step_executions"]
        if se["step_number"] == 1
    )
    uploaded = _upload_capture(client, se_id, "evidence note")
    assert uploaded["step_execution_id"] == se_id

    doc = _doc(client, instance_id)
    atts = _step(doc, 1)["attachments"]
    assert atts[0]["note"] == "evidence note"
    assert atts[0]["id"] == uploaded["id"]
    assert doc["reference_attachments"] == []


def test_instance_facts(client: TestClient, db_session: Session):
    instance_id = _create_instance(client)
    client.post(f"/api/procedure-instances/{instance_id}/steps/1/complete", json={})
    doc = _doc(client, instance_id)
    inst = doc["instance"]
    assert inst["created_by"] == "Test Client"
    assert inst["version"]["created_by"] == "Test Client"
    assert inst["started_at"] is not None
    assert inst["last_activity_at"] is not None
    assert inst["completed_at"] is None


# ============ material ============


def _create_kitted_instance(client: TestClient) -> tuple[int, dict, dict]:
    part = client.post(
        "/api/parts",
        json={
            "name": "Kit Resistor",
            "tracking_type": "bulk",
            "category": "Electronics",
            "tier": 3,
        },
    ).json()
    client.post(f"/api/parts/{part['id']}/activate", json={"cause": "test setup"})
    inv = client.post(
        "/api/inventory", json={"part_id": part["id"], "quantity": 100, "location": "STORE-A2"}
    ).json()["items"][0]
    proc_id = client.post("/api/procedures", json={"name": "Kitted Doc Proc"}).json()["id"]
    client.post(
        f"/api/procedures/{proc_id}/kit", json={"part_id": part["id"], "quantity_required": 5}
    )
    client.post(f"/api/procedures/{proc_id}/steps", json={"title": "Install parts"})
    client.post(f"/api/procedures/{proc_id}/publish")
    instance_id = client.post("/api/procedure-instances", json={"procedure_id": proc_id}).json()[
        "id"
    ]
    return instance_id, part, inv


def test_material_relevance_absent_without_kit(client: TestClient):
    """No kit, no outputs: nothing declares an expectation (empty-state rule)."""
    doc = _doc(client, _create_instance(client))
    assert doc["kit_relevant"] is False
    assert doc["material_relevant"] is False


def test_output_only_procedure_is_material_relevant(client: TestClient):
    """KITTING also hosts productions and FINALIZE: an output-only procedure
    must stay reachable or WIP productions are stranded (F7). Kit stays absent."""
    part = client.post(
        "/api/parts",
        json={"name": "Widget Output", "tracking_type": "bulk", "category": "Assemblies"},
    ).json()
    client.post(f"/api/parts/{part['id']}/activate", json={"cause": "test setup"})
    proc_id = client.post("/api/procedures", json={"name": "Output only"}).json()["id"]
    client.post(f"/api/procedures/{proc_id}/steps", json={"title": "Assemble"})
    out = client.post(
        f"/api/procedures/{proc_id}/outputs", json={"part_id": part["id"], "quantity_produced": 1}
    )
    assert out.status_code == 201, out.text
    client.post(f"/api/procedures/{proc_id}/publish")
    instance_id = client.post("/api/procedure-instances", json={"procedure_id": proc_id}).json()[
        "id"
    ]
    doc = _doc(client, instance_id)
    assert doc["kit_relevant"] is False
    assert doc["material_relevant"] is True
    assert doc["outputs"][0]["part_name"] == "Widget Output"


def test_consumed_rows_carry_provenance(client: TestClient):
    """A consumed row traces to the exact physical item: internal PN and OPAL number."""
    instance_id, part, inv = _create_kitted_instance(client)
    resp = client.post(
        f"/api/procedure-instances/{instance_id}/consume",
        json={"items": [{"inventory_record_id": inv["id"], "quantity": 5}]},
    )
    assert resp.status_code == 200, resp.text

    doc = _doc(client, instance_id)
    assert doc["kit_relevant"] is True
    row = doc["consumptions"][0]
    assert row["part_number"] == part["internal_pn"]
    assert row["part_id"] == part["id"]
    assert row["opal_number"] == inv["opal_number"]
    assert row["quantity"] == 5
    bom = doc["kit"]["items"][0]
    assert bom["part_number"] == part["internal_pn"]
    assert (bom["qty_required"], bom["qty_consumed"], bom["variance"]) == (5, 5, 0)


def test_step_consumption_attaches_to_its_step(client: TestClient):
    instance_id, part, inv = _create_kitted_instance(client)
    resp = client.post(
        f"/api/procedure-instances/{instance_id}/steps/1/consume",
        json={
            "items": [{"inventory_record_id": inv["id"], "quantity": 2, "usage_type": "consume"}]
        },
    )
    assert resp.status_code == 200, resp.text
    doc = _doc(client, instance_id)
    cons = _step(doc, 1)["consumptions"]
    assert cons[0]["quantity"] == 2
    assert cons[0]["step_number"] == "1"
    # Unplanned: none; the kit part is consumed short of its requirement.
    assert doc["kit"]["unplanned"] == []
    assert doc["kit"]["items"][0]["variance"] == -3
