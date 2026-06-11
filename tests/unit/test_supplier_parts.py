"""Tests for SupplierPart catalog entries (Phase 3)."""

import pytest
from fastapi.testclient import TestClient

from opal.db.models import User
from tests.conftest import login

# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------


def _create_supplier(client: TestClient, auth_headers: dict, name: str = "Acme Corp") -> dict:
    resp = client.post("/api/suppliers", json={"name": name}, headers=auth_headers)
    assert resp.status_code == 201, resp.text
    return resp.json()


def _create_part(client: TestClient, auth_headers: dict, name: str = "Widget") -> dict:
    resp = client.post(
        "/api/parts",
        json={"name": name, "tier": 1, "tracking_type": "bulk"},
        headers=auth_headers,
    )
    assert resp.status_code == 201, resp.text
    return resp.json()


# ---------------------------------------------------------------------------
# CRUD round-trip
# ---------------------------------------------------------------------------


def test_create_and_list_supplier_part(client: TestClient, auth_headers: dict) -> None:
    """POST creates an entry; GET lists it back."""
    supplier = _create_supplier(client, auth_headers)
    part = _create_part(client, auth_headers)

    resp = client.post(
        f"/api/suppliers/{supplier['id']}/parts",
        json={"part_id": part["id"], "vendor_pn": "DK-12345", "is_preferred": True},
        headers=auth_headers,
    )
    assert resp.status_code == 201, resp.text
    data = resp.json()
    assert data["vendor_pn"] == "DK-12345"
    assert data["is_preferred"] is True
    assert data["supplier_name"] == "Acme Corp"
    assert data["part_name"] == "Widget"

    # List from supplier side
    list_resp = client.get(f"/api/suppliers/{supplier['id']}/parts")
    assert list_resp.status_code == 200
    entries = list_resp.json()
    assert len(entries) == 1
    assert entries[0]["vendor_pn"] == "DK-12345"


def test_update_supplier_part(client: TestClient, auth_headers: dict) -> None:
    """PUT updates vendor_pn and is_preferred."""
    supplier = _create_supplier(client, auth_headers, name="UpdateCo")
    part = _create_part(client, auth_headers, name="UpdatePart")

    entry = client.post(
        f"/api/suppliers/{supplier['id']}/parts",
        json={"part_id": part["id"], "vendor_pn": "OLD-PN"},
        headers=auth_headers,
    ).json()

    resp = client.put(
        f"/api/suppliers/{supplier['id']}/parts/{entry['id']}",
        json={"vendor_pn": "NEW-PN", "is_preferred": True, "notes": "Updated"},
        headers=auth_headers,
    )
    assert resp.status_code == 200, resp.text
    updated = resp.json()
    assert updated["vendor_pn"] == "NEW-PN"
    assert updated["is_preferred"] is True
    assert updated["notes"] == "Updated"


def test_delete_supplier_part(client: TestClient, auth_headers: dict) -> None:
    """DELETE removes the entry; subsequent list is empty."""
    supplier = _create_supplier(client, auth_headers, name="DeleteCo")
    part = _create_part(client, auth_headers, name="DeletePart")

    entry = client.post(
        f"/api/suppliers/{supplier['id']}/parts",
        json={"part_id": part["id"], "vendor_pn": "DEL-001"},
        headers=auth_headers,
    ).json()

    del_resp = client.delete(
        f"/api/suppliers/{supplier['id']}/parts/{entry['id']}",
        headers=auth_headers,
    )
    assert del_resp.status_code == 204

    list_resp = client.get(f"/api/suppliers/{supplier['id']}/parts")
    assert list_resp.status_code == 200
    assert list_resp.json() == []


# ---------------------------------------------------------------------------
# Duplicate constraint
# ---------------------------------------------------------------------------


def test_duplicate_supplier_part_rejected(client: TestClient, auth_headers: dict) -> None:
    """Second POST with same (supplier_id, part_id) returns 409."""
    supplier = _create_supplier(client, auth_headers, name="DupCo")
    part = _create_part(client, auth_headers, name="DupPart")

    payload = {"part_id": part["id"], "vendor_pn": "FIRST-PN"}
    resp1 = client.post(
        f"/api/suppliers/{supplier['id']}/parts", json=payload, headers=auth_headers
    )
    assert resp1.status_code == 201

    payload2 = {"part_id": part["id"], "vendor_pn": "SECOND-PN"}
    resp2 = client.post(
        f"/api/suppliers/{supplier['id']}/parts", json=payload2, headers=auth_headers
    )
    assert resp2.status_code == 409
    assert "already exists" in resp2.json()["detail"]


# ---------------------------------------------------------------------------
# Cross-reference view from the part side
# ---------------------------------------------------------------------------


def test_cross_reference_view_from_part(client: TestClient, auth_headers: dict) -> None:
    """GET /parts/{part_id}/suppliers returns supplier entries for a part."""
    supplier_a = _create_supplier(client, auth_headers, name="SupplierA")
    supplier_b = _create_supplier(client, auth_headers, name="SupplierB")
    part = _create_part(client, auth_headers, name="CrossPart")

    client.post(
        f"/api/suppliers/{supplier_a['id']}/parts",
        json={"part_id": part["id"], "vendor_pn": "SA-001"},
        headers=auth_headers,
    )
    client.post(
        f"/api/suppliers/{supplier_b['id']}/parts",
        json={"part_id": part["id"], "vendor_pn": "SB-002"},
        headers=auth_headers,
    )

    resp = client.get(f"/api/parts/{part['id']}/suppliers")
    assert resp.status_code == 200
    entries = resp.json()
    assert len(entries) == 2
    vendor_pns = {e["vendor_pn"] for e in entries}
    assert vendor_pns == {"SA-001", "SB-002"}
    supplier_names = {e["supplier_name"] for e in entries}
    assert supplier_names == {"SupplierA", "SupplierB"}


