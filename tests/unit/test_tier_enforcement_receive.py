"""Tests for Phase 2: tier enforcement at PO receive.

Rules enforced in receive_purchase:
- T1 or T2, tracking_type=bulk: lot_number required → 422 if missing
- T1, tracking_type=serialized: auto-generate serial if lot_number missing
- T3: no enforcement, pass through
"""

import pytest
from fastapi.testclient import TestClient


# ---- Helpers ----


def _create_part(client: TestClient, **kwargs: object) -> dict:
    """Create a part and return its JSON payload."""
    resp = client.post("/api/parts", json=kwargs)
    assert resp.status_code == 201, resp.text
    return resp.json()


def _create_and_order_po(client: TestClient, auth_headers: dict, part_id: int) -> dict:
    """Create a PO in DRAFT and advance it to ORDERED with one line."""
    # Create PO
    resp = client.post(
        "/api/purchases",
        json={"supplier": "Test Supplier", "lines": [{"part_id": part_id, "qty_ordered": 3}]},
        headers=auth_headers,
    )
    assert resp.status_code == 201, resp.text
    po = resp.json()
    po_id = po["id"]

    # Advance to ORDERED
    resp = client.patch(
        f"/api/purchases/{po_id}",
        json={"status": "ordered"},
        headers=auth_headers,
    )
    assert resp.status_code == 200, resp.text
    return resp.json()


# ---- Fixtures ----


@pytest.fixture
def t1_bulk_part(client: TestClient) -> dict:
    """Tier-1 bulk (lot-tracked) part."""
    return _create_part(
        client,
        name="T1 Bulk Part",
        tier=1,
        tracking_type="bulk",
        category="Components",
    )


@pytest.fixture
def t1_serialized_part(client: TestClient) -> dict:
    """Tier-1 serialized part."""
    return _create_part(
        client,
        name="T1 Serial Part",
        tier=1,
        tracking_type="serialized",
        category="Components",
    )


@pytest.fixture
def t2_bulk_part(client: TestClient) -> dict:
    """Tier-2 bulk (lot-tracked) part."""
    return _create_part(
        client,
        name="T2 Bulk Part",
        tier=2,
        tracking_type="bulk",
        category="Components",
    )


@pytest.fixture
def t3_bulk_part(client: TestClient) -> dict:
    """Tier-3 bulk part — no enforcement expected."""
    return _create_part(
        client,
        name="T3 Bulk Part",
        tier=3,
        tracking_type="bulk",
        category="Components",
    )


# ---- Tests ----


def test_t1_serialized_no_lot_number_gets_auto_serial(
    client: TestClient, auth_headers: dict, t1_serialized_part: dict
) -> None:
    """T1 serialized receive without lot_number → auto-generates serial (3-digit plain number)."""
    po = _create_and_order_po(client, auth_headers, t1_serialized_part["id"])
    line_id = po["lines"][0]["id"]

    resp = client.post(
        f"/api/purchases/{po['id']}/receive",
        json={"lines": [{"line_id": line_id, "qty_received": 1, "location": "Bin A"}]},
        headers=auth_headers,
    )
    assert resp.status_code == 200, resp.text

    # The inventory record for this part should have a non-null lot_number (auto serial)
    inv_resp = client.get(f"/api/inventory?part_id={t1_serialized_part['id']}")
    assert inv_resp.status_code == 200
    items = inv_resp.json()["items"]
    assert len(items) >= 1
    lot = items[0]["lot_number"]
    assert lot is not None
    # Serial format from generate_serial_number is a plain 3-digit number e.g. "001"
    assert lot.isdigit(), f"Expected plain 3-digit serial, got: {lot!r}"
    assert len(lot) == 3


def test_t1_serialized_with_lot_number_uses_provided(
    client: TestClient, auth_headers: dict, t1_serialized_part: dict
) -> None:
    """T1 serialized receive with explicit lot_number uses the provided value."""
    po = _create_and_order_po(client, auth_headers, t1_serialized_part["id"])
    line_id = po["lines"][0]["id"]

    resp = client.post(
        f"/api/purchases/{po['id']}/receive",
        json={
            "lines": [
                {
                    "line_id": line_id,
                    "qty_received": 1,
                    "location": "Bin A",
                    "lot_number": "CUSTOM-001",
                }
            ]
        },
        headers=auth_headers,
    )
    assert resp.status_code == 200, resp.text

    inv_resp = client.get(f"/api/inventory?part_id={t1_serialized_part['id']}")
    items = inv_resp.json()["items"]
    assert len(items) >= 1
    assert items[0]["lot_number"] == "CUSTOM-001"


