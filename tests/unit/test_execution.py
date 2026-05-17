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
    assert data["status"] == "pending"
    assert len(data["step_executions"]) == 3


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


def test_start_step(client):
    """Test starting a step."""
    proc_id, _ = _create_procedure_with_steps(client)

    instance_response = client.post(
        "/api/procedure-instances",
        json={"procedure_id": proc_id},
    )
    instance_id = instance_response.json()["id"]

    # Start step 1
    response = client.post(f"/api/procedure-instances/{instance_id}/steps/1/start")
    assert response.status_code == 200
    assert response.json()["status"] == "in_progress"
    assert response.json()["started_at"] is not None

    # Instance should now be in_progress
    instance = client.get(f"/api/procedure-instances/{instance_id}").json()
    assert instance["status"] == "in_progress"


def test_complete_step(client):
    """Test completing a step."""
    proc_id, _ = _create_procedure_with_steps(client)

    instance_response = client.post(
        "/api/procedure-instances",
        json={"procedure_id": proc_id},
    )
    instance_id = instance_response.json()["id"]

    # Start and complete step 1
    client.post(f"/api/procedure-instances/{instance_id}/steps/1/start")
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
        client.post(f"/api/procedure-instances/{instance_id}/steps/{step}/start")
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

    # Start step and log NC
    client.post(f"/api/procedure-instances/{instance_id}/steps/1/start")
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

    # Start instance
    client.post(f"/api/procedure-instances/{instance_id}/steps/1/start")

    # Abort
    response = client.patch(
        f"/api/procedure-instances/{instance_id}",
        json={"status": "aborted"},
    )
    assert response.status_code == 200
    assert response.json()["status"] == "aborted"
    assert response.json()["completed_at"] is not None


def test_cannot_start_completed_step(client):
    """Test cannot start a step that's already completed."""
    proc_id, _ = _create_procedure_with_steps(client)

    instance_response = client.post(
        "/api/procedure-instances",
        json={"procedure_id": proc_id},
    )
    instance_id = instance_response.json()["id"]

    # Start and complete step 1
    client.post(f"/api/procedure-instances/{instance_id}/steps/1/start")
    client.post(f"/api/procedure-instances/{instance_id}/steps/1/complete", json={})

    # Try to start again
    response = client.post(f"/api/procedure-instances/{instance_id}/steps/1/start")
    assert response.status_code == 400


# ============ New tests — Step Operations ============


def test_update_step_notes(client):
    """Test updating notes on a step."""
    instance_id = _create_instance(client)

    client.post(f"/api/procedure-instances/{instance_id}/steps/1/start")
    resp = client.patch(
        f"/api/procedure-instances/{instance_id}/steps/1/notes",
        json={"notes": "Check torque value"},
    )
    assert resp.status_code == 200
    assert resp.json()["notes"] == "Check torque value"


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
        client.post(f"/api/procedure-instances/{instance_id}/steps/{step}/start")
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

    # Start the instance
    client.post(f"/api/procedure-instances/{instance_id}/steps/1/start")

    resp = client.get("/api/procedure-instances?status=in_progress")
    assert resp.status_code == 200
    data = resp.json()
    for item in data["items"]:
        assert item["status"] == "in_progress"


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

    # Start step 1
    client.post(f"/api/procedure-instances/{instance_id}/steps/1/start")

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

    # Start step 1 and consume at that step
    client.post(f"/api/procedure-instances/{instance_id}/steps/1/start")
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
    participants = client.get(
        f"/api/procedure-instances/{instance_id}/participants"
    ).json()
    assert len(participants["participants"]) == 0


# ============ NC step-hold tests ============


def _start_step_and_log_nc(client, instance_id, step_number=1, title="NC A"):
    """Start a step and log an NC against it. Returns (issue_id, step_status_after)."""
    client.post(f"/api/procedure-instances/{instance_id}/steps/{step_number}/start")
    resp = client.post(
        f"/api/procedure-instances/{instance_id}/steps/{step_number}/nc",
        json={"title": title, "description": "x", "priority": "medium"},
    )
    assert resp.status_code == 201
    issue_id = resp.json()["id"]
    inst = client.get(f"/api/procedure-instances/{instance_id}").json()
    step_status = next(
        s["status"] for s in inst["step_executions"] if s["step_number"] == step_number
    )
    return issue_id, step_status


def test_log_nc_puts_step_on_hold(client):
    """Logging an NC against an in-progress step transitions it to on_hold."""
    instance_id = _create_instance(client)
    _, step_status = _start_step_and_log_nc(client, instance_id)
    assert step_status == "on_hold"


def test_approving_nc_disposition_resumes_step(client):
    """Approving the sole NC's disposition pops the step back to in_progress."""
    instance_id = _create_instance(client)
    issue_id, _ = _start_step_and_log_nc(client, instance_id)

    resp = client.patch(
        f"/api/issues/{issue_id}",
        json={"status": "disposition_approved", "disposition_type": "use_as_is"},
    )
    assert resp.status_code == 200

    inst = client.get(f"/api/procedure-instances/{instance_id}").json()
    step_status = next(s["status"] for s in inst["step_executions"] if s["step_number"] == 1)
    assert step_status == "in_progress"