# ---------------------------------------------------------------------------
# Cascade on supplier soft-delete
# ---------------------------------------------------------------------------


def test_supplier_soft_delete_excludes_catalog_entries(
    client: TestClient, auth_headers: dict, db_session
) -> None:
    """After a supplier is soft-deleted, its catalog entries disappear from every surface.

    SupplierPart rows still exist in the DB (CASCADE is for hard delete), but the
    API and web layers filter entries whose counterpart is soft-deleted.
    """
    supplier = _create_supplier(client, auth_headers, name="SoftDelSupplier")
    part = _create_part(client, auth_headers, name="SoftDelPart")

    client.post(
        f"/api/suppliers/{supplier['id']}/parts",
        json={"part_id": part["id"], "vendor_pn": "SD-001"},
        headers=auth_headers,
    )

    # Soft-delete the supplier (only allowed when no purchases)
    del_resp = client.delete(f"/api/suppliers/{supplier['id']}", headers=auth_headers)
    assert del_resp.status_code == 204

    # Supplier no longer appears in list
    list_resp = client.get("/api/suppliers")
    names = [s["name"] for s in list_resp.json()["items"]]
    assert "SoftDelSupplier" not in names

    # Supplier detail 404s
    detail_resp = client.get(f"/api/suppliers/{supplier['id']}")
    assert detail_resp.status_code == 404

    # Listing supplier's parts also 404s (supplier is gone)
    parts_resp = client.get(f"/api/suppliers/{supplier['id']}/parts")
    assert parts_resp.status_code == 404

    # The part's supplier list no longer includes the soft-deleted supplier
    part_suppliers = client.get(f"/api/parts/{part['id']}/suppliers")
    assert part_suppliers.status_code == 200
    assert part_suppliers.json() == []

    # And the part detail page hides the entry
    page = client.get(f"/parts/{part['id']}")
    assert "SD-001" not in page.text


def test_part_soft_delete_excludes_catalog_entries(
    client: TestClient, auth_headers: dict, db_session
) -> None:
    """After a part is soft-deleted, its catalog entries vanish from the supplier views."""
    from opal.db.models import Part

    supplier = _create_supplier(client, auth_headers, name="KeepSupplier")
    part = _create_part(client, auth_headers, name="SoftDelLinkedPart")

    client.post(
        f"/api/suppliers/{supplier['id']}/parts",
        json={"part_id": part["id"], "vendor_pn": "SD-002"},
        headers=auth_headers,
    )

    # A draft with a catalog entry is referenced and cannot be deleted via the API
    del_resp = client.delete(f"/api/parts/{part['id']}", headers=auth_headers)
    assert del_resp.status_code == 409

    # The supplier views must still hide entries of soft-deleted parts,
    # however the row came to be deleted
    db_session.query(Part).filter(Part.id == part["id"]).first().soft_delete()
    db_session.flush()

    supplier_parts = client.get(f"/api/suppliers/{supplier['id']}/parts")
    assert supplier_parts.status_code == 200
    assert supplier_parts.json() == []

    page = client.get(f"/suppliers/{supplier['id']}")
    assert "SD-002" not in page.text


# ---------------------------------------------------------------------------
# 404 on missing part reference
# ---------------------------------------------------------------------------


def test_create_supplier_part_invalid_part(client: TestClient, auth_headers: dict) -> None:
    """POST with a non-existent part_id returns 422."""
    supplier = _create_supplier(client, auth_headers, name="NoPart Co")
    resp = client.post(
        f"/api/suppliers/{supplier['id']}/parts",
        json={"part_id": 999999, "vendor_pn": "GHOST"},
        headers=auth_headers,
    )
    assert resp.status_code == 422


# ---------------------------------------------------------------------------
# Web UI smoke tests — detail pages render 200 and include vendor PN
# ---------------------------------------------------------------------------


@pytest.fixture
def web_client(client: TestClient, test_user: User) -> TestClient:
    """TestClient pre-authenticated with the cookie the auth middleware expects."""
    login(client, test_user)
    return client


def test_supplier_detail_renders_catalog_panel(web_client: TestClient, auth_headers: dict) -> None:
    """Supplier detail page renders the CATALOG NUMBERS panel with the vendor PN."""
    supplier = _create_supplier(web_client, auth_headers, name="RenderCo")
    part = _create_part(web_client, auth_headers, name="RenderPart")
    web_client.post(
        f"/api/suppliers/{supplier['id']}/parts",
        json={"part_id": part["id"], "vendor_pn": "RENDER-VPN-001"},
        headers=auth_headers,
    )

    resp = web_client.get(f"/suppliers/{supplier['id']}")
    assert resp.status_code == 200
    assert "CATALOG NUMBERS" in resp.text
    assert "RENDER-VPN-001" in resp.text


def test_part_detail_renders_suppliers_panel(web_client: TestClient, auth_headers: dict) -> None:
    """Part detail page renders the SUPPLIERS panel with the vendor PN."""
    supplier = _create_supplier(web_client, auth_headers, name="PartRenderCo")
    part = _create_part(web_client, auth_headers, name="PartRenderWidget")
    web_client.post(
        f"/api/suppliers/{supplier['id']}/parts",
        json={"part_id": part["id"], "vendor_pn": "PR-VPN-999"},
        headers=auth_headers,
    )

    resp = web_client.get(f"/parts/{part['id']}")
    assert resp.status_code == 200
    assert "SUPPLIERS" in resp.text
    assert "PR-VPN-999" in resp.text
