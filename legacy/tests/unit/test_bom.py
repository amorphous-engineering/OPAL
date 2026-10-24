"""BOM API tests."""

import pytest
from fastapi.testclient import TestClient

# ---- Local fixtures ----


@pytest.fixture
def assembly_part(client: TestClient) -> dict:
    """Create an assembly part via API."""
    resp = client.post("/api/parts", json={"name": "Assembly A", "category": "Assemblies"})
    assert resp.status_code == 201
    return resp.json()


@pytest.fixture
def component_a(client: TestClient) -> dict:
    """Create a component part via API."""
    resp = client.post("/api/parts", json={"name": "Component A", "category": "Electronics"})
    assert resp.status_code == 201
    return resp.json()


@pytest.fixture
def component_b(client: TestClient) -> dict:
    """Create another component part via API."""
    resp = client.post("/api/parts", json={"name": "Component B", "category": "Fasteners"})
    assert resp.status_code == 201
    return resp.json()


# ============ Tests ============


def test_get_empty_bom(client: TestClient, assembly_part: dict) -> None:
    resp = client.get(f"/api/bom/assemblies/{assembly_part['id']}")
    assert resp.status_code == 200
    assert resp.json() == []


def test_add_component(
    client: TestClient, auth_headers: dict, assembly_part: dict, component_a: dict
) -> None:
    resp = client.post(
        f"/api/bom/assemblies/{assembly_part['id']}",
        json={"component_id": component_a["id"], "quantity": 2, "reference_designator": "R1"},
        headers=auth_headers,
    )
    assert resp.status_code == 201
    data = resp.json()
    assert data["assembly_id"] == assembly_part["id"]
    assert data["component_id"] == component_a["id"]
    assert data["quantity"] == 2
    assert data["reference_designator"] == "R1"
    assert data["component_name"] == "Component A"


def test_add_second_component(
    client: TestClient,
    auth_headers: dict,
    assembly_part: dict,
    component_a: dict,
    component_b: dict,
) -> None:
    client.post(
        f"/api/bom/assemblies/{assembly_part['id']}",
        json={"component_id": component_a["id"]},
        headers=auth_headers,
    )
    resp = client.post(
        f"/api/bom/assemblies/{assembly_part['id']}",
        json={"component_id": component_b["id"]},
        headers=auth_headers,
    )
    assert resp.status_code == 201
    assert resp.json()["component_id"] == component_b["id"]


def test_add_component_not_found_assembly(
    client: TestClient, auth_headers: dict, component_a: dict
) -> None:
    resp = client.post(
        "/api/bom/assemblies/99999",
        json={"component_id": component_a["id"]},
        headers=auth_headers,
    )
    assert resp.status_code == 404


def test_add_component_not_found_component(
    client: TestClient, auth_headers: dict, assembly_part: dict
) -> None:
    resp = client.post(
        f"/api/bom/assemblies/{assembly_part['id']}",
        json={"component_id": 99999},
        headers=auth_headers,
    )
    assert resp.status_code == 404


def test_add_component_self_reference(
    client: TestClient, auth_headers: dict, assembly_part: dict
) -> None:
    resp = client.post(
        f"/api/bom/assemblies/{assembly_part['id']}",
        json={"component_id": assembly_part["id"]},
        headers=auth_headers,
    )
    assert resp.status_code == 400


def test_add_component_duplicate(
    client: TestClient, auth_headers: dict, assembly_part: dict, component_a: dict
) -> None:
    client.post(
        f"/api/bom/assemblies/{assembly_part['id']}",
        json={"component_id": component_a["id"]},
        headers=auth_headers,
    )
    resp = client.post(
        f"/api/bom/assemblies/{assembly_part['id']}",
        json={"component_id": component_a["id"]},
        headers=auth_headers,
    )
    assert resp.status_code == 400


def test_get_assembly_bom(
    client: TestClient, auth_headers: dict, assembly_part: dict, component_a: dict
) -> None:
    client.post(
        f"/api/bom/assemblies/{assembly_part['id']}",
        json={"component_id": component_a["id"], "quantity": 3},
        headers=auth_headers,
    )
    resp = client.get(f"/api/bom/assemblies/{assembly_part['id']}")
    assert resp.status_code == 200
    items = resp.json()
    assert len(items) == 1
    assert items[0]["component_id"] == component_a["id"]
    assert items[0]["quantity"] == 3


