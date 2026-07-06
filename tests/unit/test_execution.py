"""Execution API tests."""


def _create_procedure_with_steps(client):
    """Helper to create a procedure with steps and publish it."""
    # Create procedure
    proc_response = client.post(
        "/api/procedures",
        json={"name": "Test Procedure"},
    )
    proc_id = proc_response.json()["id"]

    # Add steps
    client.post(f"/api/procedures/{proc_id}/steps", json={"title": "Step 1"})
    client.post(f"/api/procedures/{proc_id}/steps", json={"title": "Step 2"})
    client.post(f"/api/procedures/{proc_id}/steps", json={"title": "Step 3"})

    # Publish
    version_response = client.post(f"/api/procedures/{proc_id}/publish")
    version_id = version_response.json()["id"]

    return proc_id, version_id


def _create_instance(client):
    """Helper to create a procedure and instance, returns instance_id."""
    proc_id, _ = _create_procedure_with_steps(client)
    resp = client.post(
        "/api/procedure-instances",
        json={"procedure_id": proc_id},
    )
    return resp.json()["id"]


def _create_procedure_with_kit(client, auth_headers):
    """Create a procedure with kit items, inventory for those items, and an instance.

    Returns (instance_id, kit_part_id, inventory_record_id).
    """
    # Create kit part
    part_resp = client.post(
        "/api/parts",
        json={"name": "Kit Resistor", "tracking_type": "bulk", "category": "Electronics"},
    )
    kit_part_id = part_resp.json()["id"]
    client.post(f"/api/parts/{kit_part_id}/activate", json={"cause": "test setup"})

    # Create inventory for the kit part
    inv_resp = client.post(
        "/api/inventory",
        json={"part_id": kit_part_id, "quantity": 100, "location": "Storage"},
        headers=auth_headers,
    )
    inv_record_id = inv_resp.json()["items"][0]["id"]

    # Create procedure with kit
    proc_resp = client.post(
        "/api/procedures",
        json={"name": "Kit Procedure"},
    )
    proc_id = proc_resp.json()["id"]

    # Add kit item to procedure
    client.post(
        f"/api/procedures/{proc_id}/kit",
        json={"part_id": kit_part_id, "quantity_required": 5},
        headers=auth_headers,
    )

    # Add steps and publish
    client.post(f"/api/procedures/{proc_id}/steps", json={"title": "Install parts"})
    client.post(f"/api/procedures/{proc_id}/steps", json={"title": "Verify"})
    client.post(f"/api/procedures/{proc_id}/publish")

    # Create instance
    inst_resp = client.post(
        "/api/procedure-instances",
        json={"procedure_id": proc_id},
    )
    instance_id = inst_resp.json()["id"]

    return instance_id, kit_part_id, inv_record_id


def _create_build_procedure(client, auth_headers):
    """Create a BUILD procedure with outputs, inventory for kit, and an instance.

    Returns (instance_id, output_part_id).
    """
    # Create output part
    output_resp = client.post(
        "/api/parts",
        json={"name": "Assembled Board", "category": "Assemblies"},
    )
    output_part_id = output_resp.json()["id"]
    client.post(f"/api/parts/{output_part_id}/activate", json={"cause": "test setup"})

    # Create BUILD procedure
    proc_resp = client.post(
        "/api/procedures",
        json={"name": "Build Procedure", "procedure_type": "build"},
    )
    proc_id = proc_resp.json()["id"]

    # Add output
    client.post(
        f"/api/procedures/{proc_id}/outputs",
        json={"part_id": output_part_id, "quantity_produced": 1},
        headers=auth_headers,
    )

    # Add steps and publish
    client.post(f"/api/procedures/{proc_id}/steps", json={"title": "Solder"})
    client.post(f"/api/procedures/{proc_id}/steps", json={"title": "Inspect"})
    client.post(f"/api/procedures/{proc_id}/publish")

    # Create instance (auto-allocates production for BUILD types)
    inst_resp = client.post(
        "/api/procedure-instances",
        json={"procedure_id": proc_id},
    )
    instance_id = inst_resp.json()["id"]

    return instance_id, output_part_id


# ============ Original tests ============


def test_create_instance(client):
    """Test creating a procedure instance."""
    proc_id, version_id = _create_procedure_with_steps(client)

    response = client.post(
        "/api/procedure-instances",
        json={"procedure_id": proc_id, "work_order_number": "WO-001"},
    )
    assert response.status_code == 201

    data = response.json()
    assert data["procedure_id"] == proc_id
    assert data["version_id"] == version_id
    assert data["work_order_number"] == "WO-001"
    assert data["status"] == "cut"
    assert len(data["step_executions"]) == 3


def test_batch_cut_creates_n_instances(client):
    """quantity > 1 cuts a batch of identical work orders with distinct WO numbers."""
    proc_id, _ = _create_procedure_with_steps(client)

    response = client.post(
        "/api/procedure-instances",
        json={"procedure_id": proc_id, "quantity": 3},
    )
    assert response.status_code == 201
    assert response.json()["status"] == "cut"

    resp = client.get(f"/api/procedure-instances?procedure_id={proc_id}")
    items = resp.json()["items"]
    assert len(items) == 3
    assert len({i["work_order_number"] for i in items}) == 3
    assert all(i["status"] == "cut" for i in items)
    assert all(len(i["step_executions"]) == 3 for i in items)


def test_batch_cut_rejects_explicit_work_order_number(client):
    """An explicit WO number identifies a single cut; batches must generate."""
    proc_id, _ = _create_procedure_with_steps(client)

    response = client.post(
        "/api/procedure-instances",
        json={"procedure_id": proc_id, "quantity": 2, "work_order_number": "WO-X"},
    )
    assert response.status_code == 400


def test_list_instances(client):
    """Test listing instances."""
    proc_id, _ = _create_procedure_with_steps(client)

    client.post("/api/procedure-instances", json={"procedure_id": proc_id})
    client.post("/api/procedure-instances", json={"procedure_id": proc_id})

    response = client.get("/api/procedure-instances")
    assert response.status_code == 200

    data = response.json()
    assert data["total"] >= 2


