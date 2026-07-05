"""Parts API tests."""

import pytest

import opal.config as config_mod
from opal.db.models import BOMLine, Part
from opal.project import PartNumberingConfig, ProjectConfig, TierConfig


def test_create_part(client):
    """Test creating a new part."""
    response = client.post(
        "/api/parts",
        json={
            "name": "Test Resistor",
            "external_pn": "RES-10K",
            "category": "Electronics",
            "unit_of_measure": "ea",
            "description": "10K ohm resistor",
        },
    )
    assert response.status_code == 201

    data = response.json()
    assert data["name"] == "Test Resistor"
    assert data["external_pn"] == "RES-10K"
    assert data["category"] == "Electronics"
    assert data["unit_of_measure"] == "ea"
    assert float(data["total_quantity"]) == 0
    assert "id" in data


def test_list_parts(client):
    """Test listing parts."""
    # Create a part first
    client.post(
        "/api/parts",
        json={"name": "Part A", "category": "Cat1"},
    )
    client.post(
        "/api/parts",
        json={"name": "Part B", "category": "Cat2"},
    )

    response = client.get("/api/parts")
    assert response.status_code == 200

    data = response.json()
    assert data["total"] >= 2
    assert len(data["items"]) >= 2


def test_list_parts_with_search(client):
    """Test searching parts."""
    client.post("/api/parts", json={"name": "Widget Alpha"})
    client.post("/api/parts", json={"name": "Gadget Beta"})

    response = client.get("/api/parts?search=Widget")
    assert response.status_code == 200

    data = response.json()
    assert all("Widget" in item["name"] for item in data["items"])


def test_list_parts_with_category_filter(client):
    """Test filtering parts by category."""
    client.post("/api/parts", json={"name": "Part X", "category": "TypeA"})
    client.post("/api/parts", json={"name": "Part Y", "category": "TypeB"})

    response = client.get("/api/parts?category=TypeA")
    assert response.status_code == 200

    data = response.json()
    assert all(item["category"] == "TypeA" for item in data["items"])


def test_get_part(client):
    """Test getting a specific part."""
    create_response = client.post(
        "/api/parts",
        json={"name": "Specific Part"},
    )
    part_id = create_response.json()["id"]

    response = client.get(f"/api/parts/{part_id}")
    assert response.status_code == 200

    data = response.json()
    assert data["id"] == part_id
    assert data["name"] == "Specific Part"


def test_get_part_not_found(client):
    """Test getting a non-existent part."""
    response = client.get("/api/parts/99999")
    assert response.status_code == 404


def test_update_part(client):
    """Test updating a part."""
    create_response = client.post(
        "/api/parts",
        json={"name": "Original Name"},
    )
    part_id = create_response.json()["id"]

    response = client.patch(
        f"/api/parts/{part_id}",
        json={"name": "Updated Name", "category": "New Category"},
    )
    assert response.status_code == 200

    data = response.json()
    assert data["name"] == "Updated Name"
    assert data["category"] == "New Category"


def test_update_part_rejects_explicit_null_on_non_nullable_fields(client):
    """Explicit JSON null on a NOT NULL column is a 422, not a 500."""
    create_response = client.post("/api/parts", json={"name": "Null Probe"})
    part_id = create_response.json()["id"]

    for field in ("name", "unit_of_measure", "tracking_type", "tier", "is_tooling"):
        response = client.patch(f"/api/parts/{part_id}", json={field: None})
        assert response.status_code == 422, f"{field}: expected 422, got {response.status_code}"

    # The part is untouched
    data = client.get(f"/api/parts/{part_id}").json()
    assert data["name"] == "Null Probe"


def test_update_part_explicit_null_clears_nullable_fields(client):
    """Explicit null remains the way to clear nullable fields."""
    parent_id = client.post("/api/parts", json={"name": "Parent Assembly"}).json()["id"]
    create_response = client.post(
        "/api/parts",
        json={"name": "Clearable", "category": "Electronics", "parent_id": parent_id},
    )
    part_id = create_response.json()["id"]

    response = client.patch(f"/api/parts/{part_id}", json={"parent_id": None, "category": None})
    assert response.status_code == 200

    data = response.json()
    assert data["parent_id"] is None
    assert data["category"] is None


def test_delete_part(client):
    """Test soft deleting a part."""
    create_response = client.post(
        "/api/parts",
        json={"name": "To Be Deleted"},
    )
    part_id = create_response.json()["id"]

    response = client.delete(f"/api/parts/{part_id}")
    assert response.status_code == 204

    # Part should not be found now (soft deleted)
    get_response = client.get(f"/api/parts/{part_id}")
    assert get_response.status_code == 404


def test_get_categories(client):
    """Test getting unique categories."""
    client.post("/api/parts", json={"name": "P1", "category": "Electronics"})
    client.post("/api/parts", json={"name": "P2", "category": "Mechanical"})
    client.post("/api/parts", json={"name": "P3", "category": "Electronics"})

    response = client.get("/api/parts/categories")
    assert response.status_code == 200

    categories = response.json()
    assert "Electronics" in categories
    assert "Mechanical" in categories


def test_is_tooling_honored_on_every_tier(client):
    """is_tooling is an explicit flag; no tier implies it (tiers are project-defined)."""
    fixture = client.post(
        "/api/parts",
        json={"name": "Torque Fixture", "tier": 2, "is_tooling": False},
    ).json()
    assert fixture["is_tooling"] is False

    flight = client.post("/api/parts", json={"name": "Flight Bracket", "tier": 1}).json()
    assert flight["is_tooling"] is False

    loose = client.post(
        "/api/parts", json={"name": "Bench Meter", "tier": 3, "is_tooling": True}
    ).json()
    assert loose["is_tooling"] is True


