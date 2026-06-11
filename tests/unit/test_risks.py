"""Risks API tests — scenarios, dispositions, acceptance (issue #40)."""

from fastapi.testclient import TestClient

from opal.db.models import User

SCENARIO = {
    "condition": "Valve seat 3 shows erosion after every hot-fire test",
    "departure": "the valve fails to seal during a flight burn",
    "asset_text": "propulsion schedule",
    "consequence": "loss of vehicle",
}


def create_risk(client: TestClient, **overrides) -> dict:
    payload = {"title": "Test Risk", **overrides}
    response = client.post("/api/risks", json=payload)
    assert response.status_code == 201, response.text
    return response.json()


def create_ready_risk(client: TestClient, owner: User, **overrides) -> dict:
    """A risk passing every acceptance readiness check (rationale included)."""
    return create_risk(client, **SCENARIO, owner_id=owner.id, **overrides)


def make_accepted(client: TestClient, owner: User) -> dict:
    risk = create_ready_risk(client, owner)
    response = client.post(
        f"/api/risks/{risk['id']}/accept",
        json={"rationale": "Residual exposure within program tolerance"},
    )
    assert response.status_code == 200, response.text
    return response.json()


# ============ CRUD ============


def test_create_risk_with_scenario(client: TestClient):
    data = create_risk(client, **SCENARIO, probability=3, impact=4)
    assert data["risk_number"].startswith("RISK-")
    assert data["disposition"] == "open"
    assert data["condition"] == SCENARIO["condition"]
    assert data["asset_display"] == "propulsion schedule"
    assert data["statement"] == (
        "Given that Valve seat 3 shows erosion after every hot-fire test, "
        "there is a possibility of the valve fails to seal during a flight burn "
        "adversely impacting propulsion schedule, thereby leading to loss of vehicle."
    )
    assert data["score"] == 12
    assert data["severity"] == "medium"


def test_create_rejects_both_asset_forms(client: TestClient):
    response = client.post(
        "/api/risks",
        json={"title": "Both assets", "asset_part_id": 999999, "asset_text": "schedule"},
    )
    assert response.status_code == 400
    assert "exactly one" in response.json()["detail"]


def test_list_risks_with_disposition_filter(client: TestClient):
    create_risk(client, title="Stays open")
    watched = create_risk(
        client,
        title="Goes to watch",
        watch_observable="chamber pressure decay",
        watch_threshold="> 2 psi/s",
    )
    response = client.post(f"/api/risks/{watched['id']}/disposition", json={"disposition": "watch"})
    assert response.status_code == 200

    response = client.get("/api/risks?disposition=watch")
    assert response.status_code == 200
    data = response.json()
    assert data["total"] == 1
    assert all(item["disposition"] == "watch" for item in data["items"])
    assert data["items"][0]["id"] == watched["id"]


def test_get_risk_includes_statement_and_scores(client: TestClient):
    risk = create_risk(
        client,
        **SCENARIO,
        probability=4,
        impact=5,
        residual_probability=2,
        residual_impact=3,
    )
    response = client.get(f"/api/risks/{risk['id']}")
    assert response.status_code == 200
    data = response.json()
    assert data["statement"].startswith("Given that ")
    assert data["score"] == 20
    assert data["severity"] == "high"
    assert data["residual_probability"] == 2
    assert data["residual_impact"] == 3
    assert data["residual_score"] == 6
    assert data["residual_severity"] == "medium"


def test_patch_partial_update(client: TestClient):
    risk = create_risk(client, **SCENARIO, probability=3, impact=3)
    response = client.patch(f"/api/risks/{risk['id']}", json={"title": "Renamed"})
    assert response.status_code == 200
    data = response.json()
    assert data["title"] == "Renamed"
    # Untouched fields survive a partial update.
    assert data["condition"] == SCENARIO["condition"]
    assert data["probability"] == 3
    assert data["acceptance_invalidated"] is False


def test_delete_risk(client: TestClient):
    risk = create_risk(client)
    assert client.delete(f"/api/risks/{risk['id']}").status_code == 204
    assert client.get(f"/api/risks/{risk['id']}").status_code == 404


