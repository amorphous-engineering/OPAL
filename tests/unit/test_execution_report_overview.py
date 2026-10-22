"""Build report, QR, executions overview (list) and cut preview endpoints."""

from datetime import UTC, datetime

from fastapi.testclient import TestClient
from sqlalchemy.orm import Session

from opal.db.models.attachment import Attachment
from opal.db.models.dataset import DataPoint, Dataset
from opal.db.models.execution import InstanceStatus, ProcedureInstance

BASE = "/api/procedure-instances"


def _publish(client: TestClient, name: str = "Build Report Proc", titles=("Solder",)) -> int:
    proc_id = client.post("/api/procedures", json={"name": name}).json()["id"]
    for t in titles:
        client.post(f"/api/procedures/{proc_id}/steps", json={"title": t})
    client.post(f"/api/procedures/{proc_id}/publish")
    return proc_id


def _cut(client: TestClient, proc_id: int, **extra) -> int:
    resp = client.post(BASE, json={"procedure_id": proc_id, **extra})
    assert resp.status_code == 201, resp.text
    return resp.json()["id"]


def _completed_instance(client: TestClient, db_session: Session) -> ProcedureInstance:
    instance_id = _cut(client, _publish(client))
    instance = db_session.query(ProcedureInstance).filter(ProcedureInstance.id == instance_id).one()
    instance.status = InstanceStatus.COMPLETED
    instance.started_at = datetime.now(UTC)
    instance.completed_at = datetime.now(UTC)
    db_session.commit()
    db_session.refresh(instance)
    return instance


# ============ report ============


def test_report_content_when_completed(client: TestClient, db_session: Session):
    instance = _completed_instance(client, db_session)
    resp = client.get(f"{BASE}/{instance.id}/report")
    assert resp.status_code == 200, resp.text
    report = resp.json()
    assert report["instance"]["procedure_name"] == "Build Report Proc"
    assert report["instance"]["status"] == "completed"
    assert [o["title"] for o in report["operations"]] == ["Solder"]
    assert report["closeout_attachments"] == []
    assert report["issues"] == []
    assert report["data_collects"] == []


def test_report_rejects_when_not_completed(client: TestClient):
    instance_id = _cut(client, _publish(client, "Pending Proc", ("Step 1",)))
    resp = client.get(f"{BASE}/{instance_id}/report")
    assert resp.status_code == 400
    assert "CUT" in resp.json()["detail"] and "COMPLETED" in resp.json()["detail"]


def test_report_includes_only_closeout_photos(client: TestClient, db_session: Session):
    instance = _completed_instance(client, db_session)
    closeout = Attachment(
        original_filename="closeout_shot.jpg",
        stored_filename="closeout-uuid.jpg",
        mime_type="image/jpeg",
        size_bytes=1234,
        kind="closeout",
        procedure_instance_id=instance.id,
    )
    plain = Attachment(
        original_filename="random_note.txt",
        stored_filename="plain-uuid.txt",
        mime_type="text/plain",
        size_bytes=10,
        kind=None,
        procedure_instance_id=instance.id,
    )
    db_session.add_all([closeout, plain])
    db_session.commit()

    report = client.get(f"{BASE}/{instance.id}/report").json()
    assert [a["id"] for a in report["closeout_attachments"]] == [closeout.id]


def test_report_charts_only_numeric_chart_true_fields(client: TestClient, db_session: Session):
    instance = _completed_instance(client, db_session)
    step_exec = instance.step_executions[0]
    dataset = Dataset(
        name="Build Readings",
        schema={
            "fields": [
                {"name": "pressure", "type": "number", "unit": "PSI", "chart": True},
                {"name": "temperature", "type": "number", "unit": "C"},
                {"name": "notes", "type": "text", "chart": True},
            ]
        },
    )
    db_session.add(dataset)
    db_session.flush()
    db_session.add(
        DataPoint(
            dataset_id=dataset.id,
            recorded_at=datetime.now(UTC),
            values={"pressure": 120, "temperature": 22, "notes": "ok"},
            step_execution_id=step_exec.id,
        )
    )
    db_session.commit()

    charts = client.get(f"{BASE}/{instance.id}/report").json()["chart_datasets"]
    assert len(charts) == 1
    assert [f["name"] for f in charts[0]["chart_fields"]] == ["pressure"]
    assert charts[0]["points"][0]["values"]["pressure"] == 120