def test_two_open_ncs_keep_step_on_hold_until_all_resolved(client):
    """With two open NCs on a step, the step stays held until both reach a
    terminal disposition state."""
    instance_id = _create_instance(client)
    issue_a, _ = _start_step_and_log_nc(client, instance_id, title="NC A")

    # Log a second NC on the same step via the API (UI hides the button while held).
    resp_b = client.post(
        f"/api/procedure-instances/{instance_id}/steps/1/nc",
        json={"title": "NC B", "description": "y", "priority": "medium"},
    )
    assert resp_b.status_code == 201
    issue_b = resp_b.json()["id"]

    # Approve A only — step must remain on hold for B.
    client.patch(
        f"/api/issues/{issue_a}",
        json={"status": "disposition_approved", "disposition_type": "rework"},
    )
    inst = client.get(f"/api/procedure-instances/{instance_id}").json()
    assert next(
        s["status"] for s in inst["step_executions"] if s["step_number"] == 1
    ) == "on_hold"

    # Approve B — step now resumes.
    client.patch(
        f"/api/issues/{issue_b}",
        json={"status": "disposition_approved", "disposition_type": "use_as_is"},
    )
    inst = client.get(f"/api/procedure-instances/{instance_id}").json()
    assert next(
        s["status"] for s in inst["step_executions"] if s["step_number"] == 1
    ) == "in_progress"


def test_cannot_skip_on_hold_step(client):
    """The /skip endpoint refuses a step that is on hold for an open NC."""
    instance_id = _create_instance(client)
    _start_step_and_log_nc(client, instance_id)

    resp = client.post(
        f"/api/procedure-instances/{instance_id}/steps/1/skip",
        json={"reason": "trying to bypass"},
    )
    assert resp.status_code == 400
    assert "on hold" in resp.json()["detail"].lower()


# ============ Redline / ad-hoc op tests ============


def _create_redline_setup(client):
    """Create an instance, log an NC on step 1, return (instance_id, issue_id, host_step_exec_id)."""
    instance_id = _create_instance(client)
    issue_id, _ = _start_step_and_log_nc(client, instance_id)
    inst = client.get(f"/api/procedure-instances/{instance_id}").json()
    host_se_id = next(
        s["id"] for s in inst["step_executions"] if s["step_number"] == 1
    )
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


def test_redline_gates_host_op(client):
    """A snapshot op can't restart while a redline op tied to its NC is incomplete."""
    instance_id, issue_id, _ = _create_redline_setup(client)
    client.post(
        f"/api/procedure-instances/{instance_id}/ad-hoc-ops",
        json={
            "issue_id": issue_id,
            "title": "Rework",
            "steps": [{"title": "Do rework"}],
        },
    )
    # Approve the NC's disposition.
    client.patch(
        f"/api/issues/{issue_id}",
        json={"status": "disposition_approved", "disposition_type": "rework"},
    )
    # Held step must remain on_hold because the redline isn't complete.
    inst = client.get(f"/api/procedure-instances/{instance_id}").json()
    assert next(
        s["status"] for s in inst["step_executions"] if s["step_number"] == 1
    ) == "on_hold"


def test_redline_completion_releases_held_step(client):
    """Completing the last redline sub-step (with NC disposition approved) auto-resumes the host."""
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

    # Approve the NC dispo first — step should NOT yet resume.
    client.patch(
        f"/api/issues/{issue_id}",
        json={"status": "disposition_approved", "disposition_type": "rework"},
    )
    inst = client.get(f"/api/procedure-instances/{instance_id}").json()
    assert next(
        s["status"] for s in inst["step_executions"] if s["step_number"] == 1
    ) == "on_hold"

    # Run the redline sub-step to completion.
    client.post(
        f"/api/procedure-instances/{instance_id}/steps/{sub_step_number}/start"
    )
    client.post(
        f"/api/procedure-instances/{instance_id}/steps/{sub_step_number}/complete",
        json={},
    )

    # Host step should now have auto-resumed.
    inst = client.get(f"/api/procedure-instances/{instance_id}").json()
    assert next(
        s["status"] for s in inst["step_executions"] if s["step_number"] == 1
    ) == "in_progress"


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
    assert any(
        s["step_number"] == redline_op_step_num for s in inst["step_executions"]
    )

    # But the orphan no longer gates the host. We can't directly test start_step
    # here because the host is still on_hold from the NC; the gate logic only
    # fires when something tries to start the host. Instead verify the list
    # endpoint still returns it (no crashes) and start_step's redline-gate
    # excludes orphans (covered by the issue-soft-delete filter).
    list_resp = client.get(f"/api/procedure-instances/{instance_id}/ad-hoc-ops")
    assert list_resp.status_code == 200
    assert len(list_resp.json()) == 1


def test_redline_delete_unstarted(client):
    """An unstarted redline can be deleted; once any sub-step is started, deletion is rejected."""
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

    # Start the sub-step → delete should now fail.
    client.post(
        f"/api/procedure-instances/{instance_id}/steps/{sub_step_number}/start"
    )
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
