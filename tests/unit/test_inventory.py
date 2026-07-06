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

    resp = client.patch(
        f"/api/inventory/{inv_id}",
        json={"location": "Shelf B", "quantity": 8},
        headers=auth_headers,
    )
    assert resp.status_code == 200
    assert resp.json()["location"] == "Shelf B"
    assert float(resp.json()["quantity"]) == 8


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


# ============ OPAL detail page (web) ============


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
    instance_id = client.post(
        "/api/procedure-instances", json={"procedure_id": proc_id}
    ).json()["id"]
    resp = client.post(
        f"/api/procedure-instances/{instance_id}/consume",
        json={"items": [{"inventory_record_id": inv_record_id, "quantity": 5}]},
    )
    assert resp.status_code == 200, resp.text
    return instance_id


def test_opal_page_facts_render_as_detail_rows(web_client: TestClient, bulk_part: dict) -> None:
    """The OPAL # page speaks the part-page grammar: a panel with the actions
    in its header, facts as detail rows, the part identified by its internal
    PN — and zero narration."""
    item = _receive_stock(web_client, bulk_part["id"], lot_number="LOT-2026-03")
    opal = item["opal_number"]

    page = web_client.get(f"/inventory/opal/{opal}")
    assert page.status_code == 200
    body = page.text

    assert "OPAL ITEM" in body
    assert opal in body
    # The part fact is the internal PN, linked — not just a name.
    assert f'href="/parts/{bulk_part["id"]}"' in body
    assert bulk_part["internal_pn"] in body
    # Detail-row facts.
    for label in ("PART", "LOCATION", "QUANTITY", "LOT", "SOURCE", "RECEIVED"):
        assert f"<th>{label}</th>" in body, label
    assert "LOT-2026-03" in body
    # History is a headed table, not prose.
    assert "TRACEABILITY HISTORY" in body
    assert "<th>CONTEXT</th>" in body
    assert "RECEIVED" in body
    # Narration is banned.
    assert "Physical Item Traceability" not in body
    assert "No history available" not in body
    assert "No tests recorded" not in body
    assert "No test results recorded" not in body
    assert "Quantity:" not in body


def test_opal_page_consumption_links_work_order_not_db_id(
    web_client: TestClient, bulk_part: dict
) -> None:
    """A consumption event names the work order and links the execution —
    never 'Execution #<database id>'."""
    item = _receive_stock(web_client, bulk_part["id"])
    instance_id = _consume_via_execution(web_client, bulk_part, item["id"])
    wo_number = web_client.get(f"/api/procedure-instances/{instance_id}").json()[
        "work_order_number"
    ]
    assert wo_number

    page = web_client.get(f"/inventory/opal/{item['opal_number']}")
    assert page.status_code == 200
    body = page.text

    assert "CONSUMED" in body
    assert f'href="/executions/{instance_id}"' in body
    assert wo_number in body
    assert f"Execution #{instance_id}" not in body


def test_opal_page_tests_follow_empty_state_rule(web_client: TestClient, bulk_part: dict) -> None:
    """No templates and no results: TESTS is absent. A declared template with
    no results: one empty line, never a header over an empty box."""
    item = _receive_stock(web_client, bulk_part["id"])
    page = web_client.get(f"/inventory/opal/{item['opal_number']}")
    assert "TESTS" not in page.text

    web_client.post(
        f"/api/inventory/parts/{bulk_part['id']}/test-templates",
        json={"name": "Continuity", "test_type": "boolean", "required": True},
    )
    declared = web_client.get(f"/inventory/opal/{item['opal_number']}").text
    assert "TESTS" in declared
    assert "empty-line" in declared
    assert "1 REQUIRED" in declared

    resp = web_client.post(
        f"/api/inventory/{item['id']}/tests",
        json={"test_name": "Continuity", "result": "pass"},
    )
    assert resp.status_code == 201, resp.text
    recorded = web_client.get(f"/inventory/opal/{item['opal_number']}").text
    assert "Continuity" in recorded
    assert "TESTED AT" in recorded
