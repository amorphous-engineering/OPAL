"""API contract the risks client depends on (ported from the old web-render tests).

The HTML assertions are gone with the HTMX UI; what they pinned as logic —
the generated statement, lint findings, the acceptance gate, per-target
disposition requirements, residual markers — is asserted on the JSON here.
"""

from fastapi.testclient import TestClient


def _create_risk(client: TestClient, **overrides) -> dict:
    payload = {"title": "UI risk", "probability": 2, "impact": 4}
    payload.update(overrides)
    response = client.post("/api/risks", json=payload)
    assert response.status_code == 201, response.text
    return response.json()


def _complete_scenario(client: TestClient, risk: dict, owner_id: int) -> dict:
    response = client.patch(
        f"/api/risks/{risk['id']}",
        json={
            "condition": "The integrated system first operates at full power in flight",
            "departure": "an ignition transient outside the heritage envelope",
            "asset_text": "the vehicle",
            "consequence": "loss of vehicle at or near the pad",
            "owner_id": owner_id,
            "acceptance_rationale": "heritage hardware, uncrewed, site rated",
        },
    )
    assert response.status_code == 200, response.text
    return response.json()


def test_incomplete_scenario_has_no_statement(client):
    risk = _create_risk(client)
    assert risk["statement"] is None


def test_complete_scenario_generates_statement(client, test_user):
    risk = _create_risk(client)
    updated = _complete_scenario(client, risk, test_user.id)
    assert "Given that" in updated["statement"]
    assert "there is a possibility of" in updated["statement"]


def test_lint_returns_underline_segments(client):
    response = client.post("/api/risks/lint", json={"condition": "the valve might stick open"})
    body = response.json()
    assert body["would_block_accept"] is True
    segments = body["segments"]["condition"]
    assert "".join(s["text"] for s in segments) == "the valve might stick open"
    flagged = [s for s in segments if s["severity"] == "block"]
    assert flagged and flagged[0]["findings"][0]["rule"] == "RL-01"
    assert body["segments"]["departure"] == []


def test_response_carries_display_names(client, test_user):
    risk = _create_risk(client, owner_id=test_user.id)
    client.post("/api/risks/review-stamp", json={"risk_ids": [risk["id"]]})
    spawned = client.post(
        f"/api/risks/{risk['id']}/issues/spawn", json={"role": "realized", "title": "It happened"}
    ).json()
    assert spawned["realized_issue_number"]
    assert spawned["last_reviewed_by_name"]
    assert spawned["last_reviewed_at"]


def test_acceptance_gate_and_accept(client, test_user):
    risk = _create_risk(client)
    gate = client.get(f"/api/risks/{risk['id']}/readiness").json()
    assert gate["ready"] is False
    _complete_scenario(client, risk, test_user.id)
    assert client.get(f"/api/risks/{risk['id']}/readiness").json()["ready"] is True

    accepted = client.post(f"/api/risks/{risk['id']}/accept", json={})
    assert accepted.status_code == 200, accepted.text
    body = accepted.json()
    assert body["disposition"] == "accepted"
    assert body["accepted_by_name"]
    assert body["acceptance_rationale"] == "heritage hardware, uncrewed, site rated"


def test_disposition_check_names_requirements_per_target(client):
    risk = _create_risk(client)
    rid = risk["id"]

    watch = client.get(f"/api/risks/{rid}/disposition-check", params={"target": "watch"}).json()
    assert any("observable" in b for b in watch["blockers"])
    assert watch["needs_note"] is False

    closed = client.get(f"/api/risks/{rid}/disposition-check", params={"target": "closed"}).json()
    assert closed["needs_note"] is True

    mitigate = client.get(
        f"/api/risks/{rid}/disposition-check", params={"target": "mitigate"}
    ).json()
    assert mitigate["open_mitigations"] == 0
    assert any("residual score" in b for b in mitigate["blockers"])


def test_matrix_residual_markers(client):
    _create_risk(client, residual_probability=1, residual_impact=2)
    data = client.get("/api/risks/matrix").json()
    assert data["residual_matrix"][0][1] == 1
    assert data["matrix"][1][3] == 1


def test_list_filters_by_cell_and_active(client):
    a = _create_risk(client, title="cell a", probability=3, impact=4)
    _create_risk(client, title="cell b", probability=3, impact=5)
    closed = _create_risk(client, title="cell closed", probability=3, impact=4)
    client.post(
        f"/api/risks/{closed['id']}/disposition", json={"disposition": "closed", "note": "done"}
    )

    cell = client.get("/api/risks", params={"probability": 3, "impact": 4}).json()
    assert {r["title"] for r in cell["items"]} == {"cell a", "cell closed"}
    live = client.get("/api/risks", params={"probability": 3, "impact": 4, "active": True}).json()
    assert [r["id"] for r in live["items"]] == [a["id"]]
    assert live["total"] == 1


def test_list_sort_and_owner_filter(client, test_user):
    _create_risk(client, title="low", probability=1, impact=1)
    _create_risk(client, title="high", probability=5, impact=5, owner_id=test_user.id)

    default = client.get("/api/risks").json()["items"]
    assert [r["title"] for r in default][:2] == ["high", "low"]  # score desc by default
    asc = client.get("/api/risks", params={"sort": "score", "dir": "asc"}).json()["items"]
    assert asc[0]["title"] == "low"
    by_title = client.get("/api/risks", params={"sort": "title", "dir": "asc"}).json()["items"]
    titles = [r["title"] for r in by_title]
    assert titles == sorted(titles)
    owned = client.get("/api/risks", params={"owner_id": test_user.id}).json()
    assert [r["title"] for r in owned["items"]] == ["high"]
    assert client.get("/api/risks", params={"sort": "bogus"}).status_code == 422


def test_review_stamp_honours_cell_filter(client):
    keep = _create_risk(client, title="in cell", probability=2, impact=2)
    other = _create_risk(client, title="out of cell", probability=4, impact=4)
    stamped = client.post(
        "/api/risks/review-stamp", json={"probability": 2, "impact": 2, "active": True}
    )
    assert stamped.json()["stamped"] == 1
    assert client.get(f"/api/risks/{keep['id']}").json()["last_reviewed_at"]
    assert client.get(f"/api/risks/{other['id']}").json()["last_reviewed_at"] is None


def test_history_lists_score_and_disposition_changes(client, test_user):
    risk = _create_risk(client, probability=2, impact=2)
    rid = risk["id"]
    client.patch(f"/api/risks/{rid}", json={"probability": 4, "owner_id": test_user.id})
    client.post(f"/api/risks/{rid}/disposition", json={"disposition": "closed", "note": "moot"})

    history = client.get(f"/api/risks/{rid}/history").json()
    assert len(history) == 3  # create, rescore + owner, close
    close = history[0]
    assert close["changes"] == [{"field": "disposition", "from": "open", "to": "closed"}]
    assert close["note"] == "moot"
    fields = {c["field"]: c for c in history[1]["changes"]}
    assert fields["probability"]["from"] == 2 and fields["probability"]["to"] == 4
    assert fields["owner"]["to"] == test_user.name
    assert client.get("/api/risks/99999/history").status_code == 404
