"""Label print route tests, including the DYMO LabelManager 280 format."""

from fastapi.testclient import TestClient

from opal.core import printing


def _activated_part(client: TestClient, tracking_type: str = "serialized") -> dict:
    resp = client.post(
        "/api/parts",
        json={"name": "Bracket Assy", "tier": 1, "tracking_type": tracking_type},
    )
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


def test_part_label_dymo_has_pn_name_and_datamatrix_no_meta_line(web_client, client):
    part = _activated_part(client)
    page = web_client.get(f"/label?type=part&id={part['id']}&fmt=dymo")
    assert page.status_code == 200
    assert part["internal_pn"] in page.text
    assert "Bracket Assy" in page.text
    assert f"/api/parts/{part['id']}/datamatrix" in page.text
    # QR and 1D barcode were both tried and failed on hardware (QR:
    # unscannable at ~1.5px/module; 1D bars: bled together at print
    # resolution) — Data Matrix needs far fewer modules per side for a
    # short identifier and is what actually scanned
    assert "/qrcode" not in page.text
    assert "/barcode" not in page.text
    # A catalog part has no serial/lot/qty yet — no meta line
    assert 'class="dymo-meta"' not in page.text
    # Sized for D1 tape (max 12mm / 1/2in on the LabelManager 280), rotated
    # to read correctly along the driver's native portrait canvas; short
    # content gets the shorter of the two validated page presets so it
    # doesn't feed blank tape past the label
    assert "size: 0.4861in 2.0in" in page.text
    assert "rotate(-90deg)" in page.text


def test_inventory_label_dymo_has_lot_opal_number_and_qty(web_client, client):
    part = _activated_part(client, tracking_type="bulk")
    record = _inventory_record(client, part)
    page = web_client.get(f"/label?type=inventory&id={record['id']}&fmt=dymo")
    assert page.status_code == 200
    assert part["internal_pn"] in page.text
    assert record["opal_number"] in page.text
    assert "QTY: 5" in page.text
    assert f"/api/inventory/{record['id']}/datamatrix" in page.text
    assert "/qrcode" not in page.text
    assert "/barcode" not in page.text
    # The 3-line meta (lot/opal#/qty) pushes this past the short preset
    assert "size: 0.4861in 3.5in" in page.text


def test_part_datamatrix_svg(web_client, client):
    part = _activated_part(client)
    resp = web_client.get(f"/api/parts/{part['id']}/datamatrix")
    assert resp.status_code == 200
    assert resp.headers["content-type"] == "image/svg+xml"
    assert b"<svg" in resp.content


def test_inventory_datamatrix_svg(web_client, client):
    part = _activated_part(client, tracking_type="bulk")
    record = _inventory_record(client, part)
    resp = web_client.get(f"/api/inventory/{record['id']}/datamatrix")
    assert resp.status_code == 200
    assert resp.headers["content-type"] == "image/svg+xml"
    assert b"<svg" in resp.content


def test_label_printers_lists_available(web_client, monkeypatch):
    monkeypatch.setattr(
        printing, "list_printers", lambda: [{"name": "DYMO_LabelManager_280", "status": "idle"}]
    )
    resp = web_client.get("/label/printers")
    assert resp.status_code == 200
    assert resp.json() == [{"name": "DYMO_LabelManager_280", "status": "idle"}]


def test_label_printers_error_is_502(web_client, monkeypatch):
    def _raise():
        raise printing.PrinterError("cups not running")

    monkeypatch.setattr(printing, "list_printers", _raise)
    resp = web_client.get("/label/printers")
    assert resp.status_code == 502


def test_label_print_direct_dispatches_to_printer(web_client, client, monkeypatch):
    part = _activated_part(client)
    sent = {}

    def _fake_print_file(printer, pdf_bytes):
        sent["printer"] = printer
        sent["pdf_bytes"] = pdf_bytes

    monkeypatch.setattr(printing, "print_file", _fake_print_file)
    resp = web_client.post(
        "/label/print-direct",
        data={"type": "part", "id": part["id"], "printer": "DYMO_LabelManager_280"},
    )
    assert resp.status_code == 200
    assert resp.json() == {"printer": "DYMO_LabelManager_280"}
    assert sent["printer"] == "DYMO_LabelManager_280"
    assert sent["pdf_bytes"].startswith(b"%PDF")


def test_label_print_direct_not_found(web_client, monkeypatch):
    monkeypatch.setattr(printing, "print_file", lambda printer, pdf_bytes: None)
    resp = web_client.post(
        "/label/print-direct",
        data={"type": "part", "id": 999999, "printer": "DYMO_LabelManager_280"},
    )
    assert resp.status_code == 404


def test_label_print_direct_printer_error_is_502(web_client, client, monkeypatch):
    part = _activated_part(client)

    def _raise(printer, pdf_bytes):
        raise printing.PrinterError("printer-stopped")

    monkeypatch.setattr(printing, "print_file", _raise)
    resp = web_client.post(
        "/label/print-direct",
        data={"type": "part", "id": part["id"], "printer": "DYMO_LabelManager_280"},
    )
    assert resp.status_code == 502


def test_label_invalid_type_rejected(web_client):
    page = web_client.get("/label?type=bogus&id=1")
    assert page.status_code == 400


def test_label_not_found(web_client):
    page = web_client.get("/label?type=part&id=999999")
    assert page.status_code == 404
