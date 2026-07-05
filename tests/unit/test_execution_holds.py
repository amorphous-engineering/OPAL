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


def _sub_step_instance(client):
    """OP 1 (sub-steps 1.1, 1.2) + flat step 2; orders OP=1, 1.1=2, 1.2=3,
    step2=4. Returns instance_id."""
    proc_id = client.post("/api/procedures", json={"name": "Sub-step WO"}).json()["id"]
    op = client.post(f"/api/procedures/{proc_id}/steps", json={"title": "OP 1"}).json()
    client.post(
        f"/api/procedures/{proc_id}/steps",
        json={"title": "Sub 1.1", "parent_step_id": op["id"]},
    )
    client.post(
        f"/api/procedures/{proc_id}/steps",
        json={"title": "Sub 1.2", "parent_step_id": op["id"]},
    )
    client.post(f"/api/procedures/{proc_id}/steps", json={"title": "Step 2"})
    client.post(f"/api/procedures/{proc_id}/publish")
    resp = client.post("/api/procedure-instances", json={"procedure_id": proc_id})
    assert resp.status_code == 201, resp.text
    return resp.json()["id"]


def _complete(client, instance_id, order, **body):
    return client.post(
        f"/api/procedure-instances/{instance_id}/steps/{order}/complete", json=body
    )


def _inst_status(client, instance_id):
    return client.get(f"/api/procedure-instances/{instance_id}").json()["status"]


# ============ F2: close-out authoritative on the issue set ============


def test_wo_stays_open_under_boundary_bound_to_terminal_step(client):
    """F2(a): a 'resolve by' boundary bound to an already-terminal step lands
    in start_blocked, which the old close-out gate never consulted — the WO
    closed COMPLETED over the open NC. Now the issue set is authoritative."""
    instance_id = _create_instance(client)  # flat 3 steps

    assert _complete(client, instance_id, 1).status_code == 200
    assert _complete(client, instance_id, 2).status_code == 200

    # Raise an NC on step 3, boundary bound to the already-terminal step 1.
    nc = _raise_nc(
        client, instance_id, 3, containment="step", containment_step_number=1
    )
    assert nc.status_code == 201, nc.text
    issue_id = nc.json()["id"]

    # Step 3 isn't the boundary, so it completes; every step is now terminal.
    assert _complete(client, instance_id, 3).status_code == 200

    # The open NC must keep the work order out of COMPLETED.
    assert _inst_status(client, instance_id) != "completed"

    # Signing the disposition releases it and the WO closes.
    _disposition(client, issue_id)
    assert _inst_status(client, instance_id) == "completed"


def test_wo_stays_open_under_op_hold_on_terminal_op(client):
    """F2(b): an op-containment NC set onto an OP that already auto-completed
    lands only in op_complete_blocked on a terminal row nothing revisits. The
    close-out gate must still see the open issue."""
    instance_id = _sub_step_instance(client)

    # Finish OP 1's sub-steps -> OP 1 auto-completes.
    assert _complete(client, instance_id, 2).status_code == 200
    assert _complete(client, instance_id, 3).status_code == 200

    # Now raise an advisory issue on a (terminal) sub-step and widen to op.
    issue = client.post(
        "/api/issues",
        json={
            "title": "Late finding on OP 1",
            "issue_type": "non_conformance",
            "containment": "advisory",
            "procedure_instance_id": instance_id,
        },
    ).json()
    inst = client.get(f"/api/procedure-instances/{instance_id}").json()
    se_by_num = {s["step_number"]: s["id"] for s in inst["step_executions"]}
    widen = client.post(
        f"/api/issues/{issue['id']}/containment",
        json={"containment": "op", "containment_step_id": se_by_num[2]},
    )
    assert widen.status_code == 200, widen.text

    # Finish the last flat step; the op-NC must keep the WO open.
    assert _complete(client, instance_id, 4).status_code == 200
    assert _inst_status(client, instance_id) != "completed"

    _disposition(client, issue["id"])
    assert _inst_status(client, instance_id) == "completed"


