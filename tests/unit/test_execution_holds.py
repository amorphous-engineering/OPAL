"""Hold model tests (Issues R2 semantics) through the JSON API.

Covers NC capture fields and containment, bound-step holds
(blocks_step_numbers / issue step-block routes), hold lift on disposition
and soft delete, COMPLETE/SKIP gating, strict_sequence start gating, and
required-data enforcement on complete.
"""


# ============ Builders ============


def _create_procedure_with_steps(client):
    """Create a flat procedure with 3 steps and publish it."""
    proc_response = client.post(
        "/api/procedures",
        json={"name": "Hold Test Procedure"},
    )
    proc_id = proc_response.json()["id"]

    client.post(f"/api/procedures/{proc_id}/steps", json={"title": "Step 1"})
    client.post(f"/api/procedures/{proc_id}/steps", json={"title": "Step 2"})
    client.post(f"/api/procedures/{proc_id}/steps", json={"title": "Step 3"})

    version_response = client.post(f"/api/procedures/{proc_id}/publish")
    version_id = version_response.json()["id"]

    return proc_id, version_id


def _create_instance(client, work_order_number=None):
    """Create a flat 3-step procedure and an instance; returns instance_id."""
    proc_id, _ = _create_procedure_with_steps(client)
    payload = {"procedure_id": proc_id}
    if work_order_number:
        payload["work_order_number"] = work_order_number
    resp = client.post("/api/procedure-instances", json=payload)
    assert resp.status_code == 201
    return resp.json()["id"]


def _raise_nc(client, instance_id, order, **overrides):
    """POST an NC on snapshot step `order`; returns the raw response."""
    body = {"title": "Torque out of range", **overrides}
    return client.post(
        f"/api/procedure-instances/{instance_id}/steps/{order}/nc",
        json=body,
    )


def _disposition(client, issue_id):
    """Approve a use-as-is disposition — the hold-lifting transition."""
    resp = client.patch(
        f"/api/issues/{issue_id}",
        json={"status": "disposition_approved", "disposition_type": "use_as_is"},
    )
    assert resp.status_code == 200, resp.text
    return resp.json()


def _state(client, instance_id):
    resp = client.get(f"/api/procedure-instances/{instance_id}/state")
    assert resp.status_code == 200
    return resp.json()


def _state_step(state, order):
    return next(s for s in state["steps"] if s["order"] == order)


# ============ 1. NC capture fields ============


def test_nc_capture_fields_and_step_hold(client):
    instance_id = _create_instance(client)
    client.post(f"/api/procedure-instances/{instance_id}/steps/1/start")

    resp = _raise_nc(
        client,
        instance_id,
        1,
        should_be="Torque 5.0 Nm",
        is_condition="Torque 7.2 Nm",
        containment="step",
    )
    assert resp.status_code == 201, resp.text
    body = resp.json()
    assert body["issue_number"]
    assert body["containment"] == "step"
    assert body["issue_type"] == "non_conformance"

    issue = client.get(f"/api/issues/{body['id']}").json()
    assert issue["should_be"] == "Torque 5.0 Nm"
    assert issue["is_condition"] == "Torque 7.2 Nm"
    assert issue["procedure_instance_id"] == instance_id
    assert issue["step_execution_id"] is not None

    state = _state(client, instance_id)
    assert _state_step(state, 1)["status"] == "on_hold"
    raised = _state_step(state, 1)["holds"]
    assert any(h["kind"] == "raised" and h["issue_number"] == body["issue_number"] for h in raised)


# ============ 2. Advisory containment ============


def test_advisory_containment_does_not_hold(client):
    instance_id = _create_instance(client)

    resp = _raise_nc(client, instance_id, 2, containment="advisory")
    assert resp.status_code == 201, resp.text
    issue_id = resp.json()["id"]

    issue = client.get(f"/api/issues/{issue_id}").json()
    assert issue["procedure_instance_id"] == instance_id
    assert issue["step_execution_id"] is None

    state = _state(client, instance_id)
    assert _state_step(state, 2)["status"] == "pending"
    assert _state_step(state, 2)["holds"] == []
    assert state["holds"] == []

    # Step stays claimable.
    start = client.post(f"/api/procedure-instances/{instance_id}/steps/2/start")
    assert start.status_code == 200, start.text


# ============ 3. Invalid containment ============


def test_invalid_containment_rejected(client):
    instance_id = _create_instance(client)
    resp = _raise_nc(client, instance_id, 1, containment="fleet")
    assert resp.status_code == 400
    assert "containment" in resp.json()["detail"].lower()


