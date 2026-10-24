"""Purchase order lifecycle, lines, receiving, charges, attachments; supplier rules."""

from fastapi.testclient import TestClient


def _part(client: TestClient, name: str = "PO Part", tier: int = 3, tracking: str = "bulk") -> dict:
    resp = client.post("/api/parts", json={"name": name, "tier": tier, "tracking_type": tracking})
    assert resp.status_code == 201, resp.text
    part = resp.json()
    client.post(f"/api/parts/{part['id']}/activate", json={"cause": "test setup"})
    return part


def _supplier(client: TestClient, name: str = "Acme") -> dict:
    resp = client.post("/api/suppliers", json={"name": name})
    assert resp.status_code == 201, resp.text
    return resp.json()


def _po(client: TestClient, lines: list[dict] | None = None, **kwargs: object) -> dict:
    body = {"supplier": "Acme", **kwargs, "lines": lines or []}
    resp = client.post("/api/purchases", json=body)
    assert resp.status_code == 201, resp.text
    return resp.json()


def _set_status(client: TestClient, po_id: int, status: str):
    return client.patch(f"/api/purchases/{po_id}", json={"status": status})


# ---- Creation ----


def test_reference_auto_generated_and_sequential(client: TestClient) -> None:
    a = _po(client)
    b = _po(client)
    assert a["reference"] == "PO-0001"
    assert b["reference"] == "PO-0002"


def test_create_with_supplier_id_takes_name(client: TestClient) -> None:
    sup = _supplier(client, "Registered Co")
    resp = client.post("/api/purchases", json={"supplier_id": sup["id"]})
    assert resp.status_code == 201
    assert resp.json()["supplier"] == "Registered Co"
    assert resp.json()["supplier_name"] == "Registered Co"


def test_create_requires_some_supplier(client: TestClient) -> None:
    assert client.post("/api/purchases", json={}).status_code == 422


def test_duplicate_reference_rejected_on_create_and_update(client: TestClient) -> None:
    _po(client, reference="PO-X")
    assert (
        client.post("/api/purchases", json={"supplier": "A", "reference": "PO-X"}).status_code
        == 409
    )
    other = _po(client)
    resp = client.patch(f"/api/purchases/{other['id']}", json={"reference": "PO-X"})
    assert resp.status_code == 409


# ---- Lifecycle ----


def test_place_order_needs_a_line(client: TestClient) -> None:
    po = _po(client)
    assert _set_status(client, po["id"], "ordered").status_code == 400


def test_lifecycle_transitions(client: TestClient) -> None:
    part = _part(client)
    po = _po(client, [{"part_id": part["id"], "qty_ordered": 2}])
    resp = _set_status(client, po["id"], "ordered")
    assert resp.status_code == 200
    assert resp.json()["ordered_at"] is not None
    assert _set_status(client, po["id"], "on_hold").json()["status"] == "on_hold"
    assert _set_status(client, po["id"], "ordered").json()["status"] == "ordered"
    back = _set_status(client, po["id"], "draft").json()
    assert back["status"] == "draft"
    assert back["ordered_at"] is None
    assert _set_status(client, po["id"], "cancelled").json()["status"] == "cancelled"
    # Cancelled is terminal
    assert _set_status(client, po["id"], "ordered").status_code == 409


def test_status_cannot_be_set_to_received_by_hand(client: TestClient) -> None:
    part = _part(client)
    po = _po(client, [{"part_id": part["id"], "qty_ordered": 1}])
    _set_status(client, po["id"], "ordered")
    assert _set_status(client, po["id"], "received").status_code == 409
    assert _set_status(client, po["id"], "partial").status_code == 409


def test_closed_order_only_notes_editable(client: TestClient) -> None:
    po = _po(client)
    _set_status(client, po["id"], "cancelled")
    assert client.patch(f"/api/purchases/{po['id']}", json={"notes": "why"}).status_code == 200
    assert client.patch(f"/api/purchases/{po['id']}", json={"destination": "X"}).status_code == 409


# ---- Lines ----