def test_get_instance(client):
    """Test getting a specific instance."""
    proc_id, _ = _create_procedure_with_steps(client)

    create_response = client.post(
        "/api/procedure-instances",
        json={"procedure_id": proc_id},
    )
    instance_id = create_response.json()["id"]

    response = client.get(f"/api/procedure-instances/{instance_id}")
    assert response.status_code == 200
    assert response.json()["id"] == instance_id


def test_complete_from_pending_sets_started_at_and_flips_instance(client):
    """Completing a pending step records started_at and moves the WO to in_work."""
    proc_id, _ = _create_procedure_with_steps(client)

    instance_response = client.post(
        "/api/procedure-instances",
        json={"procedure_id": proc_id},
    )
    instance_id = instance_response.json()["id"]

    # Complete step 1 directly — there is no separate start moment.
    response = client.post(f"/api/procedure-instances/{instance_id}/steps/1/complete", json={})
    assert response.status_code == 200
    assert response.json()["status"] == "completed"
    assert response.json()["started_at"] is not None

    instance = client.get(f"/api/procedure-instances/{instance_id}").json()
    assert instance["status"] == "in_work"


def test_complete_step(client):
    """Test completing a step."""
    proc_id, _ = _create_procedure_with_steps(client)

    instance_response = client.post(
        "/api/procedure-instances",
        json={"procedure_id": proc_id},
    )
    instance_id = instance_response.json()["id"]

    response = client.post(
        f"/api/procedure-instances/{instance_id}/steps/1/complete",
        json={"data_captured": {"notes": "Done"}},
    )
    assert response.status_code == 200
    assert response.json()["status"] == "completed"
    assert response.json()["data_captured"] == {"notes": "Done"}


def test_complete_all_steps_completes_instance(client):
    """Test that completing all steps completes the instance."""
    proc_id, _ = _create_procedure_with_steps(client)

    instance_response = client.post(
        "/api/procedure-instances",
        json={"procedure_id": proc_id},
    )
    instance_id = instance_response.json()["id"]

    # Complete all steps
    for step in [1, 2, 3]:
        client.post(f"/api/procedure-instances/{instance_id}/steps/{step}/complete", json={})

    # Instance should be completed
    instance = client.get(f"/api/procedure-instances/{instance_id}").json()
    assert instance["status"] == "completed"
    assert instance["completed_at"] is not None


def test_log_non_conformance(client):
    """Test logging a non-conformance creates an issue."""
    proc_id, _ = _create_procedure_with_steps(client)

    instance_response = client.post(
        "/api/procedure-instances",
        json={"procedure_id": proc_id},
    )
    instance_id = instance_response.json()["id"]

    response = client.post(
        f"/api/procedure-instances/{instance_id}/steps/1/nc",
        json={
            "title": "Test NC",
            "description": "Something went wrong",
            "priority": "high",
        },
    )
    assert response.status_code == 201

    data = response.json()
    assert data["title"] == "Test NC"
    assert data["issue_type"] == "non_conformance"
    assert data["priority"] == "high"
    assert data["procedure_instance_id"] == instance_id


def test_abort_instance(client):
    """Test aborting an instance."""
    proc_id, _ = _create_procedure_with_steps(client)

    instance_response = client.post(
        "/api/procedure-instances",
        json={"procedure_id": proc_id},
    )
    instance_id = instance_response.json()["id"]

    # Put the instance in work (first complete flips cut -> in_work).
    client.post(f"/api/procedure-instances/{instance_id}/steps/1/complete", json={})

    # Abort
    response = client.patch(
        f"/api/procedure-instances/{instance_id}",
        json={"status": "aborted"},
    )
    assert response.status_code == 200
    assert response.json()["status"] == "aborted"
    assert response.json()["completed_at"] is not None


def test_cannot_complete_completed_step(client):
    """Test cannot complete a step that's already completed."""
    proc_id, _ = _create_procedure_with_steps(client)

    instance_response = client.post(
        "/api/procedure-instances",
        json={"procedure_id": proc_id},
    )
    instance_id = instance_response.json()["id"]

    client.post(f"/api/procedure-instances/{instance_id}/steps/1/complete", json={})

    # Try to complete again
    response = client.post(f"/api/procedure-instances/{instance_id}/steps/1/complete", json={})
    assert response.status_code == 400


# ============ New tests — Step Operations ============


def test_step_notes_append_ordering_and_author(client):
    """Notes append (never overwrite), stay chronological, carry the author
    and an ISO-8601 timestamp, and flow through instance + state payloads."""
    from datetime import datetime

    instance_id = _create_instance(client)
    url = f"/api/procedure-instances/{instance_id}/steps/1/notes"

    r1 = client.post(url, json={"body": "first"})
    assert r1.status_code == 201
    note1 = r1.json()
    assert note1["body"] == "first"
    assert note1["author_id"] is not None
    assert note1["author"]
    datetime.fromisoformat(note1["created_at"])  # ISO 8601 or raises

    r2 = client.post(url, json={"body": "second"})
    assert r2.status_code == 201
    assert r2.json()["id"] != note1["id"]

    inst = client.get(f"/api/procedure-instances/{instance_id}").json()
    step1 = next(s for s in inst["step_executions"] if s["step_number"] == 1)
    assert [n["body"] for n in step1["notes"]] == ["first", "second"]

    state = client.get(f"/api/procedure-instances/{instance_id}/state").json()
    s1 = next(s for s in state["steps"] if s["order"] == 1)
    assert [n["body"] for n in s1["notes"]] == ["first", "second"]
    assert s1["notes"][0]["author"] == note1["author"]
    datetime.fromisoformat(s1["notes"][0]["created_at"])


def test_step_note_empty_body_rejected(client):
    instance_id = _create_instance(client)
    resp = client.post(
        f"/api/procedure-instances/{instance_id}/steps/1/notes",
        json={"body": "   "},
    )
    assert resp.status_code == 400