# ============ 4. blocks_step_numbers ============


def test_blocked_step_refuses_start_and_shows_in_state(client):
    instance_id = _create_instance(client)

    resp = _raise_nc(client, instance_id, 1, containment="step", blocks_step_numbers=[3])
    assert resp.status_code == 201, resp.text
    body = resp.json()
    issue_number = body["issue_number"]
    assert body["blocks"] == ["3"]

    start = client.post(f"/api/procedure-instances/{instance_id}/steps/3/start")
    assert start.status_code == 400
    assert issue_number in start.json()["detail"]

    state = _state(client, instance_id)
    bound = _state_step(state, 3)["holds"]
    assert any(h["kind"] == "bound" and h["issue_number"] == issue_number for h in bound)
    assert all(h["disposition_state"] == "undispositioned" for h in bound)

    rail = next(h for h in state["holds"] if h["issue_number"] == issue_number)
    assert "3" in rail["blocks"]


# ============ 5. blocks unknown step ============


def test_blocks_unknown_step_order_404(client):
    instance_id = _create_instance(client)
    resp = _raise_nc(client, instance_id, 1, containment="step", blocks_step_numbers=[99])
    assert resp.status_code == 404
    assert "99" in resp.json()["detail"]


# ============ 6. Hold lift on disposition ============


def test_disposition_lifts_bound_hold_and_resumes_step(client, auth_headers):
    instance_id = _create_instance(client)
    client.post(f"/api/procedure-instances/{instance_id}/steps/1/start")

    resp = _raise_nc(client, instance_id, 1, containment="step", blocks_step_numbers=[3])
    issue_id = resp.json()["id"]

    blocked = client.post(f"/api/procedure-instances/{instance_id}/steps/3/start")
    assert blocked.status_code == 400

    _disposition(client, issue_id)

    state = _state(client, instance_id)
    assert state["holds"] == []
    assert _state_step(state, 3)["holds"] == []
    # Raised step auto-resumed from on_hold.
    assert _state_step(state, 1)["status"] == "in_progress"

    # Bound step claimable again (different user, so step 1's claim survives).
    start = client.post(
        f"/api/procedure-instances/{instance_id}/steps/3/start",
        headers=auth_headers,
    )
    assert start.status_code == 200, start.text
    assert start.json()["status"] == "in_progress"


# ============ 7. Soft delete lifts bound hold ============


def test_soft_delete_lifts_bound_hold(client):
    instance_id = _create_instance(client)

    resp = _raise_nc(client, instance_id, 1, containment="step", blocks_step_numbers=[3])
    issue_id = resp.json()["id"]

    blocked = client.post(f"/api/procedure-instances/{instance_id}/steps/3/start")
    assert blocked.status_code == 400

    delete = client.delete(f"/api/issues/{issue_id}")
    assert delete.status_code == 204

    start = client.post(f"/api/procedure-instances/{instance_id}/steps/3/start")
    assert start.status_code == 200, start.text


# ============ 8. COMPLETE/SKIP gating ============


def test_undispositioned_nc_gates_complete_and_skip(client):
    instance_id = _create_instance(client)
    client.post(f"/api/procedure-instances/{instance_id}/steps/1/start")

    resp = _raise_nc(client, instance_id, 1, containment="step")
    issue_id = resp.json()["id"]

    complete = client.post(
        f"/api/procedure-instances/{instance_id}/steps/1/complete",
        json={},
    )
    assert complete.status_code == 400

    skip = client.post(
        f"/api/procedure-instances/{instance_id}/steps/1/skip",
        json={},
    )
    assert skip.status_code == 400

    _disposition(client, issue_id)

    complete = client.post(
        f"/api/procedure-instances/{instance_id}/steps/1/complete",
        json={},
    )
    assert complete.status_code == 200, complete.text
    assert complete.json()["status"] == "completed"


# ============ 9. Issue step-block routes ============


