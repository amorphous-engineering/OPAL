"""Inventory API tests."""

import pytest
from fastapi.testclient import TestClient

# ---- Local fixtures ----


@pytest.fixture
def bulk_part(client: TestClient) -> dict:
    """Create a BULK-tracked part."""
    resp = client.post(
        "/api/parts",
        json={"name": "Fasteners M3", "tracking_type": "bulk", "category": "Fasteners"},
    )
    assert resp.status_code == 201
    part = resp.json()
    client.post(f"/api/parts/{part['id']}/activate", json={"cause": "test setup"})
    return part


@pytest.fixture
def serialized_part(client: TestClient) -> dict:
    """Create a SERIALIZED-tracked part (default)."""
    resp = client.post(
        "/api/parts",
        json={"name": "PCB Rev C", "tracking_type": "serialized", "category": "Electronics"},
    )
    assert resp.status_code == 201
    part = resp.json()
    client.post(f"/api/parts/{part['id']}/activate", json={"cause": "test setup"})
    return part


@pytest.fixture
def tooling_part(client: TestClient) -> dict:
    """Create a tooling part with calibration interval."""
    resp = client.post(
        "/api/parts",
        json={
            "name": "Torque Wrench",
            "is_tooling": True,
            "calibration_interval_days": 365,
            "category": "Tooling",
        },
    )
    assert resp.status_code == 201
    part = resp.json()
    client.post(f"/api/parts/{part['id']}/activate", json={"cause": "test setup"})
    return part


# ============ CRUD ============


def test_create_bulk_inventory(client: TestClient, auth_headers: dict, bulk_part: dict) -> None:
    resp = client.post(
        "/api/inventory",
        json={"part_id": bulk_part["id"], "quantity": 10, "location": "Shelf A"},
        headers=auth_headers,
    )
    assert resp.status_code == 201
    data = resp.json()
    assert data["total_created"] == 1
    assert len(data["items"]) == 1
    assert float(data["items"][0]["quantity"]) == 10
    assert data["items"][0]["opal_number"] is not None


def test_create_serialized_inventory(
    client: TestClient, auth_headers: dict, serialized_part: dict
) -> None:
    resp = client.post(
        "/api/inventory",
        json={"part_id": serialized_part["id"], "quantity": 3, "location": "Bin B"},
        headers=auth_headers,
    )
    assert resp.status_code == 201
    data = resp.json()
    assert data["total_created"] == 3
    assert len(data["items"]) == 3
    opal_numbers = {item["opal_number"] for item in data["items"]}
    assert len(opal_numbers) == 3  # All unique
    for item in data["items"]:
        assert float(item["quantity"]) == 1


def test_create_inventory_not_found_part(client: TestClient, auth_headers: dict) -> None:
    resp = client.post(
        "/api/inventory",
        json={"part_id": 99999, "quantity": 1, "location": "X"},
        headers=auth_headers,
    )
    assert resp.status_code == 404


def test_list_inventory(client: TestClient, auth_headers: dict, bulk_part: dict) -> None:
    client.post(
        "/api/inventory",
        json={"part_id": bulk_part["id"], "quantity": 5, "location": "Shelf A"},
        headers=auth_headers,
    )
    resp = client.get("/api/inventory")
    assert resp.status_code == 200
    data = resp.json()
    assert data["total"] >= 1
    assert len(data["items"]) >= 1


def test_list_inventory_filter_by_part(
    client: TestClient, auth_headers: dict, bulk_part: dict, serialized_part: dict
) -> None:
    client.post(
        "/api/inventory",
        json={"part_id": bulk_part["id"], "quantity": 5, "location": "A"},
        headers=auth_headers,
    )
    client.post(
        "/api/inventory",
        json={"part_id": serialized_part["id"], "quantity": 1, "location": "B"},
        headers=auth_headers,
    )
    resp = client.get(f"/api/inventory?part_id={bulk_part['id']}")
    assert resp.status_code == 200
    data = resp.json()
    for item in data["items"]:
        assert item["part_id"] == bulk_part["id"]


def test_list_inventory_filter_by_location(
    client: TestClient, auth_headers: dict, bulk_part: dict
) -> None:
    client.post(
        "/api/inventory",
        json={"part_id": bulk_part["id"], "quantity": 5, "location": "UNIQUE-LOC"},
        headers=auth_headers,
    )
    resp = client.get("/api/inventory?location=UNIQUE-LOC")
    assert resp.status_code == 200
    data = resp.json()
    assert data["total"] >= 1
    for item in data["items"]:
        assert item["location"] == "UNIQUE-LOC"


