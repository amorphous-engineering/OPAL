"""Focus/cursor presence tests — /focus, /leave, complete/skip + /state document.

Presence is a cursor, not a claim: POST /focus moves the caller's single
cursor per instance (several users may sit on the same step), never changes
step status, and records no audit event. COMPLETE/SKIP act directly on
pending steps by any user; the first one flips the instance cut -> in_work.

The `client` fixture's default identity is the admin SERVICE user ("Test
Client"); `auth_headers` attributes requests to `test_user` ("Test User",
initials TU). Multi-user tests use both identities against the same step.
"""


def _create_procedure_with_steps(client):
    """Create a procedure with 3 top-level steps and publish it."""
    proc_response = client.post(
        "/api/procedures",
        json={"name": "Focus Test Procedure"},
    )
    proc_id = proc_response.json()["id"]

    client.post(f"/api/procedures/{proc_id}/steps", json={"title": "Step 1"})
    client.post(f"/api/procedures/{proc_id}/steps", json={"title": "Step 2"})
    client.post(f"/api/procedures/{proc_id}/steps", json={"title": "Step 3"})

    version_response = client.post(f"/api/procedures/{proc_id}/publish")
    version_id = version_response.json()["id"]

    return proc_id, version_id


def _create_instance(client):
    """Create a procedure + instance, return instance_id."""
    proc_id, _ = _create_procedure_with_steps(client)
    resp = client.post(
        "/api/procedure-instances",
        json={"procedure_id": proc_id},
    )
    assert resp.status_code == 201, resp.text
    return resp.json()["id"]


def _state(client, instance_id):
    resp = client.get(f"/api/procedure-instances/{instance_id}/state")
    assert resp.status_code == 200, resp.text
    return resp.json()


def _step(state, order):
    return next(s for s in state["steps"] if s["order"] == order)


def _focus(client, instance_id, step_number, headers=None):
    return client.post(
        f"/api/procedure-instances/{instance_id}/focus",
        json={"step_number": step_number},
        headers=headers,
    )


# ============ 1. focus places a cursor ============


def test_focus_places_cursor_with_initials_in_state(client, auth_headers, test_user):
    instance_id = _create_instance(client)

    resp = _focus(client, instance_id, 1, headers=auth_headers)
    assert resp.status_code == 200, resp.text
    assert resp.json()["step_number"] == 1
    assert resp.json()["focused_at"] is not None

    state = _state(client, instance_id)
    step = _step(state, 1)
    # Presence never changes step status.
    assert step["status"] == "pending"
    assert len(step["cursors"]) == 1
    cursor = step["cursors"][0]
    assert cursor["user_id"] == test_user.id
    assert cursor["name"] == "Test User"
    assert cursor["initials"] == "TU"
    assert cursor["focused_at"] is not None
    assert cursor["stale"] is False

    # Roster lists the cursor holder with the step position.
    holders = [r for r in state["roster"] if r["step_order"] is not None]
    assert len(holders) == 1
    assert holders[0]["user_id"] == test_user.id
    assert holders[0]["initials"] == "TU"
    assert holders[0]["step_order"] == 1
    assert holders[0]["step_number"] == "1"


# ============ 2. several users may focus the same step ============


def test_two_users_focusing_same_step_both_have_cursors(client, auth_headers, test_user):
    instance_id = _create_instance(client)

    assert _focus(client, instance_id, 1, headers=auth_headers).status_code == 200
    # Default client identity (service user) is a different user — no conflict.
    assert _focus(client, instance_id, 1).status_code == 200

    state = _state(client, instance_id)
    cursors = _step(state, 1)["cursors"]
    assert len(cursors) == 2
    assert test_user.id in {c["user_id"] for c in cursors}
    assert len({c["user_id"] for c in cursors}) == 2
    assert _step(state, 1)["status"] == "pending"


def test_refocusing_same_step_keeps_single_cursor(client, auth_headers, test_user):
    instance_id = _create_instance(client)

    assert _focus(client, instance_id, 1, headers=auth_headers).status_code == 200
    assert _focus(client, instance_id, 1, headers=auth_headers).status_code == 200

    state = _state(client, instance_id)
    cursors = _step(state, 1)["cursors"]
    assert [c["user_id"] for c in cursors] == [test_user.id]


# ============ 3. one cursor per user — focusing elsewhere moves it ============


def test_focusing_second_step_moves_cursor(client, auth_headers, test_user):
    instance_id = _create_instance(client)

    _focus(client, instance_id, 1, headers=auth_headers)
    _focus(client, instance_id, 2, headers=auth_headers)

    state = _state(client, instance_id)
    step1 = _step(state, 1)
    step2 = _step(state, 2)

    assert step1["cursors"] == []
    assert [c["user_id"] for c in step2["cursors"]] == [test_user.id]
    # Cursor movement is presence only — both steps stay pending.
    assert step1["status"] == "pending"
    assert step2["status"] == "pending"

    holders = [r for r in state["roster"] if r["step_order"] is not None]
    assert len(holders) == 1
    assert holders[0]["step_order"] == 2


# ============ 4. leave clears the cursor ============


