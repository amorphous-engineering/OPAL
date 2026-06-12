"""Regression tests for the risk-module adversarial-review findings.

Each test pins a confirmed finding from the PR #42 review: signature
integrity, explicit-null PATCH, filter-before-pagination, asset-text
normalization, FK validation, realized-spawn idempotence, filter-aware
review stamping, RL-03 visibility, matrix XSS, and the MCP validation gaps.
"""

import asyncio
import json
from typing import Any

from fastapi.testclient import TestClient
from sqlalchemy.orm import Session

from opal.db.models import User
from opal.mcp import server


def _call(handler, db, args: dict) -> dict[str, Any]:
    result = asyncio.run(handler(db, args))
    return json.loads(result[0].text)


def _create_risk(client: TestClient, **overrides) -> dict:
    payload = {"title": "Review-fix risk", "probability": 2, "impact": 4}
    payload.update(overrides)
    response = client.post("/api/risks", json=payload)
    assert response.status_code == 201, response.text
    return response.json()


def _accept_risk(client: TestClient, risk: dict, owner_id: int) -> dict:
    patched = client.patch(
        f"/api/risks/{risk['id']}",
        json={
            "condition": "the heater is the only spare on the shelf",
            "departure": "a unit failure during environmental test",
            "asset_text": "test campaign",
            "consequence": "two week delay to the campaign",
            "owner_id": owner_id,
            "acceptance_rationale": "spare lead time is acceptable",
        },
    )
    assert patched.status_code == 200, patched.text
    accepted = client.post(f"/api/risks/{risk['id']}/accept", json={})
    assert accepted.status_code == 200, accepted.text
    return accepted.json()


# ---------------------------------------------------------------------------
# Signature integrity
# ---------------------------------------------------------------------------


def test_signed_rationale_immutable_while_accepted(client: TestClient, test_user: User):
    risk = _create_risk(client)
    _accept_risk(client, risk, test_user.id)

    response = client.patch(
        f"/api/risks/{risk['id']}", json={"acceptance_rationale": "schedule pressure"}
    )
    assert response.status_code == 409
    assert "signature" in response.json()["detail"]

    # Unchanged value round-trips (form re-submits) are not a violation
    response = client.patch(
        f"/api/risks/{risk['id']}",
        json={"acceptance_rationale": "spare lead time is acceptable"},
    )
    assert response.status_code == 200
    assert response.json()["disposition"] == "accepted"


def test_rationale_editable_before_acceptance(client: TestClient):
    risk = _create_risk(client)
    response = client.patch(
        f"/api/risks/{risk['id']}", json={"acceptance_rationale": "draft rationale"}
    )
    assert response.status_code == 200
    assert response.json()["acceptance_rationale"] == "draft rationale"


# ---------------------------------------------------------------------------
# PATCH contract
# ---------------------------------------------------------------------------


def test_patch_explicit_null_probability_rejected(client: TestClient):
    risk = _create_risk(client)
    for field in ("probability", "impact", "title"):
        response = client.patch(f"/api/risks/{risk['id']}", json={field: None})
        assert response.status_code == 422, (field, response.text)
        assert "cannot be cleared" in response.json()["detail"]


def test_patch_empty_asset_text_is_noop_on_accepted_risk(client: TestClient, test_user: User):
    part = client.post("/api/parts", json={"name": "Asset part", "tier": 1}).json()
    risk = _create_risk(client, asset_part_id=part["id"])
    patched = client.patch(
        f"/api/risks/{risk['id']}",
        json={
            "condition": "the part is the only flight unit",
            "departure": "a handling drop during integration",
            "consequence": "loss of the flight unit",
            "owner_id": test_user.id,
            "acceptance_rationale": "handling procedure is rated",
        },
    )
    assert patched.status_code == 200, patched.text
    accepted = client.post(f"/api/risks/{risk['id']}/accept", json={})
    assert accepted.status_code == 200, accepted.text

    # "" means not-set: stored as NULL, no phantom scenario change
    response = client.patch(f"/api/risks/{risk['id']}", json={"asset_text": "  "})
    body = response.json()
    assert response.status_code == 200
    assert body["disposition"] == "accepted"
    assert body["acceptance_invalidated"] is False
    assert body["asset_text"] is None
    assert body["asset_part_id"] == part["id"]


def test_unknown_owner_and_asset_part_are_404_not_500(client: TestClient):
    risk = _create_risk(client)
    assert client.patch(f"/api/risks/{risk['id']}", json={"owner_id": 99999}).status_code == 404
    assert (
        client.post(
            "/api/risks", json={"title": "bad part", "asset_part_id": 99999}
        ).status_code
        == 404
    )


