"""Smoke tests: caution/required_role render in editor + runner, target entity on meta."""

from fastapi.testclient import TestClient


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
        json={"procedure_id": proc_id},
    ).json()

    runner = web_client.get(f"/executions/{inst['id']}?tab=operations&op=1")
    assert runner.status_code == 200
    assert "CAUTION: HIGH PRESSURE GAS" in runner.text
    assert "Stand clear of vent" in runner.text
    assert "MFG-LEAD" in runner.text