def test_t1_bulk_no_lot_number_returns_422(
    client: TestClient, auth_headers: dict, t1_bulk_part: dict
) -> None:
    """T1 bulk receive without lot_number → HTTP 422."""
    po = _create_and_order_po(client, auth_headers, t1_bulk_part["id"])
    line_id = po["lines"][0]["id"]

    resp = client.post(
        f"/api/purchases/{po['id']}/receive",
        json={"lines": [{"line_id": line_id, "qty_received": 2, "location": "Shelf B"}]},
        headers=auth_headers,
    )
    assert resp.status_code == 422
    detail = resp.json()["detail"]
    assert "Tier 1" in detail
    assert t1_bulk_part["name"] in detail
    assert "lot_number" in detail


def test_t2_bulk_no_lot_number_returns_422(
    client: TestClient, auth_headers: dict, t2_bulk_part: dict
) -> None:
    """T2 bulk receive without lot_number → HTTP 422."""
    po = _create_and_order_po(client, auth_headers, t2_bulk_part["id"])
    line_id = po["lines"][0]["id"]

    resp = client.post(
        f"/api/purchases/{po['id']}/receive",
        json={"lines": [{"line_id": line_id, "qty_received": 5, "location": "Rack C"}]},
        headers=auth_headers,
    )
    assert resp.status_code == 422
    detail = resp.json()["detail"]
    assert "Tier 2" in detail
    assert t2_bulk_part["name"] in detail
    assert "lot_number" in detail


def test_t2_bulk_with_lot_number_succeeds(
    client: TestClient, auth_headers: dict, t2_bulk_part: dict
) -> None:
    """T2 bulk receive WITH lot_number → succeeds."""
    po = _create_and_order_po(client, auth_headers, t2_bulk_part["id"])
    line_id = po["lines"][0]["id"]

    resp = client.post(
        f"/api/purchases/{po['id']}/receive",
        json={
            "lines": [
                {
                    "line_id": line_id,
                    "qty_received": 5,
                    "location": "Rack C",
                    "lot_number": "LOT-2024-001",
                }
            ]
        },
        headers=auth_headers,
    )
    assert resp.status_code == 200, resp.text

    inv_resp = client.get(f"/api/inventory?part_id={t2_bulk_part['id']}")
    items = inv_resp.json()["items"]
    assert len(items) >= 1
    assert items[0]["lot_number"] == "LOT-2024-001"


def test_t3_bulk_no_lot_number_succeeds(
    client: TestClient, auth_headers: dict, t3_bulk_part: dict
) -> None:
    """T3 bulk receive without lot_number → no enforcement, succeeds."""
    po = _create_and_order_po(client, auth_headers, t3_bulk_part["id"])
    line_id = po["lines"][0]["id"]

    resp = client.post(
        f"/api/purchases/{po['id']}/receive",
        json={"lines": [{"line_id": line_id, "qty_received": 10, "location": "Bin Z"}]},
        headers=auth_headers,
    )
    assert resp.status_code == 200, resp.text


def test_t1_serialized_auto_serial_increments_per_part(
    client: TestClient, auth_headers: dict, t1_serialized_part: dict
) -> None:
    """Each receive of a T1 serialized part gets an incrementing serial number."""
    # First receive
    po1 = _create_and_order_po(client, auth_headers, t1_serialized_part["id"])
    line1_id = po1["lines"][0]["id"]
    resp = client.post(
        f"/api/purchases/{po1['id']}/receive",
        json={"lines": [{"line_id": line1_id, "qty_received": 1, "location": "Bin A"}]},
        headers=auth_headers,
    )
    assert resp.status_code == 200, resp.text

    # Second receive (new PO)
    po2 = _create_and_order_po(client, auth_headers, t1_serialized_part["id"])
    line2_id = po2["lines"][0]["id"]
    resp = client.post(
        f"/api/purchases/{po2['id']}/receive",
        json={"lines": [{"line_id": line2_id, "qty_received": 1, "location": "Bin A"}]},
        headers=auth_headers,
    )
    assert resp.status_code == 200, resp.text

    inv_resp = client.get(f"/api/inventory?part_id={t1_serialized_part['id']}")
    items = inv_resp.json()["items"]
    assert len(items) >= 2
    serials = sorted(item["lot_number"] for item in items if item["lot_number"])
    # Should be "001", "002" (ascending)
    assert serials[0] == "001"
    assert serials[1] == "002"