def test_get_inventory(client: TestClient, auth_headers: dict, bulk_part: dict) -> None:
    create_resp = client.post(
        "/api/inventory",
        json={"part_id": bulk_part["id"], "quantity": 5, "location": "Shelf A"},
        headers=auth_headers,
    )
    inv_id = create_resp.json()["items"][0]["id"]

    resp = client.get(f"/api/inventory/{inv_id}")
    assert resp.status_code == 200
    assert resp.json()["id"] == inv_id


def test_get_inventory_not_found(client: TestClient) -> None:
    resp = client.get("/api/inventory/99999")
    assert resp.status_code == 404


def test_update_inventory(client: TestClient, auth_headers: dict, bulk_part: dict) -> None:
    create_resp = client.post(
        "/api/inventory",
        json={"part_id": bulk_part["id"], "quantity": 5, "location": "Shelf A"},
        headers=auth_headers,
    )
    inv_id = create_resp.json()["items"][0]["id"]

    # PATCH may update metadata (location) but must NOT change quantity: stock
    # is traceable and only /adjust and /count may move it (with a ledger row).
    # A quantity in the body is ignored, not applied.
    resp = client.patch(
        f"/api/inventory/{inv_id}",
        json={"location": "Shelf B", "quantity": 8},
        headers=auth_headers,
    )
    assert resp.status_code == 200
    assert resp.json()["location"] == "Shelf B"
    assert float(resp.json()["quantity"]) == 5  # unchanged — ledger bypass closed


def test_delete_inventory(client: TestClient, auth_headers: dict, bulk_part: dict) -> None:
    create_resp = client.post(
        "/api/inventory",
        json={"part_id": bulk_part["id"], "quantity": 5, "location": "Shelf A"},
        headers=auth_headers,
    )
    inv_id = create_resp.json()["items"][0]["id"]

    resp = client.delete(f"/api/inventory/{inv_id}", headers=auth_headers)
    assert resp.status_code == 204

    # Verify it's gone
    assert client.get(f"/api/inventory/{inv_id}").status_code == 404


# ============ Operations ============


def test_adjust_quantity_found(client: TestClient, auth_headers: dict, bulk_part: dict) -> None:
    create_resp = client.post(
        "/api/inventory",
        json={"part_id": bulk_part["id"], "quantity": 10, "location": "A"},
        headers=auth_headers,
    )
    inv_id = create_resp.json()["items"][0]["id"]

    resp = client.post(
        f"/api/inventory/{inv_id}/adjust",
        json={"adjustment": 5, "reason": "found"},
        headers=auth_headers,
    )
    assert resp.status_code == 200
    assert float(resp.json()["quantity"]) == 15


def test_adjust_quantity_damage(client: TestClient, auth_headers: dict, bulk_part: dict) -> None:
    create_resp = client.post(
        "/api/inventory",
        json={"part_id": bulk_part["id"], "quantity": 10, "location": "A"},
        headers=auth_headers,
    )
    inv_id = create_resp.json()["items"][0]["id"]

    resp = client.post(
        f"/api/inventory/{inv_id}/adjust",
        json={"adjustment": -3, "reason": "damage"},
        headers=auth_headers,
    )
    assert resp.status_code == 200
    assert float(resp.json()["quantity"]) == 7


def test_adjust_quantity_prevents_negative(
    client: TestClient, auth_headers: dict, bulk_part: dict
) -> None:
    create_resp = client.post(
        "/api/inventory",
        json={"part_id": bulk_part["id"], "quantity": 5, "location": "A"},
        headers=auth_headers,
    )
    inv_id = create_resp.json()["items"][0]["id"]

    resp = client.post(
        f"/api/inventory/{inv_id}/adjust",
        json={"adjustment": -10, "reason": "damage"},
        headers=auth_headers,
    )
    assert resp.status_code == 400


def test_physical_count(client: TestClient, auth_headers: dict, bulk_part: dict) -> None:
    create_resp = client.post(
        "/api/inventory",
        json={"part_id": bulk_part["id"], "quantity": 10, "location": "A"},
        headers=auth_headers,
    )
    inv_id = create_resp.json()["items"][0]["id"]

    resp = client.post(
        f"/api/inventory/{inv_id}/count",
        json={"counted_quantity": 8},
        headers=auth_headers,
    )
    assert resp.status_code == 200
    assert float(resp.json()["quantity"]) == 8
    assert resp.json()["last_counted_at"] is not None


