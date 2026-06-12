"""Web-render regression tests for the risk module UI (issue #40).

Catches missing templates/partials and the register/detail rules from the
spec: no ID column, risk_number carries the accent, the generated statement
is the masthead, per-disposition fields exist only for the selected target,
and the acceptance panel mirrors the baseline panel.
"""

from fastapi.testclient import TestClient


def _create_risk(client: TestClient, **overrides) -> dict:
    payload = {"title": "Web risk", "probability": 2, "impact": 4}
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


def test_register_columns_no_id_column(web_client):
    _create_risk(web_client)
    page = web_client.get("/risks")
    assert page.status_code == 200
    for column in ("RISK", "TITLE", "DISP", "SCORE", "OWNER", "REVIEWED"):
        assert column in page.text
    # No ID column; the bulk review stamp is in the header
    assert ">ID<" not in page.text
    assert "REVIEWED ✓" in page.text
    assert "stampReviewed()" in page.text

    rows = web_client.get("/risks/table")
    assert rows.status_code == 200
    assert "RISK-" in rows.text
    assert "data-risk-id" in rows.text


def test_register_review_stamp_appears_per_row(web_client):
    risk = _create_risk(web_client)
    stamp = web_client.post("/api/risks/review-stamp", json={"risk_ids": [risk["id"]]})
    assert stamp.status_code == 200
    rows = web_client.get("/risks/table")
    # Dense relative age with the full ISO 8601 timestamp in the tooltip
    assert 'title="20' in rows.text
    assert ">now<" in rows.text


def test_detail_incomplete_scenario_masthead_placeholder(web_client):
    risk = _create_risk(web_client)
    page = web_client.get(f"/risks/{risk['id']}")
    assert page.status_code == 200
    # risk_number carries the page, never the DB id
    assert risk["risk_number"] in page.text
    assert f"RISK #{risk['id']}" not in page.text
    assert "risk-statement-incomplete" in page.text
    assert "scenario incomplete" in page.text
    # The four scenario editors exist with lint overlays
    for field in ("condition", "departure", "consequence"):
        assert f'id="{field}-text"' in page.text
        assert f'id="{field}-overlay"' in page.text
    # Acceptance panel renders with unmet checks and a disabled accept button
    assert "ACCEPTANCE READINESS" in page.text
    assert f"ACCEPT {risk['risk_number']}" in page.text
    assert "disabled" in page.text


def test_detail_complete_scenario_statement_is_masthead(web_client, test_user):
    risk = _create_risk(web_client)
    updated = _complete_scenario(web_client, risk, test_user.id)
    assert updated["statement"] is not None
    page = web_client.get(f"/risks/{risk['id']}")
    assert page.status_code == 200
    assert "Given that" in page.text
    assert "there is a possibility of" in page.text
    assert "risk-statement-incomplete" not in page.text


def test_detail_lint_underline_renders_server_side(web_client):
    risk = _create_risk(web_client, condition="the valve might stick open")
    page = web_client.get(f"/risks/{risk['id']}")
    assert page.status_code == 200
    assert "lint-block" in page.text  # RL-01 is block_accept severity
    assert "RL-01" in page.text


def test_acceptance_panel_partial_and_accept_flow(web_client, test_user):
    risk = _create_risk(web_client)
    _complete_scenario(web_client, risk, test_user.id)

    panel = web_client.get(f"/risks/{risk['id']}/acceptance-panel")
    assert panel.status_code == 200
    assert "[x]" in panel.text
    assert "openAcceptConfirm()" in panel.text

    accepted = web_client.post(f"/api/risks/{risk['id']}/accept", json={})
    assert accepted.status_code == 200, accepted.text

    page = web_client.get(f"/risks/{risk['id']}")
    assert "accepted:" in page.text
    assert test_user.name in page.text


def test_disposition_panel_fields_only_for_selected_target(web_client):
    risk = _create_risk(web_client)

    watch = web_client.get(f"/risks/{risk['id']}/disposition-panel?target=watch")
    assert watch.status_code == 200
    assert 'id="watch-observable"' in watch.text
    assert 'id="watch-threshold"' in watch.text
    assert 'id="disposition-note"' not in watch.text

    closed = web_client.get(f"/risks/{risk['id']}/disposition-panel?target=closed")
    assert 'id="disposition-note"' in closed.text
    assert 'id="watch-observable"' not in closed.text

    mitigate = web_client.get(f"/risks/{risk['id']}/disposition-panel?target=mitigate")
    # Residual and links have homes elsewhere — status lines, not duplicate inputs
    assert "open mitigation issues" in mitigate.text
    assert "residual score" in mitigate.text
    assert "mitigate requires at least one open linked issue" in mitigate.text


def test_matrix_renders_residual_markers(web_client):
    _create_risk(web_client, residual_probability=1, residual_impact=2)
    page = web_client.get("/risks/matrix")
    assert page.status_code == 200
    assert "matrix-residual" in page.text
    assert "residual target" in page.text


def test_new_risk_form_renders_scenario_fields(web_client):
    page = web_client.get("/risks/new")
    assert page.status_code == 200
    for field in ("condition", "departure", "consequence"):
        assert f'id="{field}-text"' in page.text
    assert 'id="asset-part-select"' in page.text
    assert 'id="asset-text-input"' in page.text
    assert "MITIGATION PLAN" not in page.text
