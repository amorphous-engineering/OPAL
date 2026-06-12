"""Step claim lifecycle tests — start/release/complete/skip + /state document.

The `client` fixture's default identity is the admin SERVICE user ("Test
Client"); `auth_headers` attributes requests to `test_user` ("Test User",
initials TU). Conflict tests use both identities against the same step.
"""


def _create_procedure_with_steps(client):
    """Create a procedure with 3 top-level steps and publish it."""
    proc_response = client.post(
        "/api/procedures",
        json={"name": "Claim Test Procedure"},
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


# ============ 1. start claims ============


def test_start_claims_step_with_initials_in_state(client, auth_headers, test_user):
    instance_id = _create_instance(client)

    resp = client.post(
        f"/api/procedure-instances/{instance_id}/steps/1/start",
        headers=auth_headers,
    )
    assert resp.status_code == 200, resp.text
    assert resp.json()["status"] == "in_progress"

    state = _state(client, instance_id)
    step = _step(state, 1)
    assert step["status"] == "in_progress"
    assert step["claim"] is not None
    assert step["claim"]["user_id"] == test_user.id
    assert step["claim"]["name"] == "Test User"
    assert step["claim"]["initials"] == "TU"
    assert step["claim"]["claimed_at"] is not None

    # Roster has the claimant with the step number.
    claimants = [r for r in state["roster"] if not r["observer"]]
    assert len(claimants) == 1
    assert claimants[0]["user_id"] == test_user.id
    assert claimants[0]["initials"] == "TU"
    assert claimants[0]["step_order"] == 1
    assert claimants[0]["step_number"] == "1"


# ============ 2. one user per step ============


def test_second_user_start_on_claimed_step_conflicts(client, auth_headers):
    instance_id = _create_instance(client)

    client.post(
        f"/api/procedure-instances/{instance_id}/steps/1/start",
        headers=auth_headers,
    )

    # Default client identity (service user) is a different user.
    resp = client.post(f"/api/procedure-instances/{instance_id}/steps/1/start")
    assert resp.status_code == 409
    assert "Test User" in resp.json()["detail"]


def test_start_by_claimant_is_idempotent(client, auth_headers):
    instance_id = _create_instance(client)

    client.post(
        f"/api/procedure-instances/{instance_id}/steps/1/start",
        headers=auth_headers,
    )
    resp = client.post(
        f"/api/procedure-instances/{instance_id}/steps/1/start",
        headers=auth_headers,
    )
    assert resp.status_code == 200
    assert resp.json()["status"] == "in_progress"


# ============ 3. one active step per user ============


def test_claiming_second_step_releases_first(client, auth_headers, test_user):
    instance_id = _create_instance(client)

    client.post(
        f"/api/procedure-instances/{instance_id}/steps/1/start",
        headers=auth_headers,
    )
    client.post(
        f"/api/procedure-instances/{instance_id}/steps/2/start",
        headers=auth_headers,
    )

    state = _state(client, instance_id)
    step1 = _step(state, 1)
    step2 = _step(state, 2)

    # Step 1 was superseded: back to pending, no claim.
    assert step1["status"] == "pending"
    assert step1["claim"] is None
    # Step 2 holds the user's single active claim.
    assert step2["status"] == "in_progress"
    assert step2["claim"]["user_id"] == test_user.id

    claimants = [r for r in state["roster"] if not r["observer"]]
    assert len(claimants) == 1
    assert claimants[0]["step_order"] == 2


# ============ 4. release ============


def test_release_returns_step_to_pending(client, auth_headers):
    instance_id = _create_instance(client)

    client.post(
        f"/api/procedure-instances/{instance_id}/steps/1/start",
        headers=auth_headers,
    )
    resp = client.post(
        f"/api/procedure-instances/{instance_id}/steps/1/release",
        headers=auth_headers,
    )
    assert resp.status_code == 200, resp.text
    assert resp.json()["status"] == "pending"

    state = _state(client, instance_id)
    step1 = _step(state, 1)
    assert step1["status"] == "pending"
    assert step1["claim"] is None
    assert all(s["claim"] is None for s in state["steps"])
    assert [r for r in state["roster"] if not r["observer"]] == []


def test_release_without_claim_404(client, auth_headers):
    instance_id = _create_instance(client)

    resp = client.post(
        f"/api/procedure-instances/{instance_id}/steps/1/release",
        headers=auth_headers,
    )
    assert resp.status_code == 404


def test_release_other_users_claim_404(client, auth_headers):
    instance_id = _create_instance(client)

    client.post(
        f"/api/procedure-instances/{instance_id}/steps/1/start",
        headers=auth_headers,
    )
    # Default client identity is a different user — cannot release TU's claim.
    resp = client.post(f"/api/procedure-instances/{instance_id}/steps/1/release")
    assert resp.status_code == 404

    # The claim survives the failed release.
    state = _state(client, instance_id)
    assert _step(state, 1)["claim"] is not None


# ============ 5. complete releases the claim ============


def test_complete_releases_claim_and_records_completed_by(client, auth_headers, test_user):
    instance_id = _create_instance(client)

    client.post(
        f"/api/procedure-instances/{instance_id}/steps/1/start",
        headers=auth_headers,
    )
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
    assert step1["claim"] is None
    assert step1["completed"] is not None
    assert step1["completed"]["by"] == "Test User"
    assert step1["completed"]["initials"] == "TU"
    assert step1["completed"]["at"] is not None
    assert [r for r in state["roster"] if not r["observer"]] == []


# ============ 6. complete by another user while claimed ============


def test_complete_by_other_user_while_claimed_409(client, auth_headers):
    instance_id = _create_instance(client)

    client.post(
        f"/api/procedure-instances/{instance_id}/steps/1/start",
        headers=auth_headers,
    )
    # Default client identity tries to complete TU's claimed step.
    resp = client.post(
        f"/api/procedure-instances/{instance_id}/steps/1/complete",
        json={},
    )
    assert resp.status_code == 409
    assert "Test User" in resp.json()["detail"]


# ============ 7. skip vs claims ============


def test_skip_claimed_by_other_user_409(client, auth_headers):
    instance_id = _create_instance(client)

    client.post(
        f"/api/procedure-instances/{instance_id}/steps/1/start",
        headers=auth_headers,
    )
    resp = client.post(
        f"/api/procedure-instances/{instance_id}/steps/1/skip",
        json={"reason": "trying to skip someone else's work"},
    )
    assert resp.status_code == 409
    assert "Test User" in resp.json()["detail"]


def test_skip_by_claimant_releases_claim(client, auth_headers):
    instance_id = _create_instance(client)

    client.post(
        f"/api/procedure-instances/{instance_id}/steps/1/start",
        headers=auth_headers,
    )
    resp = client.post(
        f"/api/procedure-instances/{instance_id}/steps/1/skip",
        json={"reason": "N/A for this config"},
        headers=auth_headers,
    )
    assert resp.status_code == 200, resp.text
    assert resp.json()["status"] == "skipped"

    state = _state(client, instance_id)
    step1 = _step(state, 1)
    assert step1["status"] == "skipped"
    assert step1["claim"] is None
    assert [r for r in state["roster"] if not r["observer"]] == []


# ============ 8. legacy complete-without-claim ============


def test_complete_pending_unclaimed_step_still_works(client):
    instance_id = _create_instance(client)

    # No start, no claim — complete straight from pending.
    resp = client.post(
        f"/api/procedure-instances/{instance_id}/steps/2/complete",
        json={},
    )
    assert resp.status_code == 200, resp.text
    assert resp.json()["status"] == "completed"

    state = _state(client, instance_id)
    assert _step(state, 2)["status"] == "completed"


# ============ 9. first claim flips instance ============


def test_first_claim_flips_instance_to_in_progress(client, auth_headers):
    instance_id = _create_instance(client)

    before = client.get(f"/api/procedure-instances/{instance_id}").json()
    assert before["status"] == "pending"

    client.post(
        f"/api/procedure-instances/{instance_id}/steps/1/start",
        headers=auth_headers,
    )

    after = client.get(f"/api/procedure-instances/{instance_id}").json()
    assert after["status"] == "in_progress"

    state = _state(client, instance_id)
    assert state["instance"]["status"] == "in_progress"


# ============ 10. progress counts ============


def test_state_progress_counts_leaf_steps(client, auth_headers):
    instance_id = _create_instance(client)

    state = _state(client, instance_id)
    assert state["instance"]["progress"] == {"done": 0, "total": 3}

    client.post(
        f"/api/procedure-instances/{instance_id}/steps/1/start",
        headers=auth_headers,
    )
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