def test_calibrate_tooling(client: TestClient, auth_headers: dict, tooling_part: dict) -> None:
    create_resp = client.post(
        "/api/inventory",
        json={"part_id": tooling_part["id"], "quantity": 1, "location": "Tool Crib"},
        headers=auth_headers,
    )
    inv_id = create_resp.json()["items"][0]["id"]

    resp = client.post(
        f"/api/inventory/{inv_id}/calibrate",
        headers=auth_headers,
    )
    assert resp.status_code == 200
    assert resp.json()["last_calibrated_at"] is not None
    assert resp.json()["calibration_due_at"] is not None


def test_calibrate_non_tooling_fails(
    client: TestClient, auth_headers: dict, bulk_part: dict
) -> None:
    create_resp = client.post(
        "/api/inventory",
        json={"part_id": bulk_part["id"], "quantity": 5, "location": "A"},
        headers=auth_headers,
    )
    inv_id = create_resp.json()["items"][0]["id"]

    resp = client.post(
        f"/api/inventory/{inv_id}/calibrate",
        headers=auth_headers,
    )
    assert resp.status_code == 400


# ============ OPAL Lookup ============


def test_lookup_by_opal_number(client: TestClient, auth_headers: dict, bulk_part: dict) -> None:
    create_resp = client.post(
        "/api/inventory",
        json={"part_id": bulk_part["id"], "quantity": 5, "location": "A"},
        headers=auth_headers,
    )
    opal_number = create_resp.json()["items"][0]["opal_number"]

    resp = client.get(f"/api/inventory/opal/{opal_number}")
    assert resp.status_code == 200
    assert resp.json()["opal_number"] == opal_number


def test_lookup_by_opal_not_found(client: TestClient) -> None:
    resp = client.get("/api/inventory/opal/OPAL-99999")
    assert resp.status_code == 404


def test_opal_history(client: TestClient, auth_headers: dict, bulk_part: dict) -> None:
    create_resp = client.post(
        "/api/inventory",
        json={"part_id": bulk_part["id"], "quantity": 5, "location": "A"},
        headers=auth_headers,
    )
    opal_number = create_resp.json()["items"][0]["opal_number"]

    resp = client.get(f"/api/inventory/opal/{opal_number}/history")
    assert resp.status_code == 200
    data = resp.json()
    assert data["opal_number"] == opal_number
    assert len(data["history"]) >= 1  # At least the "created" event
    assert data["history"][0]["event_type"] == "created"


# ============ Transfers ============


def test_transfer_stock(client: TestClient, auth_headers: dict, bulk_part: dict) -> None:
    create_resp = client.post(
        "/api/inventory",
        json={"part_id": bulk_part["id"], "quantity": 20, "location": "Warehouse"},
        headers=auth_headers,
    )
    source_id = create_resp.json()["items"][0]["id"]

    resp = client.post(
        "/api/inventory/transfer",
        json={
            "source_inventory_id": source_id,
            "target_location": "Production Floor",
            "quantity": 8,
        },
        headers=auth_headers,
    )
    assert resp.status_code == 201
    data = resp.json()
    assert float(data["quantity"]) == 8
    assert data["source_location"] == "Warehouse"
    assert data["target_location"] == "Production Floor"
    assert data["status"] == "completed"

    # Verify source quantity decreased
    source = client.get(f"/api/inventory/{source_id}").json()
    assert float(source["quantity"]) == 12


def test_transfer_insufficient_quantity(
    client: TestClient, auth_headers: dict, bulk_part: dict
) -> None:
    create_resp = client.post(
        "/api/inventory",
        json={"part_id": bulk_part["id"], "quantity": 5, "location": "Warehouse"},
        headers=auth_headers,
    )
    source_id = create_resp.json()["items"][0]["id"]

    resp = client.post(
        "/api/inventory/transfer",
        json={
            "source_inventory_id": source_id,
            "target_location": "Floor",
            "quantity": 100,
        },
        headers=auth_headers,
    )
    assert resp.status_code == 400


def test_list_transfers(client: TestClient, auth_headers: dict, bulk_part: dict) -> None:
    create_resp = client.post(
        "/api/inventory",
        json={"part_id": bulk_part["id"], "quantity": 20, "location": "Warehouse"},
        headers=auth_headers,
    )
    source_id = create_resp.json()["items"][0]["id"]

    client.post(
        "/api/inventory/transfer",
        json={
            "source_inventory_id": source_id,
            "target_location": "Floor",
            "quantity": 5,
        },
        headers=auth_headers,
    )

    resp = client.get("/api/inventory/transfers")
    assert resp.status_code == 200
    assert len(resp.json()) >= 1