def test_line_add_edit_remove_rules(client: TestClient) -> None:
    part = _part(client)
    po = _po(client)
    line = client.post(
        f"/api/purchases/{po['id']}/lines",
        json={"part_id": part["id"], "qty_ordered": 5, "unit_cost": "2", "destination": "Bin 4"},
    ).json()
    assert line["destination"] == "Bin 4"
    assert line["part_internal_pn"] == part["internal_pn"]

    upd = client.patch(f"/api/purchases/{po['id']}/lines/{line['id']}", json={"qty_ordered": 8})
    assert upd.status_code == 200
    assert float(upd.json()["qty_ordered"]) == 8

    assert (
        client.post(
            f"/api/purchases/{po['id']}/lines", json={"part_id": part["id"], "qty_ordered": 0}
        ).status_code
        == 422
    )

    assert client.delete(f"/api/purchases/{po['id']}/lines/{line['id']}").status_code == 204
    assert client.get(f"/api/purchases/{po['id']}").json()["lines"] == []


def test_line_edit_blocked_below_received_and_cost_locked(client: TestClient) -> None:
    part = _part(client)
    po = _po(client, [{"part_id": part["id"], "qty_ordered": 10, "unit_cost": "1"}])
    line_id = po["lines"][0]["id"]
    _set_status(client, po["id"], "ordered")
    client.post(
        f"/api/purchases/{po['id']}/receive",
        json={"lines": [{"line_id": line_id, "qty_received": 4, "location": "A"}]},
    )
    base = f"/api/purchases/{po['id']}/lines/{line_id}"
    assert client.patch(base, json={"qty_ordered": 3}).status_code == 400
    assert client.patch(base, json={"unit_cost": "9"}).status_code == 400
    assert client.delete(base).status_code == 400
    # Lowering the order to what already arrived completes the PO
    assert client.patch(base, json={"qty_ordered": 4}).status_code == 200
    assert client.get(f"/api/purchases/{po['id']}").json()["status"] == "received"


def test_cannot_edit_lines_of_closed_order(client: TestClient) -> None:
    part = _part(client)
    po = _po(client, [{"part_id": part["id"], "qty_ordered": 1}])
    _set_status(client, po["id"], "cancelled")
    assert (
        client.post(
            f"/api/purchases/{po['id']}/lines", json={"part_id": part["id"], "qty_ordered": 1}
        ).status_code
        == 400
    )


# ---- Receiving ----


def test_receive_location_fallback_received_by_and_inventory_links(client: TestClient) -> None:
    part = _part(client, "Receivable")
    po = _po(
        client,
        [{"part_id": part["id"], "qty_ordered": 3, "unit_cost": "1.50"}],
        destination="Dock",
    )
    _set_status(client, po["id"], "ordered")
    line_id = po["lines"][0]["id"]

    # No location given: falls back to the PO destination
    resp = client.post(
        f"/api/purchases/{po['id']}/receive",
        json={"lines": [{"line_id": line_id, "qty_received": 3, "lot_number": "L1"}]},
    )
    assert resp.status_code == 200, resp.text
    done = resp.json()
    assert done["status"] == "received"
    assert done["received_by_id"] is not None

    records = client.get(f"/api/purchases/{po['id']}/inventory").json()
    assert len(records) == 1
    assert records[0]["location"] == "Dock"
    assert records[0]["lot_number"] == "L1"
    assert records[0]["opal_number"]
    assert records[0]["purchase_line_id"] == line_id


def test_receive_without_any_location_is_rejected(client: TestClient) -> None:
    part = _part(client)
    po = _po(client, [{"part_id": part["id"], "qty_ordered": 1}])
    _set_status(client, po["id"], "ordered")
    resp = client.post(
        f"/api/purchases/{po['id']}/receive",
        json={"lines": [{"line_id": po["lines"][0]["id"], "qty_received": 1}]},
    )
    assert resp.status_code == 422