def test_step_note_create_is_audited(client, db_session):
    from opal.db.models import AuditLog

    instance_id = _create_instance(client)
    resp = client.post(
        f"/api/procedure-instances/{instance_id}/steps/1/notes",
        json={"body": "audited"},
    )
    assert resp.status_code == 201
    note_id = resp.json()["id"]
    entry = (
        db_session.query(AuditLog)
        .filter(AuditLog.table_name == "step_note", AuditLog.record_id == note_id)
        .one()
    )
    action = entry.action.value if hasattr(entry.action, "value") else entry.action
    assert action == "create"
    assert entry.new_values["body"] == "audited"


def test_step_note_allowed_on_terminal_step_and_closed_instance(client):
    """Notes are a record, not a control: terminal steps and closed work
    orders still take notes (post-mortem debugging)."""
    instance_id = _create_instance(client)

    resp = client.post(f"/api/procedure-instances/{instance_id}/steps/1/complete", json={})
    assert resp.status_code == 200

    r = client.post(
        f"/api/procedure-instances/{instance_id}/steps/1/notes",
        json={"body": "observed after completion"},
    )
    assert r.status_code == 201

    resp = client.patch(f"/api/procedure-instances/{instance_id}", json={"status": "aborted"})
    assert resp.status_code == 200

    r = client.post(
        f"/api/procedure-instances/{instance_id}/steps/2/notes",
        json={"body": "post-mortem on aborted WO"},
    )
    assert r.status_code == 201


def test_complete_with_notes_appends_note(client):
    """The complete flow's optional notes ride the same append path."""
    instance_id = _create_instance(client)

    resp = client.post(
        f"/api/procedure-instances/{instance_id}/steps/1/complete",
        json={"notes": "torque within spec"},
    )
    assert resp.status_code == 200
    assert [n["body"] for n in resp.json()["notes"]] == ["torque within spec"]

    inst = client.get(f"/api/procedure-instances/{instance_id}").json()
    step1 = next(s for s in inst["step_executions"] if s["step_number"] == 1)
    assert [n["body"] for n in step1["notes"]] == ["torque within spec"]
    assert step1["notes"][0]["author_id"] is not None


def test_skip_step(client):
    """Test skipping a step with a reason."""
    instance_id = _create_instance(client)

    resp = client.post(
        f"/api/procedure-instances/{instance_id}/steps/2/skip",
        json={"reason": "Not applicable for this config"},
    )
    assert resp.status_code == 200
    assert resp.json()["status"] == "skipped"
    assert resp.json()["data_captured"]["skip_reason"] == "Not applicable for this config"


def test_skip_step_completes_instance(client):
    """Test that skipping the last pending step completes the instance."""
    instance_id = _create_instance(client)

    # Complete steps 1 and 2, skip step 3
    for step in [1, 2]:
        client.post(f"/api/procedure-instances/{instance_id}/steps/{step}/complete", json={})

    client.post(
        f"/api/procedure-instances/{instance_id}/steps/3/skip",
        json={"reason": "N/A"},
    )

    instance = client.get(f"/api/procedure-instances/{instance_id}").json()
    assert instance["status"] == "completed"


def test_get_version_content(client):
    """Test getting version content for an instance."""
    instance_id = _create_instance(client)

    resp = client.get(f"/api/procedure-instances/{instance_id}/version-content")
    assert resp.status_code == 200
    data = resp.json()
    assert "steps" in data
    assert len(data["steps"]) == 3


# ============ New tests — Instance Operations ============


def test_update_instance_priority(client):
    """Test updating instance priority."""
    instance_id = _create_instance(client)

    resp = client.patch(
        f"/api/procedure-instances/{instance_id}",
        json={"priority": 5},
    )
    assert resp.status_code == 200
    assert resp.json()["priority"] == 5


def test_instance_not_found(client):
    """Test getting a nonexistent instance returns 404."""
    resp = client.get("/api/procedure-instances/99999")
    assert resp.status_code == 404


def test_list_instances_filter_by_status(client):
    """Test filtering instances by status."""
    instance_id = _create_instance(client)

    # First complete flips the instance to in_work (one of three steps —
    # completing all of them would flip it to completed).
    client.post(f"/api/procedure-instances/{instance_id}/steps/1/complete", json={})

    resp = client.get("/api/procedure-instances?status=in_work")
    assert resp.status_code == 200
    data = resp.json()
    assert instance_id in {item["id"] for item in data["items"]}
    for item in data["items"]:
        assert item["status"] == "in_work"


# ============ New tests — Kit & Consumption ============


def test_kit_availability(client, auth_headers):
    """Test checking kit availability."""
    instance_id, kit_part_id, _ = _create_procedure_with_kit(client, auth_headers)

    resp = client.get(f"/api/procedure-instances/{instance_id}/kit-availability")
    assert resp.status_code == 200
    data = resp.json()
    assert data["all_available"] is True
    assert len(data["items"]) == 1
    assert data["items"][0]["part_id"] == kit_part_id
    assert data["items"][0]["is_available"] is True
    # Source locations carry the physical-item identity for the consume-from
    # select: OPAL # per record, UoM at the item level.
    assert "uom" in data["items"][0]
    location = data["items"][0]["available_locations"][0]
    assert location["opal_number"].startswith("OPAL-")
    assert location["location"]


def test_consume_kit(client, auth_headers):
    """Test consuming kit parts from inventory."""
    instance_id, _, inv_record_id = _create_procedure_with_kit(client, auth_headers)

    resp = client.post(
        f"/api/procedure-instances/{instance_id}/consume",
        json={"items": [{"inventory_record_id": inv_record_id, "quantity": 5}]},
        headers=auth_headers,
    )
    assert resp.status_code == 200
    data = resp.json()
    assert len(data) == 1
    assert data[0]["quantity"] == 5

    # Verify inventory was deducted
    inv = client.get(f"/api/inventory/{inv_record_id}").json()
    assert float(inv["quantity"]) == 95


def test_consume_step_parts(client, auth_headers):
    """Test consuming parts at a specific step."""
    instance_id, _, inv_record_id = _create_procedure_with_kit(client, auth_headers)

    resp = client.post(
        f"/api/procedure-instances/{instance_id}/steps/1/consume",
        json={
            "items": [
                {"inventory_record_id": inv_record_id, "quantity": 3, "usage_type": "consume"}
            ]
        },
        headers=auth_headers,
    )
    assert resp.status_code == 200
    assert len(resp.json()) == 1
    assert resp.json()[0]["quantity"] == 3