def test_get_transfer(client: TestClient, auth_headers: dict, bulk_part: dict) -> None:
    create_resp = client.post(
        "/api/inventory",
        json={"part_id": bulk_part["id"], "quantity": 20, "location": "Warehouse"},
        headers=auth_headers,
    )
    source_id = create_resp.json()["items"][0]["id"]

    transfer_resp = client.post(
        "/api/inventory/transfer",
        json={
            "source_inventory_id": source_id,
            "target_location": "Floor",
            "quantity": 5,
        },
        headers=auth_headers,
    )
    transfer_id = transfer_resp.json()["id"]

    resp = client.get(f"/api/inventory/transfers/{transfer_id}")
    assert resp.status_code == 200
    assert resp.json()["id"] == transfer_id


# ============ Test Templates & Results ============


def test_create_test_template(
    client: TestClient, auth_headers: dict, serialized_part: dict
) -> None:
    resp = client.post(
        f"/api/inventory/parts/{serialized_part['id']}/test-templates",
        json={"name": "Voltage Test", "description": "Check output voltage", "required": True},
        headers=auth_headers,
    )
    assert resp.status_code == 201
    data = resp.json()
    assert data["name"] == "Voltage Test"
    assert data["required"] is True


def test_list_test_templates(client: TestClient, auth_headers: dict, serialized_part: dict) -> None:
    client.post(
        f"/api/inventory/parts/{serialized_part['id']}/test-templates",
        json={"name": "Test A"},
        headers=auth_headers,
    )
    client.post(
        f"/api/inventory/parts/{serialized_part['id']}/test-templates",
        json={"name": "Test B"},
        headers=auth_headers,
    )

    resp = client.get(f"/api/inventory/parts/{serialized_part['id']}/test-templates")
    assert resp.status_code == 200
    assert len(resp.json()) >= 2


def test_create_test_result(client: TestClient, auth_headers: dict, serialized_part: dict) -> None:
    # Create inventory record
    inv_resp = client.post(
        "/api/inventory",
        json={"part_id": serialized_part["id"], "quantity": 1, "location": "Lab"},
        headers=auth_headers,
    )
    inv_id = inv_resp.json()["items"][0]["id"]

    resp = client.post(
        f"/api/inventory/{inv_id}/tests",
        json={"test_name": "Continuity", "result": "pass", "value": "OK"},
        headers=auth_headers,
    )
    assert resp.status_code == 201
    data = resp.json()
    assert data["test_name"] == "Continuity"
    assert data["result"] == "pass"


def test_update_test_result(client: TestClient, auth_headers: dict, serialized_part: dict) -> None:
    inv_resp = client.post(
        "/api/inventory",
        json={"part_id": serialized_part["id"], "quantity": 1, "location": "Lab"},
        headers=auth_headers,
    )
    inv_id = inv_resp.json()["items"][0]["id"]

    create_resp = client.post(
        f"/api/inventory/{inv_id}/tests",
        json={"test_name": "Voltage", "result": "pending"},
        headers=auth_headers,
    )
    test_id = create_resp.json()["id"]

    resp = client.patch(
        f"/api/inventory/{inv_id}/tests/{test_id}",
        json={"test_name": "Voltage", "result": "pass", "value": "3.3V"},
        headers=auth_headers,
    )
    assert resp.status_code == 200
    assert resp.json()["result"] == "pass"
    assert resp.json()["value"] == "3.3V"


def test_delete_test_result(client: TestClient, auth_headers: dict, serialized_part: dict) -> None:
    inv_resp = client.post(
        "/api/inventory",
        json={"part_id": serialized_part["id"], "quantity": 1, "location": "Lab"},
        headers=auth_headers,
    )
    inv_id = inv_resp.json()["items"][0]["id"]

    create_resp = client.post(
        f"/api/inventory/{inv_id}/tests",
        json={"test_name": "Temp", "result": "fail"},
        headers=auth_headers,
    )
    test_id = create_resp.json()["id"]

    resp = client.delete(f"/api/inventory/{inv_id}/tests/{test_id}", headers=auth_headers)
    assert resp.status_code == 204


