"""Dataset detail behaviour the web client relies on."""

from opal.db.models.audit import AuditLog
from opal.db.models.execution import StepExecution


def _mk(client, fields=None, **extra):
    resp = client.post(
        "/api/datasets",
        json={"name": "Probe", "schema": {"fields": fields or []}, **extra},
    )
    assert resp.status_code == 201
    return resp.json()["id"]


def test_dataset_text_round_trips_as_raw_string(client):
    """User content is stored and returned verbatim; the web client renders it as text.

    Ported from the old HTML-escaping test: escaping is the client's job now (the Svelte UI
    never uses {@html} on dataset names, descriptions or values), so the API must not mangle
    it. frontend/notes check: the payload is shown as literal text and never executes.
    """
    payload = "</script><script>alert(1)</script>"
    dataset_id = _mk(client, [{"name": "note", "type": "text"}], description=payload)
    client.post(f"/api/datasets/{dataset_id}/points", json={"values": {"note": payload}})

    body = client.get(f"/api/datasets/{dataset_id}").json()
    assert body["description"] == payload
    assert body["data_points"][0]["values"]["note"] == payload
    assert body["data_points"][0]["source"] is None


def test_update_dataset_clears_description_and_procedure(client):
    proc_id = client.post("/api/procedures", json={"name": "QC"}).json()["id"]
    dataset_id = _mk(client, description="x", procedure_id=proc_id)
    assert client.get(f"/api/datasets/{dataset_id}").json()["procedure_name"] == "QC"

    resp = client.patch(
        f"/api/datasets/{dataset_id}", json={"description": None, "procedure_id": None}
    )
    assert resp.status_code == 200
    got = client.get(f"/api/datasets/{dataset_id}").json()
    assert got["description"] is None
    assert got["procedure_id"] is None
    assert got["procedure_name"] is None
    assert got["name"] == "Probe"  # not sent, untouched


def test_data_point_values_validated_against_schema(client):
    dataset_id = _mk(
        client,
        [{"name": "temp", "type": "number"}, {"name": "ok", "type": "boolean"}],
    )
    url = f"/api/datasets/{dataset_id}/points"
    assert client.post(url, json={"values": {"temp": "hot"}}).status_code == 422
    assert client.post(url, json={"values": {"nope": 1}}).status_code == 422
    assert client.post(url, json={"values": {"ok": "yes"}}).status_code == 422
    assert client.post(url, json={"values": {"temp": 1.5, "ok": True}}).status_code == 201


def test_data_point_source_resolves_execution_step(client, db_session):
    proc_id = client.post("/api/procedures", json={"name": "Hot fire"}).json()["id"]
    client.post(f"/api/procedures/{proc_id}/steps", json={"title": "Read chamber pressure"})
    client.post(f"/api/procedures/{proc_id}/publish")
    inst = client.post("/api/procedure-instances", json={"procedure_id": proc_id}).json()
    step = db_session.query(StepExecution).filter_by(instance_id=inst["id"]).first()

    dataset_id = _mk(client, [{"name": "p", "type": "number"}])
    resp = client.post(
        f"/api/datasets/{dataset_id}/points",
        json={"values": {"p": 3}, "step_execution_id": step.id},
    )
    assert resp.status_code == 201
    source = resp.json()["source"]
    assert source["instance_id"] == inst["id"]
    assert source["work_order_number"] == inst["work_order_number"]
    assert source["step_title"] == "Read chamber pressure"

    missing = client.post(
        f"/api/datasets/{dataset_id}/points", json={"values": {}, "step_execution_id": 99999}
    )
    assert missing.status_code == 422


def test_data_point_changes_are_audited(client, db_session):
    dataset_id = _mk(client, [{"name": "p", "type": "number"}])
    point = client.post(f"/api/datasets/{dataset_id}/points", json={"values": {"p": 1}}).json()
    client.delete(f"/api/datasets/{dataset_id}/points/{point['id']}")
    rows = db_session.query(AuditLog).filter_by(table_name="data_point").all()
    assert len(rows) == 2


def test_csv_export_timestamps_are_iso_utc(client):
    dataset_id = _mk(client, [{"name": "p", "type": "number"}])
    client.post(
        f"/api/datasets/{dataset_id}/points",
        json={"values": {"p": 5}, "recorded_at": "2026-10-22T22:38:32Z"},
    )
    rows = client.get(f"/api/datasets/{dataset_id}/export").text.splitlines()
    assert rows[0] == "recorded_at,p"
    assert rows[1] == "2026-10-22T22:38:32Z,5"