def test_get_consumptions(client, auth_headers):
    """Test getting all consumption records for an instance."""
    instance_id, _, inv_record_id = _create_procedure_with_kit(client, auth_headers)

    # Consume some parts
    client.post(
        f"/api/procedure-instances/{instance_id}/consume",
        json={"items": [{"inventory_record_id": inv_record_id, "quantity": 2}]},
        headers=auth_headers,
    )

    resp = client.get(f"/api/procedure-instances/{instance_id}/consumptions")
    assert resp.status_code == 200
    assert len(resp.json()) >= 1


def test_get_step_consumptions(client, auth_headers):
    """Test getting consumptions for a specific step."""
    instance_id, _, inv_record_id = _create_procedure_with_kit(client, auth_headers)

    # Consume at step 1 — consumption does not require any step status.
    client.post(
        f"/api/procedure-instances/{instance_id}/steps/1/consume",
        json={"items": [{"inventory_record_id": inv_record_id, "quantity": 1}]},
        headers=auth_headers,
    )

    resp = client.get(f"/api/procedure-instances/{instance_id}/steps/1/consumptions")
    assert resp.status_code == 200
    assert len(resp.json()) >= 1


# ============ New tests — Production & Finalization ============


def test_get_outputs(client, auth_headers):
    """Test getting expected outputs for a build procedure."""
    instance_id, output_part_id = _create_build_procedure(client, auth_headers)

    resp = client.get(f"/api/procedure-instances/{instance_id}/outputs")
    assert resp.status_code == 200
    data = resp.json()
    assert len(data) >= 1
    assert data[0]["part_id"] == output_part_id


def test_produce_output(client, auth_headers):
    """Test producing output items from a procedure instance."""
    instance_id, output_part_id = _create_build_procedure(client, auth_headers)

    resp = client.post(
        f"/api/procedure-instances/{instance_id}/produce",
        json={
            "items": [
                {
                    "part_id": output_part_id,
                    "quantity": 1,
                    "location": "Assembly Floor",
                    "serial_number": "SN-001",
                }
            ]
        },
        headers=auth_headers,
    )
    assert resp.status_code == 200
    data = resp.json()
    assert len(data) == 1
    assert data[0]["part_id"] == output_part_id
    assert data[0]["serial_number"] == "SN-001"


def test_get_productions(client, auth_headers):
    """Test getting production records for a build procedure instance."""
    instance_id, _ = _create_build_procedure(client, auth_headers)

    # Build procedures auto-allocate production, so there should be at least one
    resp = client.get(f"/api/procedure-instances/{instance_id}/productions")
    assert resp.status_code == 200
    assert len(resp.json()) >= 1


# ============ New tests — Multi-user ============


def test_join_execution(client, auth_headers):
    """Test joining an execution as a participant."""
    instance_id = _create_instance(client)

    resp = client.post(
        f"/api/procedure-instances/{instance_id}/join",
        headers=auth_headers,
    )
    assert resp.status_code == 200
    data = resp.json()
    assert data["instance_id"] == instance_id
    assert len(data["participants"]) == 1


def test_leave_execution(client, auth_headers):
    """Test leaving an execution."""
    instance_id = _create_instance(client)

    # Join first
    client.post(
        f"/api/procedure-instances/{instance_id}/join",
        headers=auth_headers,
    )

    # Then leave
    resp = client.post(
        f"/api/procedure-instances/{instance_id}/leave",
        headers=auth_headers,
    )
    assert resp.status_code == 200
    assert resp.json()["status"] == "left"

    # Verify no participants
    participants = client.get(f"/api/procedure-instances/{instance_id}/participants").json()
    assert len(participants["participants"]) == 0


# ============ Containment / hold tests (Issues R2) ============
#
# Holds are derived from undispositioned issues, never stored on the step.
# The blocking predicate is `undispositioned`, not `open`.


def _log_nc(client, instance_id, step_number=1, title="NC A", **extra):
    """Log an NC against a step. Returns (issue_id, nc_body)."""
    resp = client.post(
        f"/api/procedure-instances/{instance_id}/steps/{step_number}/nc",
        json={"title": title, "priority": "medium", **extra},
    )
    assert resp.status_code == 201, resp.text
    body = resp.json()
    return body["id"], body


def _sign(client, issue_id, dtype="use_as_is", rationale="acceptable as built"):
    resp = client.post(
        f"/api/issues/{issue_id}/disposition",
        json={"disposition_type": dtype, "disposition_rationale": rationale},
    )
    assert resp.status_code == 200, resp.text
    return resp.json()


def test_nc_capture_prefills_context(client):
    """(§10.1) Capture carries the should-be/is pair and containment, and
    links back to the raising step — the form asks nothing the context knows."""
    instance_id = _create_instance(client)
    issue_id, body = _log_nc(
        client, instance_id, should_be='1.500" bolt circle', actual='1.505" measured'
    )
    assert body["issue_number"].startswith("IT-")
    assert body["containment"] == "step"

    issue = client.get(f"/api/issues/{issue_id}").json()
    assert issue["procedure_instance_id"] == instance_id
    assert issue["raised_step_id"] is not None
    assert issue["should_be"] == '1.500" bolt circle'
    assert issue["actual"] == '1.505" measured'
    assert issue["disp_state"] == "undispositioned"


def test_undispositioned_nc_blocks_step_complete(client):
    """(§10.2) COMPLETE is a commitment moment: an undispositioned
    step-containment issue makes it impossible, and the 400 names the issue."""
    instance_id = _create_instance(client)
    _, body = _log_nc(client, instance_id)

    resp = client.post(f"/api/procedure-instances/{instance_id}/steps/1/complete", json={})
    assert resp.status_code == 400
    assert "IT-" in resp.json()["detail"]

    # The step's stored status is untouched — the hold is derived.
    inst = client.get(f"/api/procedure-instances/{instance_id}").json()
    assert next(s["status"] for s in inst["step_executions"] if s["step_number"] == 1) == "pending"