# ============ Acceptance ============


def test_accept_409_when_not_ready(client: TestClient):
    risk = create_risk(client)  # no scenario, owner, or rationale
    response = client.post(f"/api/risks/{risk['id']}/accept", json={})
    assert response.status_code == 409
    detail = response.json()["detail"]
    assert "missing:" in detail
    assert "owner" in detail


def test_accept_200_when_ready(client: TestClient, test_user: User, auth_headers: dict):
    risk = create_ready_risk(client, test_user)
    response = client.post(
        f"/api/risks/{risk['id']}/accept",
        json={"rationale": "Within program tolerance"},
        headers=auth_headers,
    )
    assert response.status_code == 200, response.text
    data = response.json()
    assert data["disposition"] == "accepted"
    assert data["accepted_by_id"] == test_user.id
    assert data["accepted_by_name"] == test_user.name
    assert data["accepted_at"] is not None
    assert data["acceptance_rationale"] == "Within program tolerance"


def test_patch_accepted_risk_reverts_to_open(client: TestClient, test_user: User):
    accepted = make_accepted(client, test_user)
    response = client.patch(f"/api/risks/{accepted['id']}", json={"probability": 5})
    assert response.status_code == 200
    data = response.json()
    assert data["disposition"] == "open"
    assert data["acceptance_invalidated"] is True
    # Signature kept as history, not erased.
    assert data["accepted_by_id"] == accepted["accepted_by_id"]
    assert data["accepted_at"] is not None


# ============ Dispositions ============


def test_disposition_watch_happy_path(client: TestClient):
    risk = create_risk(
        client,
        watch_observable="chamber pressure decay",
        watch_threshold="> 2 psi/s",
        watch_contingency="hold launch and inspect",
    )
    response = client.post(f"/api/risks/{risk['id']}/disposition", json={"disposition": "watch"})
    assert response.status_code == 200
    assert response.json()["disposition"] == "watch"


def test_disposition_mitigate_409_names_requirement(client: TestClient):
    risk = create_risk(client)  # no links, no residual
    response = client.post(f"/api/risks/{risk['id']}/disposition", json={"disposition": "mitigate"})
    assert response.status_code == 409
    detail = response.json()["detail"]
    assert "mitigation" in detail
    assert "residual" in detail
    # State preservation on refusal is asserted in test_risks_domain — the
    # route's rollback-on-409 discards this fixture's outer test transaction.


def test_get_dispositions_lists_seven(client: TestClient):
    response = client.get("/api/risks/dispositions")
    assert response.status_code == 200
    assert set(response.json()) == {
        "open",
        "mitigate",
        "watch",
        "research",
        "accepted",
        "closed",
        "realized",
    }


# ============ Linked issues ============


def test_link_issue_and_duplicate_409(client: TestClient):
    risk = create_risk(client)
    issue = client.post("/api/issues", json={"title": "Add backup seal"}).json()

    response = client.post(
        f"/api/risks/{risk['id']}/issues",
        json={"issue_id": issue["id"], "role": "mitigation"},
    )
    assert response.status_code == 201
    linked = response.json()["linked_issues"]
    assert len(linked) == 1
    assert linked[0]["issue_id"] == issue["id"]
    assert linked[0]["role"] == "mitigation"
    assert linked[0]["status"] == "open"

    duplicate = client.post(
        f"/api/risks/{risk['id']}/issues",
        json={"issue_id": issue["id"], "role": "research"},
    )
    assert duplicate.status_code == 409


def test_spawn_mitigation_issue(client: TestClient):
    risk = create_risk(client)
    response = client.post(
        f"/api/risks/{risk['id']}/issues/spawn",
        json={"role": "mitigation", "title": "Qualify harder seat material"},
    )
    assert response.status_code == 201
    data = response.json()
    assert len(data["linked_issues"]) == 1
    link = data["linked_issues"][0]
    assert link["role"] == "mitigation"
    assert data["realized_issue_id"] is None

    issue = client.get(f"/api/issues/{link['issue_id']}").json()
    assert issue["issue_type"] == "task"
    assert issue["title"] == "Qualify harder seat material"


