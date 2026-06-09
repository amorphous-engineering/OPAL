"""Smoke tests: caution/required_role render in editor + runner, target entity on meta."""

import pytest
from fastapi.testclient import TestClient

from opal.db.models import User


@pytest.fixture
def web_client(client: TestClient, test_user: User) -> TestClient:
    """TestClient pre-authenticated with the cookie the auth middleware expects."""
    client.cookies.set("opal_user_id", str(test_user.id))
    return client


def _build_procedure(client: TestClient) -> int:
    proc_id = client.post("/api/procedures", json={"name": "Hazardous Proc"}).json()["id"]
    op = client.post(
        f"/api/procedures/{proc_id}/steps",
        json={"title": "Pressurize system", "caution": "HIGH PRESSURE GAS", "required_role": "QE"},
    ).json()
    client.post(
        f"/api/procedures/{proc_id}/steps",
        json={
            "title": "Open valve",
            "parent_step_id": op["id"],
            "caution": "Stand clear of vent",
            "required_role": "MFG-LEAD",
        },
    )
    return proc_id


def test_procedure_editor_renders_safety_fields(web_client):
    proc_id = _build_procedure(web_client)
    resp = web_client.get(f"/procedures/{proc_id}?tab=operations&op=1")
    assert resp.status_code == 200
    assert "HIGH PRESSURE GAS" in resp.text
    assert "QE" in resp.text


def test_execution_runner_renders_safety_fields(web_client):
    proc_id = _build_procedure(web_client)
    web_client.post(f"/api/procedures/{proc_id}/publish")
    inst = web_client.post(
        "/api/procedure-instances",
        json={
            "procedure_id": proc_id,
            "target_entity": {"entity_type": "part", "entity_id": 7, "entity_label": "SN-00042"},
        },
    ).json()

    runner = web_client.get(f"/executions/{inst['id']}?tab=operations&op=1")
    assert runner.status_code == 200
    assert "CAUTION: HIGH PRESSURE GAS" in runner.text
    assert "Stand clear of vent" in runner.text
    assert "MFG-LEAD" in runner.text

    meta = web_client.get(f"/executions/{inst['id']}?tab=meta")
    assert meta.status_code == 200
    assert "TARGET ENTITY" in meta.text
    assert "SN-00042" in meta.text
    assert "[PART]" in meta.text