# ============ Variants ============


@pytest.fixture
def variant_project(monkeypatch) -> ProjectConfig:
    project = ProjectConfig(
        name="Variant Project",
        tiers=[TierConfig(level=1, name="Flight", code="F")],
        part_numbering=PartNumberingConfig(
            prefix="RV",
            format="{prefix}{sep}{tier_code}{sep}{sequence}{sep}{variant}",
        ),
    )
    monkeypatch.setattr(config_mod, "_active_project", project)
    return project


def test_create_variant_copies_attributes_and_bom(client, db_session, variant_project):
    component = client.post("/api/parts", json={"name": "Bolt", "tier": 1}).json()
    source = client.post(
        "/api/parts",
        json={
            "name": "Bracket Assembly",
            "tier": 1,
            "category": "Structures",
            "description": "Primary bracket",
            "external_pn": "EXT-77",
        },
    ).json()
    assert source["internal_pn"] == "RV-F-0002-001"

    db_session.add(
        BOMLine(
            assembly_id=source["id"],
            component_id=component["id"],
            quantity=4,
            reference_designator="B1-B4",
        )
    )
    db_session.commit()

    response = client.post(f"/api/parts/{source['id']}/variants")
    assert response.status_code == 201, response.text
    variant = response.json()

    assert variant["internal_pn"] == "RV-F-0002-002"
    assert variant["id"] != source["id"]
    assert variant["name"] == "Bracket Assembly"
    assert variant["category"] == "Structures"
    assert variant["description"] == "Primary bracket"
    assert variant["external_pn"] == "EXT-77"
    assert variant["lifecycle_state"] == "draft"

    copied = db_session.query(BOMLine).filter(BOMLine.assembly_id == variant["id"]).all()
    assert [(line.component_id, line.quantity, line.reference_designator) for line in copied] == [
        (component["id"], 4, "B1-B4")
    ]

    # The tier sequence counter did not advance: the next new part takes 0003
    after = client.post("/api/parts", json={"name": "Next New", "tier": 1}).json()
    assert after["internal_pn"] == "RV-F-0003-001"


def test_create_variant_body_overrides(client, db_session, variant_project):
    component = client.post("/api/parts", json={"name": "Bolt", "tier": 1}).json()
    source = client.post(
        "/api/parts",
        json={
            "name": "Bracket Assembly",
            "tier": 1,
            "category": "Structures",
            "external_pn": "EXT-77",
        },
    ).json()
    db_session.add(BOMLine(assembly_id=source["id"], component_id=component["id"], quantity=2))
    db_session.commit()

    response = client.post(
        f"/api/parts/{source['id']}/variants",
        json={"name": "Bracket Assembly, Lightened", "description": "Pocketed variant"},
    )
    assert response.status_code == 201, response.text
    variant = response.json()

    assert variant["name"] == "Bracket Assembly, Lightened"
    assert variant["description"] == "Pocketed variant"
    # Omitted fields copy from the source; BOM still copies
    assert variant["category"] == "Structures"
    assert variant["external_pn"] == "EXT-77"
    assert db_session.query(BOMLine).filter(BOMLine.assembly_id == variant["id"]).count() == 1


def test_create_variant_explicit_null_clears(client, variant_project):
    source = client.post(
        "/api/parts", json={"name": "Src", "tier": 1, "external_pn": "EXT-1"}
    ).json()

    response = client.post(f"/api/parts/{source['id']}/variants", json={"external_pn": None})
    assert response.status_code == 201
    variant = response.json()
    assert variant["external_pn"] is None
    # A null name is "no opinion", never a cleared NOT NULL column
    assert variant["name"] == "Src"


def test_create_variant_bad_parent_rejected(client, variant_project):
    source = client.post("/api/parts", json={"name": "Src", "tier": 1}).json()
    response = client.post(f"/api/parts/{source['id']}/variants", json={"parent_id": 99999})
    assert response.status_code == 400


def test_create_variant_rejected_without_variant_format(client):
    # Fallback numbering (no project config) has no {variant} placeholder
    source = client.post("/api/parts", json={"name": "Plain", "tier": 1}).json()
    response = client.post(f"/api/parts/{source['id']}/variants")
    assert response.status_code == 400
    assert "{variant}" in response.json()["detail"]


def test_create_variant_unknown_part_404(client, variant_project):
    response = client.post("/api/parts/99999/variants")
    assert response.status_code == 404


def test_create_variant_from_legacy_base_pn(client, db_session, variant_project):
    # Pre-variant PN: the base is implicit variant 1, first variant mints -002
    legacy = Part(name="Legacy", internal_pn="RV-F-0001", tier=1)
    db_session.add(legacy)
    db_session.commit()

    response = client.post(f"/api/parts/{legacy.id}/variants")
    assert response.status_code == 201, response.text
    assert response.json()["internal_pn"] == "RV-F-0001-002"


def test_create_variant_rejects_unparseable_pn(client, db_session, variant_project):
    odd = Part(name="Odd", internal_pn="WIDGET-9", tier=1)
    db_session.add(odd)
    db_session.commit()

    response = client.post(f"/api/parts/{odd.id}/variants")
    assert response.status_code == 422
    assert "WIDGET-9" in response.json()["detail"]