def test_undispositioned_nc_blocks_skip(client):
    """SKIP is a terminal commitment — skipping held work would sweep the hold."""
    instance_id = _create_instance(client)
    _, body = _log_nc(client, instance_id)

    resp = client.post(
        f"/api/procedure-instances/{instance_id}/steps/1/skip",
        json={"reason": "trying to bypass"},
    )
    assert resp.status_code == 400
    assert body["issue_number"] in resp.json()["detail"]


def test_sign_disposition_releases_hold_issue_stays_open(client):
    """(§10.3) Signing releases the containment immediately; the issue stays
    open for corrective-action tracking."""
    instance_id = _create_instance(client)
    issue_id, _ = _log_nc(client, instance_id)

    signed = _sign(client, issue_id)
    assert signed["disp_state"] == "dispositioned"
    assert signed["status"] == "open"

    resp = client.post(f"/api/procedure-instances/{instance_id}/steps/1/complete", json={})
    assert resp.status_code == 200


def test_two_ncs_both_must_be_dispositioned(client):
    """With two undispositioned NCs on a step, COMPLETE stays absent until
    both are signed."""
    instance_id = _create_instance(client)
    issue_a, _ = _log_nc(client, instance_id, title="NC A")
    issue_b, _ = _log_nc(client, instance_id, title="NC B")

    _sign(client, issue_a, "rework", "rework per redline")
    resp = client.post(f"/api/procedure-instances/{instance_id}/steps/1/complete", json={})
    assert resp.status_code == 400

    _sign(client, issue_b)
    resp = client.post(f"/api/procedure-instances/{instance_id}/steps/1/complete", json={})
    assert resp.status_code == 200


def test_advisory_issue_blocks_nothing(client):
    instance_id = _create_instance(client)
    _log_nc(client, instance_id, containment="advisory")

    resp = client.post(f"/api/procedure-instances/{instance_id}/steps/1/complete", json={})
    assert resp.status_code == 200


def test_get_holds_endpoint(client):
    """(§7) get_holds answers 'are we held and why' instantly."""
    instance_id = _create_instance(client)
    issue_id, body = _log_nc(client, instance_id)

    holds = client.get(f"/api/procedure-instances/{instance_id}/holds").json()
    assert holds["held"] is True
    assert holds["holds"][0]["issue_number"] == body["issue_number"]
    assert holds["holds"][0]["containment"] == "step"
    assert any("COMPLETE" in b for b in holds["holds"][0]["blocks"])

    _sign(client, issue_id)
    holds = client.get(f"/api/procedure-instances/{instance_id}/holds").json()
    assert holds["held"] is False
    assert holds["holds"] == []


def test_wo_containment_blocks_instance_completion(client):
    """wo containment: every step runs, but the work order cannot close out
    until the disposition is signed — at which point it completes."""
    instance_id = _create_instance(client)
    issue_id, _ = _log_nc(client, instance_id, containment="wo")

    for step in (1, 2, 3):
        resp = client.post(
            f"/api/procedure-instances/{instance_id}/steps/{step}/complete", json={}
        )
        assert resp.status_code == 200, resp.text

    inst = client.get(f"/api/procedure-instances/{instance_id}").json()
    assert inst["status"] == "in_work"

    _sign(client, issue_id)
    inst = client.get(f"/api/procedure-instances/{instance_id}").json()
    assert inst["status"] == "completed"


def test_bound_future_step_blocks_complete(client):
    """containment_step_id bound to a future step ('resolve by 3'): work
    continues up to the boundary, whose COMPLETE is blocked until disposition."""
    instance_id = _create_instance(client)
    issue_id, _ = _log_nc(client, instance_id)
    inst = client.get(f"/api/procedure-instances/{instance_id}").json()
    se_by_num = {s["step_number"]: s["id"] for s in inst["step_executions"]}

    # Bind the boundary to step 3 (widen from the raised step).
    resp = client.post(
        f"/api/issues/{issue_id}/containment",
        json={"containment": "step", "containment_step_id": se_by_num[3]},
    )
    assert resp.status_code == 200

    # The raised step can now complete (the hold moved to the boundary)...
    resp = client.post(f"/api/procedure-instances/{instance_id}/steps/1/complete", json={})
    assert resp.status_code == 200
    resp = client.post(f"/api/procedure-instances/{instance_id}/steps/2/complete", json={})
    assert resp.status_code == 200

    # ...but the boundary step cannot COMPLETE.
    resp = client.post(f"/api/procedure-instances/{instance_id}/steps/3/complete", json={})
    assert resp.status_code == 400
    assert "IT-" in resp.json()["detail"]

    _sign(client, issue_id)
    resp = client.post(f"/api/procedure-instances/{instance_id}/steps/3/complete", json={})
    assert resp.status_code == 200


# ============ Redline / ad-hoc op tests ============


def _create_redline_setup(client):
    """Create an instance, log an NC on step 1, return (instance_id, issue_id, host_step_exec_id)."""
    instance_id = _create_instance(client)
    issue_id, _ = _log_nc(client, instance_id)
    inst = client.get(f"/api/procedure-instances/{instance_id}").json()
    host_se_id = next(s["id"] for s in inst["step_executions"] if s["step_number"] == 1)
    return instance_id, issue_id, host_se_id


def test_redline_creation_and_step_numbering(client):
    """Creating a redline op yields step_number_str '1R1' with sub-steps '1R1.1', '1R1.2'."""
    instance_id, issue_id, _ = _create_redline_setup(client)
    resp = client.post(
        f"/api/procedure-instances/{instance_id}/ad-hoc-ops",
        json={
            "issue_id": issue_id,
            "title": "Rework fastener",
            "steps": [
                {"title": "Remove old fastener"},
                {"title": "Install new fastener"},
            ],
        },
    )
    assert resp.status_code == 201, resp.text
    body = resp.json()
    assert body["step_number_str"] == "1R1"
    assert len(body["sub_steps"]) == 2
    assert [s["step_number_str"] for s in body["sub_steps"]] == ["1R1.1", "1R1.2"]
    assert body["host_order"] == 1
    assert body["issue_id"] == issue_id


