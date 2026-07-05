"""Hold model tests (Issues R2 semantics) through the JSON API.

Covers NC capture fields and containment, bound-step holds via the containment
endpoint, hold lift on disposition and soft delete, COMPLETE/SKIP gating,
strict_sequence complete gating, and required-data enforcement on complete.
Holds gate COMPLETE — the commitment moment — never presence: a cursor (focus)
may sit on a held step.

R2 semantics: holds are derived from undispositioned issues; step status is
never flipped to on_hold; blocks_step_numbers is gone; /step-blocks routes are
gone; disposition is signed via POST /{id}/disposition.
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
    """Sign a use-as-is disposition — the hold-lifting transition (R2 API)."""
    resp = client.post(
        f"/api/issues/{issue_id}/disposition",
        json={"disposition_type": "use_as_is", "disposition_rationale": "acceptable"},
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
    """R2: NC creates an issue with actual/should_be; step status stays pending;
    the hold is derived — the step's COMPLETE is gated, not its status."""
    instance_id = _create_instance(client)

    resp = _raise_nc(
        client,
        instance_id,
        1,
        should_be="Torque 5.0 Nm",
        actual="Torque 7.2 Nm",
        containment="step",
    )
    assert resp.status_code == 201, resp.text
    body = resp.json()
    assert body["issue_number"]
    assert body["containment"] == "step"
    assert body["issue_type"] == "non_conformance"

    issue = client.get(f"/api/issues/{body['id']}").json()
    assert issue["should_be"] == "Torque 5.0 Nm"
    assert issue["actual"] == "Torque 7.2 Nm"
    assert issue["procedure_instance_id"] == instance_id
    assert issue["raised_step_id"] is not None

    # Step status is never mutated — holds are derived.
    state = _state(client, instance_id)
    assert _state_step(state, 1)["status"] == "pending"
    raised = _state_step(state, 1)["holds"]
    assert any(h["kind"] == "raised" and h["issue_number"] == body["issue_number"] for h in raised)

    # But COMPLETE is blocked.
    complete = client.post(
        f"/api/procedure-instances/{instance_id}/steps/1/complete",
        json={},
    )
    assert complete.status_code == 400
    assert "IT-" in complete.json()["detail"]


# ============ 2. Advisory containment ============


def test_advisory_containment_does_not_hold(client):
    """Advisory NCs create issues but derive no hold — step stays completable."""
    instance_id = _create_instance(client)

    resp = _raise_nc(client, instance_id, 2, containment="advisory")
    assert resp.status_code == 201, resp.text
    issue_id = resp.json()["id"]

    issue = client.get(f"/api/issues/{issue_id}").json()
    assert issue["procedure_instance_id"] == instance_id
    # Advisory issues don't bind a step.
    assert issue["raised_step_id"] is None or issue["containment"] == "advisory"

    state = _state(client, instance_id)
    assert _state_step(state, 2)["status"] == "pending"
    assert _state_step(state, 2)["holds"] == []
    assert state["holds"] == []

    # Step stays completable.
    complete = client.post(
        f"/api/procedure-instances/{instance_id}/steps/2/complete",
        json={},
    )
    assert complete.status_code == 200, complete.text


# ============ 3. Invalid containment ============


def test_invalid_containment_rejected(client):
    instance_id = _create_instance(client)
    resp = _raise_nc(client, instance_id, 1, containment="fleet")
    assert resp.status_code == 400
    assert "containment" in resp.json()["detail"].lower()


# ============ 4. Bound-step hold via containment endpoint ============