def test_op_does_not_auto_complete_over_bound_hold_on_op_row(client):
    """F2: a boundary bound to the OP row (start_blocked on the OP) must block
    the OP's auto-complete — folding blockers_for_start into the gate."""
    instance_id = _sub_step_instance(client)

    # NC raised on sub 1.1 (order 2), boundary bound to the OP row (order 1).
    nc = _raise_nc(
        client, instance_id, 2, containment="step", containment_step_number=1
    )
    assert nc.status_code == 201, nc.text
    issue_id = nc.json()["id"]

    # Sub-steps complete (neither is the boundary) but OP 1 must stay open.
    assert _complete(client, instance_id, 2).status_code == 200
    assert _complete(client, instance_id, 3).status_code == 200

    inst = client.get(f"/api/procedure-instances/{instance_id}").json()
    op_status = next(s["status"] for s in inst["step_executions"] if s["step_number"] == 1)
    assert op_status not in ("completed", "signed_off", "skipped")
    assert _inst_status(client, instance_id) != "completed"

    # Disposition releases the OP; finishing the last step closes the WO.
    _disposition(client, issue_id)
    assert _complete(client, instance_id, 4).status_code == 200
    assert _inst_status(client, instance_id) == "completed"


# ============ F8: boundary clear semantics + WO membership ============


def test_set_containment_clears_boundary_with_explicit_null(client):
    """F8: an explicit null clears a mis-bound boundary (previously immutable,
    since the endpoint applied containment_step_id only when non-null)."""
    instance_id = _create_instance(client)
    inst = client.get(f"/api/procedure-instances/{instance_id}").json()
    se_by_num = {s["step_number"]: s["id"] for s in inst["step_executions"]}

    # Raise on step 1, bind the boundary to step 3.
    resp = _raise_nc(client, instance_id, 1, containment="step")
    issue_id = resp.json()["id"]
    client.post(
        f"/api/issues/{issue_id}/containment",
        json={"containment": "step", "containment_step_id": se_by_num[3]},
    )
    assert _complete(client, instance_id, 3).status_code == 400

    # Clear the boundary — the hold falls back to the raised step (step 1).
    clear = client.post(
        f"/api/issues/{issue_id}/containment",
        json={"containment": "step", "containment_step_id": None},
    )
    assert clear.status_code == 200, clear.text
    assert clear.json()["containment_step_id"] is None

    # Step 3 is free again; step 1 is now the held anchor.
    assert _complete(client, instance_id, 3).status_code == 200
    assert _complete(client, instance_id, 1).status_code == 400


def test_set_containment_rejects_foreign_step(client):
    """F8: the posted boundary must belong to the issue's work order."""
    instance_a = _create_instance(client)
    instance_b = _create_instance(client)
    inst_b = client.get(f"/api/procedure-instances/{instance_b}").json()
    foreign_step = inst_b["step_executions"][0]["id"]

    resp = _raise_nc(client, instance_a, 1, containment="step")
    issue_id = resp.json()["id"]

    bad = client.post(
        f"/api/issues/{issue_id}/containment",
        json={"containment": "step", "containment_step_id": foreign_step},
    )
    assert bad.status_code == 400
    assert "different work order" in bad.json()["detail"]


# ============ F3: containment issue reconciled against its work order ============


def test_create_issue_rejects_anchor_in_different_wo(client):
    """F3: a step-containment issue whose raised step belongs to WO A cannot
    claim procedure_instance_id = WO B."""
    instance_a = _create_instance(client)
    instance_b = _create_instance(client)
    inst_a = client.get(f"/api/procedure-instances/{instance_a}").json()
    step_a = inst_a["step_executions"][0]["id"]

    resp = client.post(
        "/api/issues",
        json={
            "title": "Mismatch",
            "issue_type": "non_conformance",
            "containment": "step",
            "raised_step_id": step_a,
            "procedure_instance_id": instance_b,
        },
    )
    assert resp.status_code == 400
    assert "different work order" in resp.json()["detail"]


def test_create_issue_derives_wo_from_anchor(client):
    """F3: omitting procedure_instance_id derives it from the anchor step so the
    hold binds to the right WO (rather than blocking nothing)."""
    instance_id = _create_instance(client)
    inst = client.get(f"/api/procedure-instances/{instance_id}").json()
    step = inst["step_executions"][0]

    resp = client.post(
        "/api/issues",
        json={
            "title": "Derive",
            "issue_type": "non_conformance",
            "containment": "step",
            "raised_step_id": step["id"],
        },
    )
    assert resp.status_code == 201, resp.text
    assert resp.json()["procedure_instance_id"] == instance_id

    # The derived link means the hold actually holds the anchor step's COMPLETE.
    blocked = _complete(client, instance_id, step["step_number"])
    assert blocked.status_code == 400


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