def test_redline_rides_completion(client):
    """The disposition authorizes the deviation; the redline records the
    recovery. An undispositioned NC blocks the raised step's COMPLETE; signing
    releases the NC hold but the pending redline op still gates the step.
    The WO cannot complete until the redline sub-step is executed."""
    instance_id, issue_id, _ = _create_redline_setup(client)
    op_resp = client.post(
        f"/api/procedure-instances/{instance_id}/ad-hoc-ops",
        json={
            "issue_id": issue_id,
            "title": "Rework",
            "steps": [{"title": "Do rework"}],
        },
    ).json()
    sub_step_number = op_resp["sub_steps"][0]["step_number"]

    # Undispositioned: the raised step's COMPLETE is absent.
    resp = client.post(f"/api/procedure-instances/{instance_id}/steps/1/complete", json={})
    assert resp.status_code == 400

    # Sign the disposition — the NC hold releases, but the pending redline op
    # still gates step 1 (incomplete redline op blocks host-step COMPLETE).
    _sign(client, issue_id, "rework", "rework per redline 1R1")

    # Complete the redline sub-step first → the redline op auto-completes,
    # clearing the redline gate; step 1 can then complete.
    client.post(
        f"/api/procedure-instances/{instance_id}/steps/{sub_step_number}/complete",
        json={},
    )
    resp = client.post(f"/api/procedure-instances/{instance_id}/steps/1/complete", json={})
    assert resp.status_code == 200

    # Finish the snapshot steps → WO completes.
    for step in (2, 3):
        client.post(f"/api/procedure-instances/{instance_id}/steps/{step}/complete", json={})
    inst = client.get(f"/api/procedure-instances/{instance_id}").json()
    assert inst["status"] == "completed"


def test_redline_orphan_when_nc_soft_deleted(client):
    """If the NC is soft-deleted while the redline is unstarted, the host op
    is no longer gated by that orphan redline."""
    instance_id, issue_id, _ = _create_redline_setup(client)
    op_resp = client.post(
        f"/api/procedure-instances/{instance_id}/ad-hoc-ops",
        json={
            "issue_id": issue_id,
            "title": "Rework",
            "steps": [{"title": "Do rework"}],
        },
    ).json()
    # Soft-delete the NC.
    del_resp = client.delete(f"/api/issues/{issue_id}")
    assert del_resp.status_code == 204

    # The redline rows persist as historical record.
    inst = client.get(f"/api/procedure-instances/{instance_id}").json()
    redline_op_step_num = op_resp["step_number"]
    assert any(s["step_number"] == redline_op_step_num for s in inst["step_executions"])

    # The orphan no longer gates anything: the soft-deleted NC stops deriving
    # a hold, so the host step completes freely.
    resp = client.post(f"/api/procedure-instances/{instance_id}/steps/1/complete", json={})
    assert resp.status_code == 200
    list_resp = client.get(f"/api/procedure-instances/{instance_id}/ad-hoc-ops")
    assert list_resp.status_code == 200
    assert len(list_resp.json()) == 1


def test_redline_delete_rejected_once_worked(client):
    """A pending redline can be deleted; once any sub-step has been worked
    (no longer pending), deletion is rejected."""
    instance_id, issue_id, _ = _create_redline_setup(client)
    op_resp = client.post(
        f"/api/procedure-instances/{instance_id}/ad-hoc-ops",
        json={
            "issue_id": issue_id,
            "title": "Rework",
            "steps": [{"title": "Do rework"}],
        },
    ).json()
    op_id = op_resp["id"]
    sub_step_number = op_resp["sub_steps"][0]["step_number"]

    # Complete the sub-step → delete should now fail.
    client.post(f"/api/procedure-instances/{instance_id}/steps/{sub_step_number}/complete", json={})
    fail = client.delete(f"/api/procedure-instances/{instance_id}/ad-hoc-ops/{op_id}")
    assert fail.status_code == 400


def test_redline_requires_nc(client):
    """A non-NC issue can't be used as a redline anchor."""
    instance_id = _create_instance(client)
    # Manually create a non-NC issue via the issues API.
    resp = client.post(
        "/api/issues",
        json={
            "title": "Generic bug",
            "issue_type": "bug",
            "priority": "low",
            "procedure_instance_id": instance_id,
        },
    )
    issue_id = resp.json()["id"]
    bad = client.post(
        f"/api/procedure-instances/{instance_id}/ad-hoc-ops",
        json={
            "issue_id": issue_id,
            "title": "Bogus",
            "steps": [{"title": "Step"}],
        },
    )
    assert bad.status_code == 400


def test_skip_blocked_by_open_redline_after_disposition(client):
    """F5: after the disposition is signed the NC hold releases, but an open
    redline-rework op still gates the host step. SKIP must refuse just as
    COMPLETE does — skipping the host step cannot strand authorized rework."""
    instance_id, issue_id, _ = _create_redline_setup(client)
    op_resp = client.post(
        f"/api/procedure-instances/{instance_id}/ad-hoc-ops",
        json={"issue_id": issue_id, "title": "Rework", "steps": [{"title": "Do rework"}]},
    ).json()
    sub_step_number = op_resp["sub_steps"][0]["step_number"]

    _sign(client, issue_id, "rework", "rework per redline")

    # COMPLETE refuses on the open redline...
    resp = client.post(f"/api/procedure-instances/{instance_id}/steps/1/complete", json={})
    assert resp.status_code == 400
    assert "redline" in resp.json()["detail"].lower()

    # ...and so must SKIP (F5): the redline gate applies to both.
    skip = client.post(f"/api/procedure-instances/{instance_id}/steps/1/skip", json={})
    assert skip.status_code == 400
    assert "redline" in skip.json()["detail"].lower()

    # Once the redline sub-step is executed, the gate clears and SKIP works.
    client.post(
        f"/api/procedure-instances/{instance_id}/steps/{sub_step_number}/complete", json={}
    )
    skip = client.post(f"/api/procedure-instances/{instance_id}/steps/1/skip", json={})
    assert skip.status_code == 200, skip.text
    assert skip.json()["status"] == "skipped"