def test_test_status(client: TestClient, auth_headers: dict, serialized_part: dict) -> None:
    inv_resp = client.post(
        "/api/inventory",
        json={"part_id": serialized_part["id"], "quantity": 1, "location": "Lab"},
        headers=auth_headers,
    )
    inv_id = inv_resp.json()["items"][0]["id"]

    client.post(
        f"/api/inventory/{inv_id}/tests",
        json={"test_name": "A", "result": "pass"},
        headers=auth_headers,
    )
    client.post(
        f"/api/inventory/{inv_id}/tests",
        json={"test_name": "B", "result": "fail"},
        headers=auth_headers,
    )
    client.post(
        f"/api/inventory/{inv_id}/tests",
        json={"test_name": "C", "result": "pending"},
        headers=auth_headers,
    )

    resp = client.get(f"/api/inventory/{inv_id}/test-status")
    assert resp.status_code == 200
    data = resp.json()
    assert data["passed"] == 1
    assert data["failed"] == 1
    assert data["pending"] == 1
    assert data["total_tests"] == 3


def test_locations(client: TestClient, auth_headers: dict, bulk_part: dict) -> None:
    client.post(
        "/api/inventory",
        json={"part_id": bulk_part["id"], "quantity": 5, "location": "LOC-UNIQUE-TEST"},
        headers=auth_headers,
    )

    resp = client.get("/api/inventory/locations")
    assert resp.status_code == 200
    locations = resp.json()
    assert any(loc["location"] == "LOC-UNIQUE-TEST" for loc in locations)


# ============ OPAL record detail ============


def _receive_stock(client: TestClient, part_id: int, **overrides) -> dict:
    """Receive stock for a part; returns the created inventory item dict."""
    payload = {"part_id": part_id, "quantity": 10, "location": "STORE-A2"}
    payload.update(overrides)
    resp = client.post("/api/inventory", json=payload)
    assert resp.status_code == 201, resp.text
    return resp.json()["items"][0]


def _consume_via_execution(client: TestClient, part: dict, inv_record_id: int) -> int:
    """Kit a procedure with the part, start an instance, consume from the
    given record. Returns the instance id."""
    proc_id = client.post("/api/procedures", json={"name": "Opal Page Kit Proc"}).json()["id"]
    client.post(
        f"/api/procedures/{proc_id}/kit",
        json={"part_id": part["id"], "quantity_required": 5},
    )
    client.post(f"/api/procedures/{proc_id}/steps", json={"title": "Install"})
    client.post(f"/api/procedures/{proc_id}/publish")
    instance_id = client.post("/api/procedure-instances", json={"procedure_id": proc_id}).json()[
        "id"
    ]
    resp = client.post(
        f"/api/procedure-instances/{instance_id}/consume",
        json={"items": [{"inventory_record_id": inv_record_id, "quantity": 5}]},
    )
    assert resp.status_code == 200, resp.text
    return instance_id


def _detail(client: TestClient, opal: str) -> dict:
    resp = client.get(f"/api/inventory/opal/{opal}/detail")
    assert resp.status_code == 200, resp.text
    return resp.json()


def test_detail_not_found(client: TestClient) -> None:
    assert client.get("/api/inventory/opal/OPAL-99999/detail").status_code == 404


def test_detail_carries_record_part_and_receipt(client: TestClient, bulk_part: dict) -> None:
    """The record page needs the part's identity (internal PN, not just the
    name) and a receipt row carrying the opening quantity."""
    item = _receive_stock(client, bulk_part["id"], lot_number="LOT-2026-03")
    body = _detail(client, item["opal_number"])

    assert body["inventory"]["lot_number"] == "LOT-2026-03"
    assert body["part"]["internal_pn"] == bulk_part["internal_pn"]
    assert body["part"]["id"] == bulk_part["id"]
    assert body["source"]["type"] == "manual"
    assert [r["kind"] for r in body["ledger"]] == ["received"]
    assert float(body["ledger"][0]["delta"]) == 10
    assert float(body["ledger"][0]["balance"]) == 10
    assert body["tests"] == [] and body["test_templates"] == []


def test_detail_po_source_is_the_reference_not_a_database_id(
    client: TestClient, auth_headers: dict, bulk_part: dict
) -> None:
    """Purchase.reference is already the identifier ('PO-0424'); the source
    carries it verbatim so the page never has to build one from an id."""
    po = client.post(
        "/api/purchases",
        json={
            "supplier": "Opal Page Supplier",
            "reference": "PO-0424",
            "lines": [{"part_id": bulk_part["id"], "qty_ordered": 4}],
        },
        headers=auth_headers,
    ).json()
    client.patch(f"/api/purchases/{po['id']}", json={"status": "ordered"})
    recv = client.post(
        f"/api/purchases/{po['id']}/receive",
        json={
            "lines": [
                {
                    "line_id": po["lines"][0]["id"],
                    "qty_received": 4,
                    "location": "A1",
                    "lot_number": "LOT-0424-A",
                }
            ]
        },
    )
    assert recv.status_code == 200, recv.text

    inv = client.get(f"/api/inventory?part_id={bulk_part['id']}").json()["items"][0]
    body = _detail(client, inv["opal_number"])
    assert body["source"]["type"] == "purchase"
    assert body["source"]["purchase"]["reference"] == po["reference"]
    assert body["source"]["purchase"]["id"] == po["id"]