def test_get_bom_tree(
    client: TestClient, auth_headers: dict, assembly_part: dict, component_a: dict
) -> None:
    client.post(
        f"/api/bom/assemblies/{assembly_part['id']}",
        json={"component_id": component_a["id"]},
        headers=auth_headers,
    )
    resp = client.get(f"/api/bom/assemblies/{assembly_part['id']}/tree")
    assert resp.status_code == 200
    tree = resp.json()
    assert tree["part_id"] == assembly_part["id"]
    assert len(tree["children"]) == 1
    assert tree["children"][0]["part_id"] == component_a["id"]


def test_where_used(
    client: TestClient, auth_headers: dict, assembly_part: dict, component_a: dict
) -> None:
    client.post(
        f"/api/bom/assemblies/{assembly_part['id']}",
        json={"component_id": component_a["id"]},
        headers=auth_headers,
    )
    resp = client.get(f"/api/bom/components/{component_a['id']}/used-in")
    assert resp.status_code == 200
    items = resp.json()
    assert len(items) == 1
    assert items[0]["assembly_id"] == assembly_part["id"]


def test_where_used_empty(client: TestClient, component_a: dict) -> None:
    resp = client.get(f"/api/bom/components/{component_a['id']}/used-in")
    assert resp.status_code == 200
    assert resp.json() == []


def test_update_bom_line(
    client: TestClient, auth_headers: dict, assembly_part: dict, component_a: dict
) -> None:
    add_resp = client.post(
        f"/api/bom/assemblies/{assembly_part['id']}",
        json={"component_id": component_a["id"], "quantity": 1},
        headers=auth_headers,
    )
    line_id = add_resp.json()["id"]

    resp = client.patch(
        f"/api/bom/{line_id}",
        json={"quantity": 5, "reference_designator": "U1,U2"},
        headers=auth_headers,
    )
    assert resp.status_code == 200
    assert resp.json()["quantity"] == 5
    assert resp.json()["reference_designator"] == "U1,U2"


def test_delete_bom_line(
    client: TestClient, auth_headers: dict, assembly_part: dict, component_a: dict
) -> None:
    add_resp = client.post(
        f"/api/bom/assemblies/{assembly_part['id']}",
        json={"component_id": component_a["id"]},
        headers=auth_headers,
    )
    line_id = add_resp.json()["id"]

    resp = client.delete(f"/api/bom/{line_id}", headers=auth_headers)
    assert resp.status_code == 204

    # Verify it's gone
    bom = client.get(f"/api/bom/assemblies/{assembly_part['id']}").json()
    assert len(bom) == 0


# ---- Page-facing behaviour ----


def test_bom_line_response_names_parts_by_number(client, assembly_part, component_a):
    resp = client.post(
        f"/api/bom/assemblies/{assembly_part['id']}", json={"component_id": component_a["id"]}
    )
    line = resp.json()
    assert line["component_internal_pn"] == component_a["internal_pn"]
    assert line["assembly_internal_pn"] == assembly_part["internal_pn"]
    assert line["component_state"] == "draft"


def test_patch_bom_line_null_clears_refdes_and_notes(client, assembly_part, component_a):
    line = client.post(
        f"/api/bom/assemblies/{assembly_part['id']}",
        json={"component_id": component_a["id"], "reference_designator": "R1", "notes": "n"},
    ).json()

    # Omitted fields stay
    kept = client.patch(f"/api/bom/{line['id']}", json={"quantity": 3}).json()
    assert (kept["reference_designator"], kept["notes"], kept["quantity"]) == ("R1", "n", 3)

    cleared = client.patch(
        f"/api/bom/{line['id']}", json={"reference_designator": None, "notes": None}
    ).json()
    assert cleared["reference_designator"] is None
    assert cleared["notes"] is None
    assert cleared["quantity"] == 3


def test_add_component_rejects_loop(client, assembly_part, component_a, component_b):
    base = "/api/bom/assemblies"
    one = client.post(f"{base}/{assembly_part['id']}", json={"component_id": component_a["id"]})
    assert one.status_code == 201
    two = client.post(f"{base}/{component_a['id']}", json={"component_id": component_b["id"]})
    assert two.status_code == 201
    # B -> A would close the loop A -> B -> A through the structure
    loop = client.post(f"{base}/{component_b['id']}", json={"component_id": assembly_part["id"]})
    assert loop.status_code == 400
    assert "loop" in loop.json()["detail"]


def test_add_component_rejects_zero_quantity(client, assembly_part, component_a):
    resp = client.post(
        f"/api/bom/assemblies/{assembly_part['id']}",
        json={"component_id": component_a["id"], "quantity": 0},
    )
    assert resp.status_code == 400