def test_skip_not_blocked_by_strict_sequence_predecessor(client):
    """F5 (scope boundary): SKIP deliberately omits strict_sequence predecessor
    ordering — a later sub-step may be skipped even with its predecessors still
    pending. Only the held scope and the redline class gate SKIP."""
    proc_id = client.post("/api/procedures", json={"name": "Strict skip"}).json()["id"]
    op = client.post(
        f"/api/procedures/{proc_id}/steps",
        json={"title": "Strict OP", "strict_sequence": True},
    ).json()
    client.post(
        f"/api/procedures/{proc_id}/steps", json={"title": "Sub 1", "parent_step_id": op["id"]}
    )
    client.post(
        f"/api/procedures/{proc_id}/steps", json={"title": "Sub 2", "parent_step_id": op["id"]}
    )
    client.post(f"/api/procedures/{proc_id}/publish")
    instance_id = client.post(
        "/api/procedure-instances", json={"procedure_id": proc_id}
    ).json()["id"]
    # Orders: OP=1, 1.1=2, 1.2=3. COMPLETE on 1.2 is sequence-gated...
    blocked = client.post(f"/api/procedure-instances/{instance_id}/steps/3/complete", json={})
    assert blocked.status_code == 400
    assert "Waiting on" in blocked.json()["detail"]
    # ...but SKIP on 1.2 is allowed with 1.1 still pending.
    skip = client.post(f"/api/procedure-instances/{instance_id}/steps/3/skip", json={})
    assert skip.status_code == 200, skip.text
    assert skip.json()["status"] == "skipped"


# ============ Containment scope across the op hierarchy ============


def _create_instance_with_sub_steps(client):
    """Create a procedure with OP A (two sub-steps) and OP B (one sub-step).
    Returns (instance_id, op_a_order, op_a_sub1_order, op_a_sub2_order, op_b_order).
    """
    proc_resp = client.post("/api/procedures", json={"name": "Sub-step Procedure"})
    proc_id = proc_resp.json()["id"]
    op_a = client.post(f"/api/procedures/{proc_id}/steps", json={"title": "OP A"}).json()
    client.post(
        f"/api/procedures/{proc_id}/steps",
        json={"title": "A.1", "parent_step_id": op_a["id"]},
    )
    client.post(
        f"/api/procedures/{proc_id}/steps",
        json={"title": "A.2", "parent_step_id": op_a["id"]},
    )
    op_b = client.post(f"/api/procedures/{proc_id}/steps", json={"title": "OP B"}).json()
    client.post(
        f"/api/procedures/{proc_id}/steps",
        json={"title": "B.1", "parent_step_id": op_b["id"]},
    )
    client.post(f"/api/procedures/{proc_id}/publish")
    inst_resp = client.post("/api/procedure-instances", json={"procedure_id": proc_id})
    instance_id = inst_resp.json()["id"]
    inst = client.get(f"/api/procedure-instances/{instance_id}").json()
    steps = inst["step_executions"]
    by_label = {s["step_number_str"]: s["step_number"] for s in steps}
    return (
        instance_id,
        by_label["1"],
        by_label["1.1"],
        by_label["1.2"],
        by_label["2"],
    )


def test_parent_op_complete_refused_while_children_open(client):
    """Manual COMPLETE of an OP row with non-terminal sub-steps is refused —
    the auto-complete path requires all children terminal, and the manual
    path must agree (rehearsal finding 2026-07-06). Once the children are
    done the OP auto-completes; there is nothing left to complete by hand."""
    instance_id, op_a, a1, a2, _op_b = _create_instance_with_sub_steps(client)

    resp = client.post(f"/api/procedure-instances/{instance_id}/steps/{op_a}/complete", json={})
    assert resp.status_code == 400
    # Display numbers, never the document-global snapshot order: the children
    # live at global orders 2 and 3 but render as 1.1 and 1.2 (F1).
    assert "Waiting on sub-steps 1.1, 1.2" in resp.json()["detail"]

    client.post(f"/api/procedure-instances/{instance_id}/steps/{a1}/complete", json={})
    resp = client.post(f"/api/procedure-instances/{instance_id}/steps/{op_a}/complete", json={})
    assert resp.status_code == 400  # one child still open
    assert "Waiting on sub-steps 1.2" in resp.json()["detail"]

    client.post(f"/api/procedure-instances/{instance_id}/steps/{a2}/complete", json={})
    inst = client.get(f"/api/procedure-instances/{instance_id}").json()
    op_row = next(s for s in inst["step_executions"] if s["step_number"] == op_a)
    assert op_row["status"] == "completed"  # auto-completed with the last child


def test_parent_op_skip_refused_while_children_open(client):
    """SKIP is a terminal commitment like COMPLETE: skipping an OP row over
    non-terminal sub-steps would strand them under a terminal parent, so the
    children gate holds SKIP too (F5)."""
    instance_id, op_a, a1, a2, _op_b = _create_instance_with_sub_steps(client)

    resp = client.post(f"/api/procedure-instances/{instance_id}/steps/{op_a}/skip", json={})
    assert resp.status_code == 400
    assert "Waiting on sub-steps 1.1, 1.2" in resp.json()["detail"]

    # Children terminal (one skipped, one completed) → the OP auto-completes;
    # the refusal never deadlocks the document.
    client.post(f"/api/procedure-instances/{instance_id}/steps/{a1}/skip", json={})
    client.post(f"/api/procedure-instances/{instance_id}/steps/{a2}/complete", json={})
    inst = client.get(f"/api/procedure-instances/{instance_id}").json()
    op_row = next(s for s in inst["step_executions"] if s["step_number"] == op_a)
    assert op_row["status"] == "completed"


