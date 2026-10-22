"""Workcenter API: CRUD plus the default-step and queue views."""

from opal.db.models.procedure import ProcedureStep


def _wc(client, code="SHOP", **extra):
    resp = client.post("/api/workcenters", json={"code": code, "name": f"{code} bay", **extra})
    assert resp.status_code == 201
    return resp.json()


def test_create_and_update_workcenter(client):
    wc = _wc(client, "ab1", location="Hangar")
    assert wc["code"] == "AB1"
    assert wc["default_step_count"] == 0 and wc["queued_step_count"] == 0

    dup = client.post("/api/workcenters", json={"code": "AB1", "name": "again"})
    assert dup.status_code == 400

    resp = client.patch(f"/api/workcenters/{wc['id']}", json={"is_active": False})
    assert resp.status_code == 200
    assert resp.json()["is_active"] is False
    assert client.get("/api/workcenters").json() == []
    assert len(client.get("/api/workcenters", params={"active_only": False}).json()) == 1


def test_blank_name_rejected(client):
    assert client.post("/api/workcenters", json={"code": "X", "name": ""}).status_code == 422


def test_work_lists_default_steps_and_open_queue(client, db_session):
    wc = _wc(client, "BENCH")
    other = _wc(client, "PAD")
    proc_id = client.post("/api/procedures", json={"name": "Assemble"}).json()["id"]
    # The step API does not take a workcenter yet; assign through the model.
    for title, target in (("Torque bolts", wc), ("Roll out", other)):
        step_id = client.post(f"/api/procedures/{proc_id}/steps", json={"title": title}).json()[
            "id"
        ]
        db_session.get(ProcedureStep, step_id).workcenter_id = target["id"]
    db_session.flush()
    client.post(f"/api/procedures/{proc_id}/publish")
    inst = client.post("/api/procedure-instances", json={"procedure_id": proc_id}).json()

    work = client.get(f"/api/workcenters/{wc['id']}/work").json()
    assert [s["title"] for s in work["default_steps"]] == ["Torque bolts"]
    assert [q["step_title"] for q in work["queue"]] == ["Torque bolts"]
    assert work["queue"][0]["work_order_number"] == inst["work_order_number"]

    got = client.get(f"/api/workcenters/{wc['id']}").json()
    assert got["default_step_count"] == 1
    assert got["queued_step_count"] == 1

    # Completing the step takes it out of the queue; the default stays.
    client.post(f"/api/procedure-instances/{inst['id']}/steps/1/complete", json={})
    work = client.get(f"/api/workcenters/{wc['id']}/work").json()
    assert work["queue"] == []
    assert len(work["default_steps"]) == 1


def test_work_404(client):
    assert client.get("/api/workcenters/9999/work").status_code == 404