def test_detail_ledger_names_the_work_order_and_keeps_a_running_balance(
    client: TestClient, bulk_part: dict
) -> None:
    """A consumption row names the work order and links its execution, and the
    receipt row is the opening quantity (current + consumed), not today's
    on-hand."""
    item = _receive_stock(client, bulk_part["id"])
    instance_id = _consume_via_execution(client, bulk_part, item["id"])
    wo_number = client.get(f"/api/procedure-instances/{instance_id}").json()["work_order_number"]
    assert wo_number

    body = _detail(client, item["opal_number"])
    assert float(body["inventory"]["quantity"]) == 5
    received, consumed = body["ledger"]
    assert received["kind"] == "received" and float(received["delta"]) == 10
    assert consumed["kind"] == "consumed" and float(consumed["delta"]) == -5
    assert float(consumed["balance"]) == 5
    assert consumed["execution"]["id"] == instance_id
    assert consumed["execution"]["work_order_number"] == wo_number


def test_detail_ledger_records_adjustments_and_counts(client: TestClient, bulk_part: dict) -> None:
    item = _receive_stock(client, bulk_part["id"], quantity=20)
    client.post(
        f"/api/inventory/{item['id']}/adjust",
        json={"adjustment": -3, "reason": "damage", "notes": "dropped"},
    )
    client.post(f"/api/inventory/{item['id']}/count", json={"counted_quantity": 18})

    body = _detail(client, item["opal_number"])
    kinds = [r["kind"] for r in body["ledger"]]
    assert kinds == ["received", "scrapped", "counted"]
    scrapped = body["ledger"][1]
    assert scrapped["reason"] == "damage" and scrapped["notes"] == "dropped"
    assert [float(r["balance"]) for r in body["ledger"]] == [20, 17, 18]
    assert float(body["inventory"]["quantity"]) == 18


def test_detail_tests_and_templates(client: TestClient, bulk_part: dict) -> None:
    item = _receive_stock(client, bulk_part["id"])
    client.post(
        f"/api/inventory/parts/{bulk_part['id']}/test-templates",
        json={"name": "Continuity", "test_type": "boolean", "required": True},
    )
    body = _detail(client, item["opal_number"])
    assert [t["name"] for t in body["test_templates"]] == ["Continuity"]
    assert body["test_templates"][0]["required"] is True
    assert body["tests"] == []

    resp = client.post(
        f"/api/inventory/{item['id']}/tests",
        json={"test_name": "Continuity", "result": "pass"},
    )
    assert resp.status_code == 201, resp.text
    body = _detail(client, item["opal_number"])
    assert body["tests"][0]["test_name"] == "Continuity"
    assert body["tests"][0]["result"] == "pass"
    assert body["tests"][0]["tested_by_name"]


# ============ Stock list: search, filters, sort ============


def test_list_search_matches_opal_part_lot_and_location(
    client: TestClient, bulk_part: dict, serialized_part: dict
) -> None:
    a = _receive_stock(client, bulk_part["id"], location="RACK-ALPHA", lot_number="LOT-Q1")
    b = _receive_stock(client, serialized_part["id"], quantity=1, location="RACK-BETA")

    def search(term: str) -> set[str]:
        resp = client.get("/api/inventory", params={"search": term})
        assert resp.status_code == 200
        return {i["opal_number"] for i in resp.json()["items"]}

    assert search(a["opal_number"]) == {a["opal_number"]}
    assert search("RACK-BETA") == {b["opal_number"]}
    assert search("LOT-Q1") == {a["opal_number"]}
    assert search("Fasteners M3") == {a["opal_number"]}
    assert search(serialized_part["internal_pn"]) == {b["opal_number"]}
    assert search("no-such-thing") == set()


def test_list_has_stock_and_source_filters(client: TestClient, bulk_part: dict) -> None:
    item = _receive_stock(client, bulk_part["id"], quantity=2)
    client.post(f"/api/inventory/{item['id']}/count", json={"counted_quantity": 0})

    params = {"part_id": bulk_part["id"]}
    assert client.get("/api/inventory", params={**params, "has_stock": True}).json()["total"] == 0
    assert client.get("/api/inventory", params={**params, "has_stock": False}).json()["total"] == 1
    manual = client.get("/api/inventory", params={**params, "source_type": "manual"})
    assert manual.json()["total"] == 1
    purchase = client.get("/api/inventory", params={**params, "source_type": "purchase"})
    assert purchase.json()["total"] == 0