def test_leave_clears_cursor(client, auth_headers):
    instance_id = _create_instance(client)

    _focus(client, instance_id, 1, headers=auth_headers)
    resp = client.post(
        f"/api/procedure-instances/{instance_id}/leave",
        headers=auth_headers,
    )
    assert resp.status_code == 200, resp.text

    state = _state(client, instance_id)
    assert all(s["cursors"] == [] for s in state["steps"])
    assert [r for r in state["roster"] if r["step_order"] is not None] == []


# ============ 5. complete records completed_by; cursor unaffected ============


def test_complete_records_completed_by_and_keeps_cursor(client, auth_headers, test_user):
    instance_id = _create_instance(client)

    _focus(client, instance_id, 1, headers=auth_headers)
    resp = client.post(
        f"/api/procedure-instances/{instance_id}/steps/1/complete",
        json={},
        headers=auth_headers,
    )
    assert resp.status_code == 200, resp.text
    assert resp.json()["status"] == "completed"
    assert resp.json()["completed_by_id"] == test_user.id

    state = _state(client, instance_id)
    step1 = _step(state, 1)
    assert step1["status"] == "completed"
    assert step1["completed"] is not None
    assert step1["completed"]["by"] == "Test User"
    assert step1["completed"]["initials"] == "TU"
    assert step1["completed"]["at"] is not None
    # Completion does not touch presence — the cursor survives.
    assert [c["user_id"] for c in step1["cursors"]] == [test_user.id]


# ============ 6. complete by another user while focused ============


def test_complete_by_other_user_succeeds_and_records_completer(client, auth_headers, test_user):
    instance_id = _create_instance(client)

    _focus(client, instance_id, 1, headers=auth_headers)
    # Default client identity (service user) completes the step TU is on.
    resp = client.post(
        f"/api/procedure-instances/{instance_id}/steps/1/complete",
        json={},
    )
    assert resp.status_code == 200, resp.text
    assert resp.json()["status"] == "completed"
    assert resp.json()["completed_by_id"] is not None
    assert resp.json()["completed_by_id"] != test_user.id


# ============ 7. skip vs cursors ============


def test_skip_with_other_users_cursor_succeeds(client, auth_headers):
    instance_id = _create_instance(client)

    _focus(client, instance_id, 1, headers=auth_headers)
    resp = client.post(
        f"/api/procedure-instances/{instance_id}/steps/1/skip",
        json={"reason": "N/A for this config"},
    )
    assert resp.status_code == 200, resp.text
    assert resp.json()["status"] == "skipped"


def test_skip_keeps_cursor(client, auth_headers, test_user):
    instance_id = _create_instance(client)

    _focus(client, instance_id, 1, headers=auth_headers)
    resp = client.post(
        f"/api/procedure-instances/{instance_id}/steps/1/skip",
        json={"reason": "N/A for this config"},
        headers=auth_headers,
    )
    assert resp.status_code == 200, resp.text

    state = _state(client, instance_id)
    step1 = _step(state, 1)
    assert step1["status"] == "skipped"
    assert [c["user_id"] for c in step1["cursors"]] == [test_user.id]


# ============ 8. complete without any cursor ============


def test_complete_without_cursor_works(client):
    instance_id = _create_instance(client)

    # No focus needed — complete straight from pending.
    resp = client.post(
        f"/api/procedure-instances/{instance_id}/steps/2/complete",
        json={},
    )
    assert resp.status_code == 200, resp.text
    assert resp.json()["status"] == "completed"

    state = _state(client, instance_id)
    assert _step(state, 2)["status"] == "completed"


# ============ 9. first complete/skip flips instance ============


def test_first_complete_flips_instance_to_in_work(client, auth_headers):
    instance_id = _create_instance(client)

    before = client.get(f"/api/procedure-instances/{instance_id}").json()
    assert before["status"] == "cut"

    # Focus is presence — it never starts the work order.
    _focus(client, instance_id, 1, headers=auth_headers)
    assert client.get(f"/api/procedure-instances/{instance_id}").json()["status"] == "cut"

    client.post(
        f"/api/procedure-instances/{instance_id}/steps/1/complete",
        json={},
        headers=auth_headers,
    )

    after = client.get(f"/api/procedure-instances/{instance_id}").json()
    assert after["status"] == "in_work"
    assert after["started_at"] is not None

    state = _state(client, instance_id)
    assert state["instance"]["status"] == "in_work"


def test_first_skip_flips_instance_to_in_work(client):
    instance_id = _create_instance(client)

    resp = client.post(
        f"/api/procedure-instances/{instance_id}/steps/1/skip",
        json={"reason": "N/A"},
    )
    assert resp.status_code == 200, resp.text

    after = client.get(f"/api/procedure-instances/{instance_id}").json()
    assert after["status"] == "in_work"
    assert after["started_at"] is not None


# ============ 10. progress counts ============


def test_state_progress_counts_leaf_steps(client, auth_headers):
    instance_id = _create_instance(client)

    state = _state(client, instance_id)
    assert state["instance"]["progress"] == {"done": 0, "total": 3}

    client.post(
        f"/api/procedure-instances/{instance_id}/steps/1/complete",
        json={},
        headers=auth_headers,
    )

    state = _state(client, instance_id)
    assert state["instance"]["progress"] == {"done": 1, "total": 3}


# ============ state 404 ============


def test_state_missing_instance_404(client):
    resp = client.get("/api/procedure-instances/999999/state")
    assert resp.status_code == 404