def test_report_labels_captured_data_from_schema(client: TestClient):
    proc_id = client.post("/api/procedures", json={"name": "Labelled"}).json()["id"]
    client.post(
        f"/api/procedures/{proc_id}/steps",
        json={
            "title": "Torque",
            "required_data_schema": {
                "fields": [{"name": "t", "label": "TORQUE", "type": "number", "unit": "Nm"}]
            },
        },
    )
    client.post(f"/api/procedures/{proc_id}/publish")
    instance_id = _cut(client, proc_id)
    client.post(f"{BASE}/{instance_id}/steps/1/complete", json={"data_captured": {"t": 9}})
    report = client.get(f"{BASE}/{instance_id}/report").json()
    assert report["instance"]["status"] == "completed"
    row = report["data_collects"][0]["rows"][0]
    assert (row["label"], row["value"], row["unit"]) == ("TORQUE", "9", "Nm")


def test_qr_svg(client: TestClient):
    instance_id = _cut(client, _publish(client))
    resp = client.get(f"{BASE}/{instance_id}/qr.svg", params={"origin": "http://shop.local:8080"})
    assert resp.status_code == 200
    assert resp.headers["content-type"].startswith("image/svg+xml")
    assert b"<svg" in resp.content
    assert (
        client.get(f"{BASE}/{instance_id}/qr.svg", params={"origin": "ftp://x"}).status_code == 400
    )


# ============ overview ============


def test_overview_progress_and_counts(client: TestClient):
    proc_id = _publish(client, "Overview Proc", ("A", "B"))
    first = _cut(client, proc_id)
    _cut(client, proc_id)
    client.post(f"{BASE}/{first}/steps/1/complete", json={})

    resp = client.get(f"{BASE}/overview")
    assert resp.status_code == 200, resp.text
    body = resp.json()
    assert body["total"] == 2
    assert body["counts"]["in_work"] == 1 and body["counts"]["cut"] == 1
    row = next(r for r in body["items"] if r["id"] == first)
    assert (row["progress_done"], row["progress_total"]) == (1, 2)
    assert row["status"] == "in_work"
    assert row["procedure_name"] == "Overview Proc"
    assert row["version_number"] == 1
    assert row["cut_by"] == "Test Client"
    # Newest first by default.
    assert body["items"][0]["id"] > body["items"][1]["id"]


def test_overview_filters(client: TestClient):
    proc_a = _publish(client, "Alpha Proc", ("A",))
    proc_b = _publish(client, "Bravo Proc", ("B",))
    a1 = _cut(client, proc_a)
    b1 = _cut(client, proc_b)
    client.post(f"{BASE}/{a1}/steps/1/complete", json={})  # a1 -> completed

    def ids(**params):
        r = client.get(f"{BASE}/overview", params=params)
        assert r.status_code == 200, r.text
        return {i["id"] for i in r.json()["items"]}

    assert ids(procedure_id=proc_a) == {a1}
    assert ids(status="completed") == {a1}
    assert ids(status=["cut", "in_work"]) == {b1}
    assert ids(status="cut,completed") == {a1, b1}
    assert ids(q="bravo") == {b1}
    work_order = client.get(f"{BASE}/{a1}").json()["work_order_number"]
    assert ids(q=work_order) == {a1}
    # Counts ignore the status filter (they are the filter chips).
    counts = client.get(f"{BASE}/overview", params={"status": "completed"}).json()["counts"]
    assert counts["completed"] == 1 and counts["cut"] == 1


def test_overview_held_and_mine(client: TestClient, auth_headers: dict):
    proc_id = _publish(client, "Held Proc", ("A", "B"))
    held = _cut(client, proc_id)
    clean = _cut(client, proc_id)
    nc = client.post(f"{BASE}/{held}/steps/1/nc", json={"title": "Bad"}).json()

    body = client.get(f"{BASE}/overview", params={"held": True}).json()
    assert [r["id"] for r in body["items"]] == [held]
    assert body["items"][0]["held_by"] == [nc["issue_number"]]

    # "mine": the bearer user cut both; a different user has neither cut nor worked them.
    mine = client.get(f"{BASE}/overview", params={"mine": True}).json()
    assert {r["id"] for r in mine["items"]} == {held, clean}
    other = client.get(f"{BASE}/overview", params={"mine": True}, headers=auth_headers).json()
    assert other["items"] == []

    # Claiming a step makes the user a worker on the row and in "mine".
    assert (
        client.post(
            f"{BASE}/{clean}/focus", json={"step_number": 2}, headers=auth_headers
        ).status_code
        == 200
    )
    other = client.get(f"{BASE}/overview", params={"mine": True}, headers=auth_headers).json()
    assert [r["id"] for r in other["items"]] == [clean]
    assert other["items"][0]["working"][0]["step_number"] == "2"