def test_list_sort(client: TestClient, bulk_part: dict) -> None:
    _receive_stock(client, bulk_part["id"], quantity=3, location="SORT-B")
    _receive_stock(client, bulk_part["id"], quantity=9, location="SORT-A")
    _receive_stock(client, bulk_part["id"], quantity=6, location="SORT-C")

    def quantities(**params) -> list[float]:
        resp = client.get("/api/inventory", params={"part_id": bulk_part["id"], **params})
        return [float(i["quantity"]) for i in resp.json()["items"]]

    assert quantities(sort="quantity", order="asc") == [3, 6, 9]
    assert quantities(sort="quantity", order="desc") == [9, 6, 3]
    assert quantities(sort="location") == [9, 3, 6]
    assert client.get("/api/inventory", params={"sort": "bogus"}).status_code == 400


def test_list_low_stock_filters_to_parts_under_reorder_point(
    client: TestClient, bulk_part: dict
) -> None:
    client.patch(f"/api/parts/{bulk_part['id']}", json={"reorder_point": 50})
    low = _receive_stock(client, bulk_part["id"], quantity=5)

    other = client.post(
        "/api/parts", json={"name": "Plentiful", "tracking_type": "bulk", "reorder_point": 1}
    ).json()
    client.post(f"/api/parts/{other['id']}/activate", json={"cause": "test setup"})
    _receive_stock(client, other["id"], quantity=100)

    resp = client.get("/api/inventory", params={"low_stock": True})
    assert {i["opal_number"] for i in resp.json()["items"]} == {low["opal_number"]}


def test_stock_by_part_sums_records_and_flags_low_stock(
    client: TestClient, bulk_part: dict
) -> None:
    client.patch(f"/api/parts/{bulk_part['id']}", json={"reorder_point": 100})
    _receive_stock(client, bulk_part["id"], quantity=4, location="BP-ONE")
    _receive_stock(client, bulk_part["id"], quantity=6, location="BP-TWO")

    resp = client.get("/api/inventory/by-part", params={"search": bulk_part["internal_pn"]})
    assert resp.status_code == 200
    rows = resp.json()["items"]
    assert len(rows) == 1
    row = rows[0]
    assert row["part_id"] == bulk_part["id"]
    assert float(row["quantity"]) == 10
    assert row["record_count"] == 2
    assert row["locations"] == ["BP-ONE", "BP-TWO"]
    assert row["is_low_stock"] is True

    narrowed = client.get("/api/inventory/by-part", params={"location": "BP-TWO"}).json()["items"]
    assert float(narrowed[0]["quantity"]) == 6
    # Low stock is judged on the part's whole on-hand, not the narrowed sum
    assert narrowed[0]["is_low_stock"] is True

    assert client.get("/api/inventory/by-part", params={"low_stock": True}).json()["total"] >= 1


# ============ Receiving: tier rules ============


def test_create_enforces_lot_for_lot_tracked_tier_when_asked(
    client: TestClient, bulk_part: dict
) -> None:
    """Tier 1 requires a lot on bulk receipts (legacy level rules when no
    tier semantics are configured) — the web form opts in."""
    payload = {
        "part_id": bulk_part["id"],
        "quantity": 4,
        "location": "TR-1",
        "enforce_tier_rules": True,
    }
    resp = client.post("/api/inventory", json=payload)
    assert resp.status_code == 422
    assert "lot_number" in resp.json()["detail"]

    ok = client.post("/api/inventory", json={**payload, "lot_number": "LOT-T1"})
    assert ok.status_code == 201
    assert ok.json()["items"][0]["lot_number"] == "LOT-T1"

    # Without the flag the API behaves as before
    plain = {k: v for k, v in payload.items() if k != "enforce_tier_rules"}
    assert client.post("/api/inventory", json=plain).status_code == 201


def test_create_auto_serial_issues_a_serial_per_unit(
    client: TestClient, serialized_part: dict
) -> None:
    resp = client.post(
        "/api/inventory",
        json={
            "part_id": serialized_part["id"],
            "quantity": 3,
            "location": "TR-2",
            "enforce_tier_rules": True,
        },
    )
    assert resp.status_code == 201
    lots = [i["lot_number"] for i in resp.json()["items"]]
    assert all(lots) and len(set(lots)) == 3

    explicit = client.post(
        "/api/inventory",
        json={
            "part_id": serialized_part["id"],
            "quantity": 1,
            "location": "TR-2",
            "lot_number": "MY-SERIAL",
            "enforce_tier_rules": True,
        },
    )
    assert explicit.json()["items"][0]["lot_number"] == "MY-SERIAL"


