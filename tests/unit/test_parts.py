"""Parts API tests."""


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


# ---- Page-facing behaviour ----


def test_list_parts_paginates_and_reports_total(client):
    for i in range(5):
        client.post("/api/parts", json={"name": f"Paged {i}"})
    page = client.get("/api/parts?search=Paged&limit=2&skip=2&sort_by=name&sort_order=asc").json()
    assert page["total"] == 5
    assert [p["name"] for p in page["items"]] == ["Paged 2", "Paged 3"]


def test_list_parts_sorts_by_stock_and_filters_low_stock(client):
    low = client.post(
        "/api/parts", json={"name": "Stock Low", "tier": 3, "reorder_point": 10}
    ).json()
    full = client.post(
        "/api/parts", json={"name": "Stock Full", "tier": 3, "reorder_point": 1}
    ).json()
    client.post(f"/api/parts/{low['id']}/activate", json={})
    client.post(f"/api/parts/{full['id']}/activate", json={})
    for part, qty in ((low, 2), (full, 50)):
        resp = client.post(
            "/api/inventory", json={"part_id": part["id"], "quantity": qty, "location": "BIN-1"}
        )
        assert resp.status_code == 201, resp.text

    ordered = client.get("/api/parts?search=Stock&sort_by=stock&sort_order=desc").json()["items"]
    assert [p["name"] for p in ordered] == ["Stock Full", "Stock Low"]
    assert float(ordered[0]["total_quantity"]) == 50

    only_low = client.get("/api/parts?search=Stock&low_stock=true").json()["items"]
    assert [p["name"] for p in only_low] == ["Stock Low"]
    assert only_low[0]["is_low_stock"] is True


def test_list_parts_has_parent_filter(client):
    parent = client.post("/api/parts", json={"name": "HP Parent"}).json()
    child = client.post("/api/parts", json={"name": "HP Child", "parent_id": parent["id"]}).json()
    subs = client.get("/api/parts?search=HP&has_parent=true").json()["items"]
    assert [p["id"] for p in subs] == [child["id"]]
    tops = client.get("/api/parts?search=HP&has_parent=false").json()["items"]
    assert [p["id"] for p in tops] == [parent["id"]]


def test_part_cannot_be_parented_under_its_own_descendant(client):
    top = client.post("/api/parts", json={"name": "Cycle Top"}).json()
    mid = client.post("/api/parts", json={"name": "Cycle Mid", "parent_id": top["id"]}).json()
    resp = client.patch(f"/api/parts/{top['id']}", json={"parent_id": mid["id"]})
    assert resp.status_code == 400


def test_parent_can_be_cleared(client):
    top = client.post("/api/parts", json={"name": "Clear Top"}).json()
    kid = client.post("/api/parts", json={"name": "Clear Kid", "parent_id": top["id"]}).json()
    cleared = client.patch(f"/api/parts/{kid['id']}", json={"parent_id": None}).json()
    assert cleared["parent_id"] is None


def test_import_uses_tier_default_tracking(client):
    resp = client.post(
        "/api/parts/import",
        json={
            "rows": [
                {"name": "Imp Flight", "tier": 1},
                {"name": "Imp Loose", "tier": 3},
            ]
        },
    )
    body = resp.json()
    assert body["created"] == 2
    assert body["errors"] == []
    assert body["first_pn"] and body["last_pn"]
    by_name = {p["name"]: p for p in client.get("/api/parts?search=Imp ").json()["items"]}
    assert by_name["Imp Flight"]["tracking_type"] == "serialized"
    assert by_name["Imp Loose"]["tracking_type"] == "bulk"


def test_import_preview_resolves_blank_tier(client):
    csv_body = "Name,Tracking\nPreview Blank,BULK\n"
    resp = client.post("/api/parts/import/preview", files={"file": ("p.csv", csv_body, "text/csv")})
    row = resp.json()["rows"][0]
    assert row["valid"] is True
    assert row["tier"] == 1
    assert row["tracking_type"] == "bulk"


def test_import_skips_duplicate_external_pn(client):
    client.post("/api/parts", json={"name": "Existing Widget", "external_pn": "EXT-DUP-1"})
    resp = client.post(
        "/api/parts/import",
        json={
            "rows": [
                {"name": "Different Name", "external_pn": "ext-dup-1"},
                {"name": "Fresh Name", "external_pn": "EXT-NEW"},
            ]
        },
    )
    body = resp.json()
    assert (body["created"], body["skipped"]) == (1, 1)


def test_tracking_cannot_change_once_stock_exists(client):
    part = client.post(
        "/api/parts", json={"name": "Tracked Thing", "tier": 3, "tracking_type": "bulk"}
    ).json()
    # A part with no stock may still change tracking
    resp = client.patch(f"/api/parts/{part['id']}", json={"tracking_type": "serialized"})
    assert resp.status_code == 200
    client.patch(f"/api/parts/{part['id']}", json={"tracking_type": "bulk"})
    client.post(f"/api/parts/{part['id']}/activate", json={})
    client.post("/api/inventory", json={"part_id": part["id"], "quantity": 5, "location": "A"})

    resp = client.patch(f"/api/parts/{part['id']}", json={"tracking_type": "serialized"})
    assert resp.status_code == 409
    assert "tracking cannot change" in resp.json()["detail"]
    # Same value is not a change
    resp = client.patch(f"/api/parts/{part['id']}", json={"tracking_type": "bulk"})
    assert resp.status_code == 200