def test_bound_step_refuses_complete_and_shows_in_state(client):
    """Binding an issue to a step via /containment makes that step's COMPLETE
    refuse; the hold appears in the state document."""
    instance_id = _create_instance(client)

    # Raise an NC on step 1 (step-contained by default) — it holds step 1.
    resp = _raise_nc(client, instance_id, 1, containment="step")
    assert resp.status_code == 201, resp.text
    body = resp.json()
    issue_id = body["id"]
    issue_number = body["issue_number"]

    # Move the boundary to step 3 via the containment endpoint.
    inst = client.get(f"/api/procedure-instances/{instance_id}").json()
    se_by_num = {s["step_number"]: s["id"] for s in inst["step_executions"]}
    rebind = client.post(
        f"/api/issues/{issue_id}/containment",
        json={"containment": "step", "containment_step_id": se_by_num[3]},
    )
    assert rebind.status_code == 200

    # Step 1 is now free; step 3 is the boundary.
    complete1 = client.post(
        f"/api/procedure-instances/{instance_id}/steps/1/complete", json={}
    )
    assert complete1.status_code == 200

    complete3 = client.post(
        f"/api/procedure-instances/{instance_id}/steps/3/complete",
        json={},
    )
    assert complete3.status_code == 400
    assert issue_number in complete3.json()["detail"]

    state = _state(client, instance_id)
    bound = _state_step(state, 3)["holds"]
    assert any(h["kind"] == "bound" and h["issue_number"] == issue_number for h in bound)
    assert all(h["disposition_state"] == "undispositioned" for h in bound)

    rail = next(h for h in state["holds"] if h["issue_number"] == issue_number)
    assert "3" in rail["blocks"]

    # Presence is ungated — a cursor may sit on the bound step.
    focus = client.post(
        f"/api/procedure-instances/{instance_id}/focus",
        json={"step_number": 3},
    )
    assert focus.status_code == 200, focus.text


# ============ 5. Invalid containment scope rejected ============


def test_invalid_containment_scope_rejected(client):
    """Passing an invalid containment string to /containment is rejected."""
    instance_id = _create_instance(client)
    resp = _raise_nc(client, instance_id, 1, containment="step")
    issue_id = resp.json()["id"]

    bad = client.post(
        f"/api/issues/{issue_id}/containment",
        json={"containment": "invalid_scope"},
    )
    assert bad.status_code == 400
    assert "containment" in bad.json()["detail"].lower()


# ============ 6. Hold lift on disposition ============


def test_disposition_lifts_bound_hold(client):
    """Signing the disposition releases the bound-step hold immediately."""
    instance_id = _create_instance(client)

    # Raise on step 1, bind boundary to step 3.
    resp = _raise_nc(client, instance_id, 1, containment="step")
    issue_id = resp.json()["id"]
    inst = client.get(f"/api/procedure-instances/{instance_id}").json()
    se_by_num = {s["step_number"]: s["id"] for s in inst["step_executions"]}
    client.post(
        f"/api/issues/{issue_id}/containment",
        json={"containment": "step", "containment_step_id": se_by_num[3]},
    )

    blocked = client.post(
        f"/api/procedure-instances/{instance_id}/steps/3/complete",
        json={},
    )
    assert blocked.status_code == 400

    _disposition(client, issue_id)

    state = _state(client, instance_id)
    assert state["holds"] == []
    assert _state_step(state, 3)["holds"] == []

    # Bound step completable again.
    complete = client.post(
        f"/api/procedure-instances/{instance_id}/steps/3/complete",
        json={},
    )
    assert complete.status_code == 200, complete.text
    assert complete.json()["status"] == "completed"


# ============ 7. Soft delete lifts bound hold ============


def test_soft_delete_lifts_bound_hold(client):
    """Soft-deleting the issue releases its hold immediately."""
    instance_id = _create_instance(client)

    resp = _raise_nc(client, instance_id, 1, containment="step")
    issue_id = resp.json()["id"]
    inst = client.get(f"/api/procedure-instances/{instance_id}").json()
    se_by_num = {s["step_number"]: s["id"] for s in inst["step_executions"]}
    client.post(
        f"/api/issues/{issue_id}/containment",
        json={"containment": "step", "containment_step_id": se_by_num[3]},
    )

    blocked = client.post(
        f"/api/procedure-instances/{instance_id}/steps/3/complete",
        json={},
    )
    assert blocked.status_code == 400

    delete = client.delete(f"/api/issues/{issue_id}")
    assert delete.status_code == 204

    complete = client.post(
        f"/api/procedure-instances/{instance_id}/steps/3/complete",
        json={},
    )
    assert complete.status_code == 200, complete.text