def test_create_rejects_non_positive_quantity(client: TestClient, bulk_part: dict) -> None:
    resp = client.post(
        "/api/inventory", json={"part_id": bulk_part["id"], "quantity": 0, "location": "Z"}
    )
    assert resp.status_code == 400


# ============ Moves ============


def test_partial_move_gives_the_moved_stock_its_own_opal_number(
    client: TestClient, bulk_part: dict
) -> None:
    item = _receive_stock(client, bulk_part["id"], quantity=20, location="MV-FROM")
    resp = client.post(
        "/api/inventory/transfer",
        json={"source_inventory_id": item["id"], "target_location": "MV-TO", "quantity": 8},
    )
    assert resp.status_code == 201, resp.text
    moved = resp.json()
    assert moved["source_opal_number"] == item["opal_number"]
    assert moved["target_opal_number"] and moved["target_opal_number"] != item["opal_number"]

    target = client.get(f"/api/inventory/opal/{moved['target_opal_number']}").json()
    assert float(target["quantity"]) == 8
    assert target["location"] == "MV-TO"
    assert target["source_type"] == "transfer"

    # Both halves trace the move
    src = _detail(client, item["opal_number"])
    assert [r["kind"] for r in src["ledger"]] == ["received", "moved_out"]
    assert src["ledger"][-1]["counterpart_opal"] == moved["target_opal_number"]
    dst = _detail(client, moved["target_opal_number"])
    assert [r["kind"] for r in dst["ledger"]] == ["moved_in"]
    assert float(dst["ledger"][0]["balance"]) == 8
    assert dst["source"]["transferred_from_opal"] == item["opal_number"]


def test_whole_move_relocates_the_record_and_keeps_its_opal_number(
    client: TestClient, serialized_part: dict
) -> None:
    item = _receive_stock(client, serialized_part["id"], quantity=1, location="MV-A")
    resp = client.post(
        "/api/inventory/transfer",
        json={"source_inventory_id": item["id"], "target_location": "MV-B", "quantity": 1},
    )
    assert resp.status_code == 201, resp.text
    assert resp.json()["target_opal_number"] == item["opal_number"]
    assert resp.json()["source_location"] == "MV-A"

    moved = client.get(f"/api/inventory/opal/{item['opal_number']}").json()
    assert moved["location"] == "MV-B"
    assert float(moved["quantity"]) == 1
    # No ghost zero-quantity record left behind
    here = client.get("/api/inventory", params={"location": "MV-A"}).json()
    assert here["total"] == 0

    ledger = _detail(client, item["opal_number"])["ledger"]
    assert [r["kind"] for r in ledger] == ["received", "moved"]
    assert ledger[-1]["from_location"] == "MV-A" and ledger[-1]["to_location"] == "MV-B"
    assert float(ledger[-1]["balance"]) == 1


def test_move_merges_into_existing_stock_at_target(client: TestClient, bulk_part: dict) -> None:
    a = _receive_stock(client, bulk_part["id"], quantity=10, location="MG-A", lot_number="L1")
    b = _receive_stock(client, bulk_part["id"], quantity=5, location="MG-B", lot_number="L1")
    resp = client.post(
        "/api/inventory/transfer",
        json={"source_inventory_id": a["id"], "target_location": "MG-B", "quantity": 10},
    )
    assert resp.status_code == 201
    assert resp.json()["target_opal_number"] == b["opal_number"]
    assert float(client.get(f"/api/inventory/{b['id']}").json()["quantity"]) == 15
    assert float(client.get(f"/api/inventory/{a['id']}").json()["quantity"]) == 0


def test_serialized_unit_is_never_split(client: TestClient, serialized_part: dict) -> None:
    item = _receive_stock(client, serialized_part["id"], quantity=1)
    resp = client.post(
        "/api/inventory/transfer",
        json={"source_inventory_id": item["id"], "target_location": "NOPE", "quantity": 0.5},
    )
    assert resp.status_code == 400


# ============ Auth ============


def test_new_endpoints_require_authentication(client: TestClient) -> None:
    client.cookies.clear()
    for path in ("/api/inventory/by-part", "/api/inventory/opal/OPAL-00001/detail"):
        assert client.get(path, headers={"Authorization": ""}).status_code == 401