def test_overview_sort_and_pagination(client: TestClient):
    names = ["Zulu Proc", "Alpha Proc", "Mike Proc"]
    for n in names:
        _cut(client, _publish(client, n, ("A",)))
    asc = client.get(f"{BASE}/overview", params={"sort": "procedure", "dir": "asc"}).json()
    assert [r["procedure_name"] for r in asc["items"]] == sorted(names)
    page2 = client.get(f"{BASE}/overview", params={"page": 2, "page_size": 2}).json()
    assert len(page2["items"]) == 1 and page2["total"] == 3
    assert client.get(f"{BASE}/overview", params={"dir": "sideways"}).status_code == 422


def test_overview_requires_auth(app):
    assert TestClient(app).get(f"{BASE}/overview").status_code == 401


# ============ cut preview ============


def _active_part(client: TestClient, name: str, stock: float | None = None) -> dict:
    part = client.post(
        "/api/parts",
        json={"name": name, "tracking_type": "bulk", "category": "Electronics", "tier": 3},
    ).json()
    client.post(f"/api/parts/{part['id']}/activate", json={"cause": "test setup"})
    if stock:
        client.post(
            "/api/inventory", json={"part_id": part["id"], "quantity": stock, "location": "STORE"}
        )
    return part


def test_preview_kit_availability_scales_with_quantity(client: TestClient):
    part = _active_part(client, "Resistor", stock=10)
    proc_id = client.post("/api/procedures", json={"name": "Kit Preview"}).json()["id"]
    client.post(
        f"/api/procedures/{proc_id}/kit", json={"part_id": part["id"], "quantity_required": 4}
    )
    client.post(f"/api/procedures/{proc_id}/steps", json={"title": "Install"})
    client.post(f"/api/procedures/{proc_id}/publish")

    one = client.get(f"{BASE}/preview", params={"procedure_id": proc_id, "quantity": 2}).json()
    assert one["all_available"] is True
    assert one["kit"][0]["required"] == 8 and one["kit"][0]["available"] == 10
    assert one["version_number"] == 1 and one["versions"][0]["is_current"] is True

    three = client.get(f"{BASE}/preview", params={"procedure_id": proc_id, "quantity": 3}).json()
    assert three["all_available"] is False
    assert three["kit"][0]["is_available"] is False


def test_preview_build_outputs_show_next_serials_without_allocating(client: TestClient):
    out_part = _active_part(client, "Assembly Out")
    proc_id = client.post(
        "/api/procedures", json={"name": "Build Preview", "procedure_type": "build"}
    ).json()["id"]
    client.post(f"/api/procedures/{proc_id}/steps", json={"title": "Assemble"})
    client.post(
        f"/api/procedures/{proc_id}/outputs",
        json={"part_id": out_part["id"], "quantity_produced": 1},
    )
    client.post(f"/api/procedures/{proc_id}/publish")

    first = client.get(f"{BASE}/preview", params={"procedure_id": proc_id, "quantity": 2}).json()
    again = client.get(f"{BASE}/preview", params={"procedure_id": proc_id, "quantity": 2}).json()
    assert first["procedure_type"] == "build"
    assert first["outputs"][0]["serials"] == ["001", "002"]
    assert again["outputs"] == first["outputs"]  # peeking allocates nothing

    # The cut hands out exactly the serials the preview promised.
    _cut(client, proc_id, quantity=2)
    prods = client.get(f"{BASE}/overview").json()["items"]
    assert len(prods) == 2
    after = client.get(f"{BASE}/preview", params={"procedure_id": proc_id}).json()
    assert after["outputs"][0]["serials"] == ["003"]


def test_preview_validation(client: TestClient):
    assert client.get(f"{BASE}/preview", params={"procedure_id": 9999}).status_code == 404
    draft = client.post("/api/procedures", json={"name": "Draft only"}).json()["id"]
    assert client.get(f"{BASE}/preview", params={"procedure_id": draft}).status_code == 400
    proc_id = _publish(client)
    bad = client.get(f"{BASE}/preview", params={"procedure_id": proc_id, "version_id": 9999})
    assert bad.status_code == 404


def test_assignees_visible_to_non_admin(client: TestClient, auth_headers: dict, test_user):
    resp = client.get(f"{BASE}/assignees", headers=auth_headers)
    assert resp.status_code == 200
    assert {"id": test_user.id, "name": test_user.name} in resp.json()
    assert all(set(u) == {"id", "name"} for u in resp.json())
