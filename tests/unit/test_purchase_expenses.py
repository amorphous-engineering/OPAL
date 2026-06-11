"""Tests for the purchase expense ledger written at PO receive time."""

import pytest
from fastapi.testclient import TestClient

from opal.db.models import User
from tests.conftest import login

# ---- Helpers ----


def _create_part(client: TestClient, **kwargs: object) -> dict:
    resp = client.post("/api/parts", json=kwargs)
    assert resp.status_code == 201, resp.text
    part = resp.json()
    client.post(f"/api/parts/{part['id']}/activate", json={"cause": "test setup"})
    return part


def _create_and_order_po(client: TestClient, auth_headers: dict, lines: list[dict]) -> dict:
    resp = client.post(
        "/api/purchases",
        json={"supplier": "Ledger Supplier", "lines": lines},
        headers=auth_headers,
    )
    assert resp.status_code == 201, resp.text
    po_id = resp.json()["id"]

    resp = client.patch(f"/api/purchases/{po_id}", json={"status": "ordered"}, headers=auth_headers)
    assert resp.status_code == 200, resp.text
    return resp.json()


def _receive(client: TestClient, auth_headers: dict, po: dict, lines: list[dict]) -> dict:
    resp = client.post(
        f"/api/purchases/{po['id']}/receive", json={"lines": lines}, headers=auth_headers
    )
    assert resp.status_code == 200, resp.text
    return resp.json()


@pytest.fixture
def web_client(client: TestClient, test_user: User) -> TestClient:
    login(client, test_user)
    return client


# ---- Tests ----


def test_receive_writes_expense_with_costs(client, auth_headers):
    part = _create_part(client, name="Costed Valve", tier=1, tracking_type="bulk")
    po = _create_and_order_po(
        client,
        auth_headers,
        [{"part_id": part["id"], "qty_ordered": 4, "unit_cost": "12.50"}],
    )
    line_id = po["lines"][0]["id"]
    _receive(
        client,
        auth_headers,
        po,
        [{"line_id": line_id, "qty_received": 4, "location": "Stores", "lot_number": "LOT-7"}],
    )

    resp = client.get(f"/api/purchases/{po['id']}/expenses")
    assert resp.status_code == 200
    expenses = resp.json()
    assert len(expenses) == 1
    e = expenses[0]
    assert e["part_id"] == part["id"]
    assert e["part_name"] == "Costed Valve"
    assert float(e["quantity"]) == 4
    assert float(e["unit_cost"]) == 12.50
    assert float(e["total_cost"]) == 50.00
    assert e["tier"] == 1
    assert e["purchase_line_id"] == line_id
    assert e["received_at"] is not None


def test_receive_without_cost_writes_null_costs(client, auth_headers):
    part = _create_part(client, name="Free Sample", tier=3, tracking_type="bulk")
    po = _create_and_order_po(client, auth_headers, [{"part_id": part["id"], "qty_ordered": 2}])
    _receive(
        client,
        auth_headers,
        po,
        [{"line_id": po["lines"][0]["id"], "qty_received": 2, "location": "Stores"}],
    )

    expenses = client.get(f"/api/purchases/{po['id']}/expenses").json()
    assert len(expenses) == 1
    assert expenses[0]["unit_cost"] is None
    assert expenses[0]["total_cost"] is None
    assert expenses[0]["tier"] == 3


def test_partial_receives_accumulate_records(client, auth_headers):
    part = _create_part(client, name="Trickle Part", tier=3, tracking_type="bulk")
    po = _create_and_order_po(
        client,
        auth_headers,
        [{"part_id": part["id"], "qty_ordered": 10, "unit_cost": "2.00"}],
    )
    line_id = po["lines"][0]["id"]
    _receive(client, auth_headers, po, [{"line_id": line_id, "qty_received": 3, "location": "A"}])
    _receive(client, auth_headers, po, [{"line_id": line_id, "qty_received": 7, "location": "A"}])

    expenses = client.get(f"/api/purchases/{po['id']}/expenses").json()
    assert len(expenses) == 2
    assert sorted(float(e["quantity"]) for e in expenses) == [3.0, 7.0]
    assert sum(float(e["total_cost"]) for e in expenses) == 20.0


def test_expenses_empty_before_receive(client, auth_headers):
    part = _create_part(client, name="Unreceived Part", tier=3, tracking_type="bulk")
    po = _create_and_order_po(client, auth_headers, [{"part_id": part["id"], "qty_ordered": 1}])
    assert client.get(f"/api/purchases/{po['id']}/expenses").json() == []


def test_expenses_404_for_unknown_purchase(client):
    assert client.get("/api/purchases/99999/expenses").status_code == 404


def test_expense_panel_renders(web_client, auth_headers):
    part = _create_part(web_client, name="Panel Part", tier=2, tracking_type="bulk")
    po = _create_and_order_po(
        web_client,
        auth_headers,
        [{"part_id": part["id"], "qty_ordered": 2, "unit_cost": "5.00"}],
    )
    _receive(
        web_client,
        auth_headers,
        po,
        [
            {
                "line_id": po["lines"][0]["id"],
                "qty_received": 2,
                "location": "GSE rack",
                "lot_number": "LOT-G1",
            }
        ],
    )

    page = web_client.get(f"/purchases/{po['id']}")
    assert page.status_code == 200
    assert "EXPENSE RECORDS" in page.text
    assert "Panel Part" in page.text
    assert "10.00" in page.text  # total row: 2 x 5.00


def test_expense_panel_empty_state(web_client, auth_headers):
    part = _create_part(web_client, name="Empty Panel Part", tier=3, tracking_type="bulk")
    po = _create_and_order_po(web_client, auth_headers, [{"part_id": part["id"], "qty_ordered": 1}])
    page = web_client.get(f"/purchases/{po['id']}")
    assert page.status_code == 200
    assert "No expense records" in page.text