def test_childless_op_skip_unaffected_by_children_gate(client):
    """A leaf OP (no sub-steps) carries no children blocker — SKIP commits."""
    proc_id = client.post("/api/procedures", json={"name": "Leaf skip"}).json()["id"]
    client.post(f"/api/procedures/{proc_id}/steps", json={"title": "Only OP"})
    client.post(f"/api/procedures/{proc_id}/publish")
    instance_id = client.post("/api/procedure-instances", json={"procedure_id": proc_id}).json()[
        "id"
    ]
    resp = client.post(f"/api/procedure-instances/{instance_id}/steps/1/skip", json={})
    assert resp.status_code == 200, resp.text
    assert resp.json()["status"] == "skipped"


def test_nc_on_sub_step_blocks_parent_op_complete(client):
    """(§10.2) A step-containment issue makes both the raised step's COMPLETE
    and its OP's COMPLETE absent — the 400 names the issue."""
    instance_id, op_a, a1, _a2, _op_b = _create_instance_with_sub_steps(client)
    nc = client.post(
        f"/api/procedure-instances/{instance_id}/steps/{a1}/nc",
        json={"title": "NC on A.1", "priority": "medium"},
    ).json()

    resp = client.post(f"/api/procedure-instances/{instance_id}/steps/{a1}/complete", json={})
    assert resp.status_code == 400
    assert nc["issue_number"] in resp.json()["detail"]

    resp = client.post(f"/api/procedure-instances/{instance_id}/steps/{op_a}/complete", json={})
    assert resp.status_code == 400
    assert nc["issue_number"] in resp.json()["detail"]


def test_sibling_sub_step_can_start_under_step_containment(client):
    """Step containment holds only its scope — sibling work continues."""
    instance_id, _op_a, a1, a2, _op_b = _create_instance_with_sub_steps(client)
    client.post(
        f"/api/procedure-instances/{instance_id}/steps/{a1}/nc",
        json={"title": "NC", "priority": "medium"},
    )
    resp = client.post(f"/api/procedure-instances/{instance_id}/steps/{a2}/complete", json={})
    assert resp.status_code == 200


def test_disposition_releases_sub_step_and_op(client):
    """Signing the disposition releases the raised step and the op completes
    when its children do."""
    instance_id, op_a, a1, a2, _op_b = _create_instance_with_sub_steps(client)
    nc = client.post(
        f"/api/procedure-instances/{instance_id}/steps/{a1}/nc",
        json={"title": "NC", "priority": "medium"},
    ).json()
    _sign(client, nc["id"])

    assert (
        client.post(f"/api/procedure-instances/{instance_id}/steps/{a1}/complete", json={})
        .status_code
        == 200
    )
    assert (
        client.post(f"/api/procedure-instances/{instance_id}/steps/{a2}/complete", json={})
        .status_code
        == 200
    )
    inst = client.get(f"/api/procedure-instances/{instance_id}").json()
    by_num = {s["step_number"]: s["status"] for s in inst["step_executions"]}
    assert by_num[op_a] == "completed"


def test_op_containment_blocks_op_complete_not_steps(client):
    """(§10.5) op containment: every step in the OP may run, but the OP
    cannot COMPLETE until the disposition is signed."""
    instance_id, op_a, a1, a2, _op_b = _create_instance_with_sub_steps(client)
    nc = client.post(
        f"/api/procedure-instances/{instance_id}/steps/{a1}/nc",
        json={"title": "Resolve by end of OP", "priority": "medium", "containment": "op"},
    ).json()

    # Steps inside the OP run and complete freely...
    assert (
        client.post(f"/api/procedure-instances/{instance_id}/steps/{a1}/complete", json={})
        .status_code
        == 200
    )
    assert (
        client.post(f"/api/procedure-instances/{instance_id}/steps/{a2}/complete", json={})
        .status_code
        == 200
    )

    # ...but the OP does not auto-complete and cannot be completed.
    inst = client.get(f"/api/procedure-instances/{instance_id}").json()
    by_num = {s["step_number"]: s["status"] for s in inst["step_executions"]}
    assert by_num[op_a] != "completed"
    resp = client.post(f"/api/procedure-instances/{instance_id}/steps/{op_a}/complete", json={})
    assert resp.status_code == 400
    assert nc["issue_number"] in resp.json()["detail"]

    # Signing releases the OP — with all children already done, it
    # auto-completes on release.
    _sign(client, nc["id"])
    inst = client.get(f"/api/procedure-instances/{instance_id}").json()
    by_num = {s["step_number"]: s["status"] for s in inst["step_executions"]}
    assert by_num[op_a] == "completed"


# ============ Sub-steps on gated ops are not completable (issue #2) ============


def test_sub_step_cannot_complete_when_parent_op_has_unmet_prereqs(client):
    """OP B has OP A as a dependency. A sub-step of OP B must not be completable
    until OP A is terminal."""
    # Build a procedure: OP A, OP B (depends on A) with one sub-step.
    proc_resp = client.post("/api/procedures", json={"name": "Gated Sub Procedure"})
    proc_id = proc_resp.json()["id"]
    op_a = client.post(f"/api/procedures/{proc_id}/steps", json={"title": "OP A"}).json()
    op_b = client.post(f"/api/procedures/{proc_id}/steps", json={"title": "OP B"}).json()
    b1 = client.post(
        f"/api/procedures/{proc_id}/steps",
        json={"title": "B.1", "parent_step_id": op_b["id"]},
    ).json()
    # Declare OP B depends on OP A.
    client.put(
        f"/api/procedures/{proc_id}/steps/{op_b['id']}/dependencies",
        json={"depends_on": [op_a["id"]]},
    )
    client.post(f"/api/procedures/{proc_id}/publish")
    inst_resp = client.post("/api/procedure-instances", json={"procedure_id": proc_id})
    instance_id = inst_resp.json()["id"]
    inst = client.get(f"/api/procedure-instances/{instance_id}").json()
    by_label = {s["step_number_str"]: s["step_number"] for s in inst["step_executions"]}
    b1_order = by_label["2.1"]

    # OP A not complete yet; B.1's COMPLETE must refuse.
    resp = client.post(f"/api/procedure-instances/{instance_id}/steps/{b1_order}/complete", json={})
    assert resp.status_code == 400
    assert "waiting on" in resp.json()["detail"].lower()
    # B.1 unused but kept as a reference to confirm setup correctness.
    assert b1["id"] is not None