# ============ 8. COMPLETE/SKIP gating ============


def test_undispositioned_nc_gates_complete_and_skip(client):
    """An undispositioned step-containment NC blocks both COMPLETE and SKIP."""
    instance_id = _create_instance(client)

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


# ============ 9. Containment binding (replaces step-block routes) ============


def test_containment_rebind_moves_boundary(client):
    """Re-binding via /containment moves the hold boundary; the old step is
    freed, the new step is blocked."""
    instance_id = _create_instance(client, work_order_number="WO-HOLD-1")
    inst = client.get(f"/api/procedure-instances/{instance_id}").json()
    se_by_num = {s["step_number"]: s["id"] for s in inst["step_executions"]}

    issue_resp = client.post(
        "/api/issues",
        json={
            "title": "Supplier lot suspect",
            "issue_type": "non_conformance",
            "containment": "step",
            "procedure_instance_id": instance_id,
            "raised_step_id": se_by_num[1],
        },
    )
    assert issue_resp.status_code == 201, issue_resp.text
    issue_id = issue_resp.json()["id"]
    issue_number = issue_resp.json()["issue_number"]

    # Bind to step 2.
    bind = client.post(
        f"/api/issues/{issue_id}/containment",
        json={"containment": "step", "containment_step_id": se_by_num[2]},
    )
    assert bind.status_code == 200, bind.text

    # Step 2 is now blocked.
    blocked = client.post(
        f"/api/procedure-instances/{instance_id}/steps/2/complete",
        json={},
    )
    assert blocked.status_code == 400
    assert issue_number in blocked.json()["detail"]

    # Re-bind to step 3 — boundary moves.
    rebind = client.post(
        f"/api/issues/{issue_id}/containment",
        json={"containment": "step", "containment_step_id": se_by_num[3]},
    )
    assert rebind.status_code == 200

    # Step 2 is now free.
    free = client.post(
        f"/api/procedure-instances/{instance_id}/steps/2/complete",
        json={},
    )
    assert free.status_code == 200, free.text

    # Step 3 is now blocked.
    blocked3 = client.post(
        f"/api/procedure-instances/{instance_id}/steps/3/complete",
        json={},
    )
    assert blocked3.status_code == 400

    # Disposition releases everything.
    _disposition(client, issue_id)
    complete = client.post(
        f"/api/procedure-instances/{instance_id}/steps/3/complete",
        json={},
    )
    assert complete.status_code == 200, complete.text


# ============ 10. strict_sequence ============


def test_strict_sequence_gates_sub_step_complete(client):
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

    out_of_order = client.post(
        f"/api/procedure-instances/{instance_id}/steps/3/complete",
        json={},
    )
    assert out_of_order.status_code == 400
    assert "Waiting on" in out_of_order.json()["detail"]
    assert "1.1" in out_of_order.json()["detail"]

    complete1 = client.post(
        f"/api/procedure-instances/{instance_id}/steps/2/complete",
        json={},
    )
    assert complete1.status_code == 200, complete1.text

    complete2 = client.post(
        f"/api/procedure-instances/{instance_id}/steps/3/complete",
        json={},
    )
    assert complete2.status_code == 200, complete2.text
    assert complete2.json()["status"] == "completed"


# ============ 11a. Holding readout links to the live document (F11) ============


def test_holding_readout_links_to_document_op_param(client):
    """The HOLDING link targets the live document shape (/executions/{id}?op=N),
    not the dissolved operations tab."""
    instance_id = _create_instance(client)
    resp = _raise_nc(client, instance_id, 1, containment="step")
    issue_id = resp.json()["id"]

    holding = client.get(f"/api/issues/{issue_id}/holding")
    assert holding.status_code == 200, holding.text
    targets = holding.json()
    assert targets, "an undispositioned step-contained NC holds something"
    for target in targets:
        assert "tab=operations" not in target["href"]
        assert target["href"].startswith(f"/executions/{instance_id}?op=")


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