def test_spawn_realized_issue(client: TestClient):
    risk = create_risk(client)
    response = client.post(
        f"/api/risks/{risk['id']}/issues/spawn",
        json={"role": "realized", "title": "Valve failed to seal on SN004"},
    )
    assert response.status_code == 201
    data = response.json()
    assert data["realized_issue_id"] is not None
    assert data["linked_issues"] == []  # realization is a pointer, not a response link

    issue = client.get(f"/api/issues/{data['realized_issue_id']}").json()
    assert issue["issue_type"] == "non_conformance"


def test_unlink_issue(client: TestClient):
    risk = create_risk(client)
    issue = client.post("/api/issues", json={"title": "Linked then removed"}).json()
    client.post(
        f"/api/risks/{risk['id']}/issues",
        json={"issue_id": issue["id"], "role": "mitigation"},
    )

    response = client.delete(f"/api/risks/{risk['id']}/issues/{issue['id']}")
    assert response.status_code == 200
    assert response.json()["linked_issues"] == []
    # The issue itself is untouched.
    assert client.get(f"/api/issues/{issue['id']}").status_code == 200


# ============ Review stamp, readiness, lint, matrix ============


def test_review_stamp_stamps_listed(client: TestClient):
    stamped = create_risk(client, title="Reviewed")
    skipped = create_risk(client, title="Not reviewed")

    response = client.post("/api/risks/review-stamp", json={"risk_ids": [stamped["id"]]})
    assert response.status_code == 200
    data = response.json()
    assert data["stamped"] == 1
    assert "T" in data["reviewed_at"]  # ISO 8601

    assert client.get(f"/api/risks/{stamped['id']}").json()["last_reviewed_at"] is not None
    assert client.get(f"/api/risks/{skipped['id']}").json()["last_reviewed_at"] is None


def test_readiness_shape(client: TestClient):
    risk = create_risk(client)
    response = client.get(f"/api/risks/{risk['id']}/readiness")
    assert response.status_code == 200
    data = response.json()
    assert data["ready"] is False
    assert {c["key"] for c in data["checks"]} == {
        "scenario_complete",
        "owner_assigned",
        "scored",
        "rationale_recorded",
        "lint_clean",
    }
    for check in data["checks"]:
        assert set(check) == {"key", "label", "passed", "severity", "detail"}


def test_lint_endpoint(client: TestClient):
    response = client.post(
        "/api/risks/lint",
        json={
            "condition": "the valve might be eroded",
            "departure": "seal fails unless we add a backup",
            "consequence": "the team becomes sad",
        },
    )
    assert response.status_code == 200
    data = response.json()
    assert data["would_block_accept"] is True
    assert [f["rule"] for f in data["findings"]["condition"]] == ["RL-01"]
    assert [f["rule"] for f in data["findings"]["departure"]] == ["RL-02"]
    assert [f["rule"] for f in data["findings"]["consequence"]] == ["RL-03"]

    clean = client.post("/api/risks/lint", json=SCENARIO).json()
    assert clean["would_block_accept"] is False
    assert all(v == [] for v in clean["findings"].values())


def test_risk_matrix(client: TestClient):
    create_risk(client, probability=5, impact=5, residual_probability=2, residual_impact=2)
    closing = create_risk(client, probability=1, impact=1)
    client.post(
        f"/api/risks/{closing['id']}/disposition",
        json={"disposition": "closed", "note": "no longer credible"},
    )

    response = client.get("/api/risks/matrix")
    assert response.status_code == 200
    data = response.json()
    assert len(data["matrix"]) == 5 and len(data["matrix"][0]) == 5
    assert data["matrix"][4][4] == 1
    assert data["residual_matrix"][1][1] == 1
    assert data["matrix"][0][0] == 0  # closed risks are not live exposure
    assert data["total_risks"] == 1