# ---------------------------------------------------------------------------
# List filters run in SQL, before pagination
# ---------------------------------------------------------------------------


def test_severity_filter_applies_before_pagination(client: TestClient):
    high = [_create_risk(client, probability=5, impact=5) for _ in range(2)]
    for _ in range(3):
        _create_risk(client, probability=1, impact=1)

    response = client.get("/api/risks", params={"severity": "high", "page_size": 2})
    body = response.json()
    assert body["total"] == 2
    assert {item["id"] for item in body["items"]} == {r["id"] for r in high}

    response = client.get("/api/risks", params={"min_score": 25, "page_size": 1})
    assert response.json()["total"] == 2


# ---------------------------------------------------------------------------
# Realized spawn is not repeatable
# ---------------------------------------------------------------------------


def test_spawn_realized_twice_refused(client: TestClient):
    risk = _create_risk(client)
    first = client.post(
        f"/api/risks/{risk['id']}/issues/spawn", json={"role": "realized", "title": "it happened"}
    )
    assert first.status_code == 201
    second = client.post(
        f"/api/risks/{risk['id']}/issues/spawn", json={"role": "realized", "title": "again?"}
    )
    assert second.status_code == 409
    assert "already realized" in second.json()["detail"]


# ---------------------------------------------------------------------------
# Review stamp covers the listed set, not the rendered page
# ---------------------------------------------------------------------------


def test_review_stamp_by_filters_stamps_all_matching(client: TestClient):
    high = [_create_risk(client, probability=5, impact=5) for _ in range(3)]
    low = _create_risk(client, probability=1, impact=1)

    response = client.post("/api/risks/review-stamp", json={"severity": "high"})
    assert response.status_code == 200
    assert response.json()["stamped"] == 3

    for risk in high:
        assert client.get(f"/api/risks/{risk['id']}").json()["last_reviewed_at"] is not None
    assert client.get(f"/api/risks/{low['id']}").json()["last_reviewed_at"] is None


def test_review_stamp_empty_ids_rejected(client: TestClient):
    _create_risk(client)
    response = client.post("/api/risks/review-stamp", json={"risk_ids": []})
    assert response.status_code == 422  # min_length=1 on explicit ids


# ---------------------------------------------------------------------------
# RL-03 is visible: span over the whole consequence
# ---------------------------------------------------------------------------


def test_rl03_finding_carries_a_span(client: TestClient):
    text = "the team will be unhappy"
    response = client.post("/api/risks/lint", json={"consequence": text})
    findings = response.json()["findings"]["consequence"]
    rl03 = [f for f in findings if f["rule"] == "RL-03"]
    assert rl03 and rl03[0]["span"] == [0, len(text)]


# ---------------------------------------------------------------------------
# Matrix page: titles cannot break out of the inline script block
# ---------------------------------------------------------------------------


def test_matrix_page_escapes_script_breakout_titles(web_client: TestClient):
    payload = '</script><img src=x onerror=alert(1)>'
    _create_risk(web_client, title=payload)
    page = web_client.get("/risks/matrix")
    assert page.status_code == 200
    assert payload not in page.text  # | tojson escapes < and > as \u00xx


# ---------------------------------------------------------------------------
# MCP entry points enforce what their inputSchema only advertises
# ---------------------------------------------------------------------------


def test_mcp_create_risk_rejects_out_of_range_scores(db_session: Session):
    data = _call(server._create_risk, db_session, {"title": "bad", "probability": 7, "impact": 2})
    assert "must be an integer from 1 to 5" in data["error"]


def test_mcp_create_risk_rejects_unknown_owner(db_session: Session):
    data = _call(
        server._create_risk,
        db_session,
        {"title": "bad owner", "probability": 2, "impact": 2, "owner_id": 99999},
    )
    assert "not found" in data["error"]


def test_mcp_stamp_review_empty_list_is_an_error(db_session: Session, test_user: User):
    data = _call(
        server._stamp_risk_review, db_session, {"user_id": test_user.id, "risk_ids": []}
    )
    assert "empty" in data["error"]


def test_mcp_unaccept_requires_a_human_user(
    client: TestClient, db_session: Session, test_user: User
):
    risk = _create_risk(client)
    _accept_risk(client, risk, test_user.id)

    data = _call(
        server._set_risk_disposition,
        db_session,
        {"risk_id": risk["id"], "disposition": "open", "note": "reopening"},
    )
    assert "error" in data and "user" in data["error"].lower()

    data = _call(
        server._set_risk_disposition,
        db_session,
        {
            "risk_id": risk["id"],
            "disposition": "open",
            "note": "reopening",
            "user_id": test_user.id,
        },
    )
    assert data.get("success") is True