def test_receive_serialized_requires_whole_units_and_one_record_each(client: TestClient) -> None:
    part = _part(client, "Serial Thing", tier=3, tracking="serialized")
    po = _po(client, [{"part_id": part["id"], "qty_ordered": 3}])
    _set_status(client, po["id"], "ordered")
    line_id = po["lines"][0]["id"]
    bad = client.post(
        f"/api/purchases/{po['id']}/receive",
        json={"lines": [{"line_id": line_id, "qty_received": 1.5, "location": "A"}]},
    )
    assert bad.status_code == 400
    ok = client.post(
        f"/api/purchases/{po['id']}/receive",
        json={"lines": [{"line_id": line_id, "qty_received": 2, "location": "A"}]},
    )
    assert ok.status_code == 200
    assert ok.json()["status"] == "partial"
    assert len(client.get(f"/api/purchases/{po['id']}/inventory").json()) == 2


def test_receive_flags_lot_requirement_per_line(client: TestClient) -> None:
    part = _part(client, "Lot Part", tier=2, tracking="bulk")
    po = _po(client, [{"part_id": part["id"], "qty_ordered": 1}])
    assert po["lines"][0]["tracking_type"] == "bulk"
    assert "lot_required" in po["lines"][0]


def test_on_hold_blocks_receiving_and_resume_restores_partial(client: TestClient) -> None:
    part = _part(client)
    po = _po(client, [{"part_id": part["id"], "qty_ordered": 4}])
    line_id = po["lines"][0]["id"]
    _set_status(client, po["id"], "ordered")
    client.post(
        f"/api/purchases/{po['id']}/receive",
        json={"lines": [{"line_id": line_id, "qty_received": 1, "location": "A"}]},
    )
    assert _set_status(client, po["id"], "on_hold").status_code == 200
    blocked = client.post(
        f"/api/purchases/{po['id']}/receive",
        json={"lines": [{"line_id": line_id, "qty_received": 1, "location": "A"}]},
    )
    assert blocked.status_code == 400
    assert _set_status(client, po["id"], "ordered").json()["status"] == "partial"


# ---- Charges ----


def test_charges_add_list_remove(client: TestClient) -> None:
    po = _po(client)
    resp = client.post(
        f"/api/purchases/{po['id']}/expenses",
        json={"kind": "shipping", "amount": "12.30", "note": "Carrier invoice"},
    )
    assert resp.status_code == 201, resp.text
    charge = resp.json()
    assert charge["charge_kind"] == "shipping"
    assert float(charge["total_cost"]) == 12.30
    assert charge["part_id"] is None

    listed = client.get(f"/api/purchases/{po['id']}/expenses").json()
    assert [e["charge_kind"] for e in listed] == ["shipping"]

    assert (
        client.post(
            f"/api/purchases/{po['id']}/expenses", json={"kind": "bribe", "amount": "1"}
        ).status_code
        == 422
    )
    assert client.delete(f"/api/purchases/{po['id']}/expenses/{charge['id']}").status_code == 204
    assert client.get(f"/api/purchases/{po['id']}/expenses").json() == []


def test_receive_records_cannot_be_removed(client: TestClient) -> None:
    part = _part(client)
    po = _po(client, [{"part_id": part["id"], "qty_ordered": 1, "unit_cost": "3"}])
    _set_status(client, po["id"], "ordered")
    client.post(
        f"/api/purchases/{po['id']}/receive",
        json={"lines": [{"line_id": po["lines"][0]["id"], "qty_received": 1, "location": "A"}]},
    )
    ledger = client.get(f"/api/purchases/{po['id']}/expenses").json()
    resp = client.delete(f"/api/purchases/{po['id']}/expenses/{ledger[0]['id']}")
    assert resp.status_code == 409


# ---- List ----