def test_issue_step_block_routes(client):
    instance_id = _create_instance(client, work_order_number="WO-HOLD-1")

    issue_resp = client.post(
        "/api/issues",
        json={
            "title": "Supplier lot suspect",
            "issue_type": "non_conformance",
            "procedure_instance_id": instance_id,
        },
    )
    assert issue_resp.status_code == 201, issue_resp.text
    issue_id = issue_resp.json()["id"]

    bind = client.post(
        f"/api/issues/{issue_id}/step-blocks",
        json={"procedure_instance_id": instance_id, "step_number": 2},
    )
    assert bind.status_code == 201, bind.text
    block = bind.json()
    assert block["step_number"] == 2
    assert block["step_number_str"] == "2"
    assert block["work_order_number"] == "WO-HOLD-1"

    # Idempotent re-bind returns the existing block.
    rebind = client.post(
        f"/api/issues/{issue_id}/step-blocks",
        json={"procedure_instance_id": instance_id, "step_number": 2},
    )
    assert rebind.status_code == 201
    assert rebind.json()["id"] == block["id"]

    listing = client.get(f"/api/issues/{issue_id}/step-blocks")
    assert listing.status_code == 200
    rows = listing.json()
    assert len(rows) == 1
    assert rows[0]["step_number_str"] == "2"
    assert rows[0]["work_order_number"] == "WO-HOLD-1"

    blocked = client.post(f"/api/procedure-instances/{instance_id}/steps/2/start")
    assert blocked.status_code == 400

    unbind = client.delete(f"/api/issues/{issue_id}/step-blocks/{block['id']}")
    assert unbind.status_code == 204

    start = client.post(f"/api/procedure-instances/{instance_id}/steps/2/start")
    assert start.status_code == 200, start.text


# ============ 10. strict_sequence ============


def test_strict_sequence_gates_sub_step_start(client):
    proc_resp = client.post("/api/procedures", json={"name": "Strict OP Procedure"})
    proc_id = proc_resp.json()["id"]

    op_resp = client.post(
        f"/api/procedures/{proc_id}/steps",
        json={"title": "Strict OP", "strict_sequence": True},
    )
    assert op_resp.status_code == 201, op_resp.text
    op_id = op_resp.json()["id"]

    client.post(
        f"/api/procedures/{proc_id}/steps",
        json={"title": "Sub 1", "parent_step_id": op_id},
    )
    client.post(
        f"/api/procedures/{proc_id}/steps",
        json={"title": "Sub 2", "parent_step_id": op_id},
    )
    client.post(f"/api/procedures/{proc_id}/publish")

    inst_resp = client.post("/api/procedure-instances", json={"procedure_id": proc_id})
    assert inst_resp.status_code == 201
    instance_id = inst_resp.json()["id"]
    # Orders: OP=1, sub-step 1.1=2, sub-step 1.2=3.

    out_of_order = client.post(f"/api/procedure-instances/{instance_id}/steps/3/start")
    assert out_of_order.status_code == 400
    assert "Waiting on" in out_of_order.json()["detail"]
    assert "1.1" in out_of_order.json()["detail"]

    start1 = client.post(f"/api/procedure-instances/{instance_id}/steps/2/start")
    assert start1.status_code == 200, start1.text
    complete1 = client.post(
        f"/api/procedure-instances/{instance_id}/steps/2/complete",
        json={},
    )
    assert complete1.status_code == 200, complete1.text

    start2 = client.post(f"/api/procedure-instances/{instance_id}/steps/3/start")
    assert start2.status_code == 200, start2.text
    assert start2.json()["status"] == "in_progress"


# ============ 11. Required-data enforcement ============


def test_required_data_schema_enforced_on_complete(client):
    proc_resp = client.post("/api/procedures", json={"name": "Data Capture Procedure"})
    proc_id = proc_resp.json()["id"]

    client.post(
        f"/api/procedures/{proc_id}/steps",
        json={
            "title": "Measure",
            "required_data_schema": {
                "fields": [{"name": "x", "label": "X", "type": "number", "required": True}]
            },
        },
    )
    client.post(f"/api/procedures/{proc_id}/publish")

    inst_resp = client.post("/api/procedure-instances", json={"procedure_id": proc_id})
    instance_id = inst_resp.json()["id"]

    client.post(f"/api/procedure-instances/{instance_id}/steps/1/start")

    empty = client.post(
        f"/api/procedure-instances/{instance_id}/steps/1/complete",
        json={},
    )
    assert empty.status_code == 422
    detail = empty.json()["detail"]
    assert isinstance(detail, list)
    assert "X is required" in detail

    filled = client.post(
        f"/api/procedure-instances/{instance_id}/steps/1/complete",
        json={"data_captured": {"x": 5}},
    )
    assert filled.status_code == 200, filled.text
    assert filled.json()["status"] == "completed"
    assert filled.json()["data_captured"] == {"x": 5}
