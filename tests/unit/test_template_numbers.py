"""T-XXXX template numbers."""

import pytest

from tests.conftest import grant_client_roles


@pytest.fixture(autouse=True)
def _template_roles(client, db_session):
    grant_client_roles(db_session, "TC", "QE", "MFG-LEAD")


def _create(client, name="Template") -> dict:
    resp = client.post("/api/procedures", json={"name": name})
    assert resp.status_code == 201, resp.text
    return resp.json()


def test_create_assigns_sequential_numbers(client):
    assert _create(client, "A")["template_number"] == "T-0001"
    assert _create(client, "B")["template_number"] == "T-0002"


def test_clone_gets_new_number(client):
    src = _create(client)
    clone = client.post(f"/api/procedures/{src['id']}/clone", json={}).json()
    assert clone["template_number"] == "T-0002"
    assert client.get(f"/api/procedures/{src['id']}").json()["template_number"] == "T-0001"


def test_soft_delete_keeps_number_reserved(client):
    first = _create(client, "A")
    assert client.delete(f"/api/procedures/{first['id']}").status_code == 204
    assert _create(client, "B")["template_number"] == "T-0002"


def test_list_search_by_number(client):
    _create(client, "Alpha")
    _create(client, "Beta")
    body = client.get("/api/procedures", params={"search": "T-0002"}).json()
    assert [i["name"] for i in body["items"]] == ["Beta"]
    assert body["items"][0]["template_number"] == "T-0002"


def test_detail_exposes_number(client):
    proc = _create(client)
    assert client.get(f"/api/procedures/{proc['id']}").json()["template_number"] == "T-0001"


def test_instance_list_and_document_expose_number(client):
    proc = _create(client)
    client.post(f"/api/procedures/{proc['id']}/steps", json={"title": "S"})
    client.post(f"/api/procedures/{proc['id']}/publish")
    inst = client.post("/api/procedure-instances", json={"procedure_id": proc["id"]})
    assert inst.status_code == 201, inst.text
    assert inst.json()["procedure_template_number"] == "T-0001"
    rows = client.get("/api/procedure-instances").json()["items"]
    assert rows[0]["procedure_template_number"] == "T-0001"
    doc = client.get(f"/api/procedure-instances/{inst.json()['id']}/document").json()
    assert doc["instance"]["procedure"]["template_number"] == "T-0001"