def test_list_filters_and_sort(client: TestClient) -> None:
    sup = _supplier(client, "Filter Supplier")
    part = _part(client)
    a = _po(client, [{"part_id": part["id"], "qty_ordered": 1}], supplier_id=sup["id"])
    b = _po(client, supplier="Other Vendor", target_date="2020-01-01")
    _set_status(client, a["id"], "ordered")

    by_supplier = client.get("/api/purchases", params={"supplier_id": sup["id"]}).json()
    assert [p["id"] for p in by_supplier["items"]] == [a["id"]]
    assert by_supplier["items"][0]["supplier_id"] == sup["id"]

    assert client.get("/api/purchases", params={"status": "ordered"}).json()["total"] == 1
    assert client.get("/api/purchases", params={"open": "true"}).json()["total"] == 2
    awaiting = client.get("/api/purchases", params={"awaiting": "true"}).json()
    assert [p["id"] for p in awaiting["items"]] == [a["id"]]
    overdue = client.get("/api/purchases", params={"overdue": "true"}).json()
    assert [p["id"] for p in overdue["items"]] == [b["id"]]
    assert client.get("/api/purchases", params={"q": "other"}).json()["total"] == 1
    assert client.get("/api/purchases", params={"target_to": "2021-01-01"}).json()["total"] == 1

    asc = client.get("/api/purchases", params={"sort": "reference", "dir": "asc"}).json()
    assert [p["id"] for p in asc["items"]] == [a["id"], b["id"]]
    assert client.get("/api/purchases", params={"sort": "nope"}).status_code == 400


# ---- Attachments ----


def test_purchase_attachment_upload_list_delete(client: TestClient) -> None:
    po = _po(client)
    up = client.post(
        "/api/attachments/upload",
        data={"purchase_id": str(po["id"]), "kind": "quote"},
        files={"file": ("quote.pdf", b"%PDF-1.4 test", "application/pdf")},
    )
    assert up.status_code == 201, up.text
    att = up.json()
    assert att["purchase_id"] == po["id"]
    assert att["kind"] == "quote"

    listed = client.get("/api/attachments", params={"purchase_id": po["id"]}).json()
    assert [a["id"] for a in listed] == [att["id"]]
    assert client.delete(f"/api/attachments/{att['id']}").status_code == 204

    missing = client.post(
        "/api/attachments/upload",
        data={"purchase_id": "99999"},
        files={"file": ("q.pdf", b"x", "application/pdf")},
    )
    assert missing.status_code == 404


# ---- Suppliers ----


def test_supplier_website_must_be_http_with_host(client: TestClient) -> None:
    for bad in ("javascript:alert(1)", "ftp://x.com", "http://", "example.com"):
        resp = client.post("/api/suppliers", json={"name": "W", "website": bad})
        assert resp.status_code == 422, bad
    ok = client.post("/api/suppliers", json={"name": "W", "website": "https://example.com/x"})
    assert ok.status_code == 201


def test_supplier_update_null_name_is_ignored(client: TestClient) -> None:
    sup = _supplier(client, "Keep Me")
    resp = client.patch(f"/api/suppliers/{sup['id']}", json={"name": None, "is_active": None})
    assert resp.status_code == 200
    assert resp.json()["name"] == "Keep Me"
    assert resp.json()["is_active"] is True


def test_supplier_counts_and_sort(client: TestClient) -> None:
    b = _supplier(client, "Bravo")
    _supplier(client, "Alpha")
    part = _part(client)
    client.post(f"/api/suppliers/{b['id']}/parts", json={"part_id": part["id"], "vendor_pn": "B-1"})
    _po(client, supplier_id=b["id"])
    items = client.get("/api/suppliers", params={"sort": "name", "dir": "desc"}).json()["items"]
    assert [s["name"] for s in items][:2] == ["Bravo", "Alpha"]
    assert items[0]["purchase_count"] == 1
    assert items[0]["part_count"] == 1


def test_supplier_part_last_unit_cost_from_latest_po(client: TestClient) -> None:
    sup = _supplier(client, "Costly")
    part = _part(client)
    entry = client.post(
        f"/api/suppliers/{sup['id']}/parts", json={"part_id": part["id"], "vendor_pn": "C-1"}
    ).json()
    assert entry["last_unit_cost"] is None
    _po(
        client,
        [{"part_id": part["id"], "qty_ordered": 1, "unit_cost": "4.25"}],
        supplier_id=sup["id"],
    )
    listed = client.get(f"/api/suppliers/{sup['id']}/parts").json()
    assert float(listed[0]["last_unit_cost"]) == 4.25
    assert listed[0]["part_internal_pn"] == part["internal_pn"]
