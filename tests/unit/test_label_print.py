"""Label print route tests, including the DYMO LabelManager 280 format."""

from fastapi.testclient import TestClient


def _activated_part(client: TestClient) -> dict:
    resp = client.post("/api/parts", json={"name": "Bracket Assy", "tier": 1})
    assert resp.status_code == 201
    part = resp.json()
    client.post(f"/api/parts/{part['id']}/activate", json={})
    return part


def _inventory_record(client: TestClient, part: dict) -> dict:
    resp = client.post(
        "/api/inventory",
        json={"part_id": part["id"], "quantity": 5, "location": "Shelf A"},
    )
    assert resp.status_code == 201
    return resp.json()["items"][0]


def test_part_label_default_renders_tag_with_qr(web_client, client):
    part = _activated_part(client)
    page = web_client.get(f"/label?type=part&id={part['id']}")
    assert page.status_code == 200
    assert "part-tag" in page.text
    assert "/qrcode" in page.text
    assert part["internal_pn"] in page.text


def test_part_label_dymo_is_compact_text_only(web_client, client):
    part = _activated_part(client)
    page = web_client.get(f"/label?type=part&id={part['id']}&fmt=dymo")
    assert page.status_code == 200
    assert part["internal_pn"] in page.text
    assert "Bracket Assy" in page.text
    # No QR — illegible at 12mm/180dpi, so the dymo format drops it
    assert "/qrcode" not in page.text
    # Sized for D1 tape (max 12mm / 1/2in on the LabelManager 280)
    assert "size: 2in 0.5in" in page.text


def test_inventory_label_dymo_includes_location(web_client, client):
    part = _activated_part(client)
    record = _inventory_record(client, part)
    page = web_client.get(f"/label?type=inventory&id={record['id']}&fmt=dymo")
    assert page.status_code == 200
    assert record["opal_number"] in page.text
    assert "Shelf A" in page.text
    assert "/qrcode" not in page.text


def test_label_invalid_type_rejected(web_client):
    page = web_client.get("/label?type=bogus&id=1")
    assert page.status_code == 400


def test_label_not_found(web_client):
    page = web_client.get("/label?type=part&id=999999")
    assert page.status_code == 404
