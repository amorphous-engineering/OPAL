"""Procedures API tests."""

from tests.conftest import user_headers


def test_create_procedure(client):
    """Test creating a new procedure."""
    response = client.post(
        "/api/procedures",
        json={
            "name": "Assembly Procedure",
            "description": "Steps for assembling widget",
        },
    )
    assert response.status_code == 201

    data = response.json()
    assert data["name"] == "Assembly Procedure"
    assert data["description"] == "Steps for assembling widget"
    assert data["status"] == "draft"
    assert "id" in data


def test_list_procedures(client):
    """Test listing procedures."""
    # Create procedures
    client.post("/api/procedures", json={"name": "Procedure A"})
    client.post("/api/procedures", json={"name": "Procedure B"})

    response = client.get("/api/procedures")
    assert response.status_code == 200

    data = response.json()
    assert data["total"] >= 2
    assert len(data["items"]) >= 2


def test_get_procedure(client):
    """Test getting a specific procedure."""
    create_response = client.post(
        "/api/procedures",
        json={"name": "Specific Procedure"},
    )
    proc_id = create_response.json()["id"]

    response = client.get(f"/api/procedures/{proc_id}")
    assert response.status_code == 200

    data = response.json()
    assert data["id"] == proc_id
    assert data["name"] == "Specific Procedure"


def test_update_procedure(client):
    """Test updating a procedure."""
    create_response = client.post(
        "/api/procedures",
        json={"name": "Original Name"},
    )
    proc_id = create_response.json()["id"]

    response = client.patch(
        f"/api/procedures/{proc_id}",
        json={"name": "Updated Name", "status": "deprecated"},
    )
    assert response.status_code == 200

    data = response.json()
    assert data["name"] == "Updated Name"
    assert data["status"] == "deprecated"


def test_delete_procedure(client):
    """Test soft deleting a procedure."""
    create_response = client.post(
        "/api/procedures",
        json={"name": "To Be Deleted"},
    )
    proc_id = create_response.json()["id"]

    response = client.delete(f"/api/procedures/{proc_id}")
    assert response.status_code == 204

    # Procedure should not be found now
    get_response = client.get(f"/api/procedures/{proc_id}")
    assert get_response.status_code == 404


def test_add_step(client):
    """Test adding a step to a procedure."""
    create_response = client.post(
        "/api/procedures",
        json={"name": "Step Test Procedure"},
    )
    proc_id = create_response.json()["id"]

    response = client.post(
        f"/api/procedures/{proc_id}/steps",
        json={
            "title": "First Step",
            "instructions": "Do the thing",
            "estimated_duration_minutes": 15,
        },
    )
    assert response.status_code == 201

    data = response.json()
    assert data["title"] == "First Step"
    assert data["order"] == 1
    assert data["estimated_duration_minutes"] == 15


def test_add_multiple_steps(client):
    """Test adding multiple steps maintains order."""
    create_response = client.post(
        "/api/procedures",
        json={"name": "Multi-Step Procedure"},
    )
    proc_id = create_response.json()["id"]

    # Add three steps
    client.post(f"/api/procedures/{proc_id}/steps", json={"title": "Step 1"})
    client.post(f"/api/procedures/{proc_id}/steps", json={"title": "Step 2"})
    step3_response = client.post(
        f"/api/procedures/{proc_id}/steps",
        json={"title": "Step 3"},
    )

    assert step3_response.json()["order"] == 3

    # Get procedure with steps
    response = client.get(f"/api/procedures/{proc_id}")
    data = response.json()
    assert len(data["steps"]) == 3


def test_update_step(client):
    """Test updating a step."""
    create_response = client.post(
        "/api/procedures",
        json={"name": "Update Step Procedure"},
    )
    proc_id = create_response.json()["id"]

    step_response = client.post(
        f"/api/procedures/{proc_id}/steps",
        json={"title": "Original Title"},
    )
    step_id = step_response.json()["id"]

    response = client.patch(
        f"/api/procedures/{proc_id}/steps/{step_id}",
        json={"title": "Updated Title", "is_contingency": True},
    )
    assert response.status_code == 200
    assert response.json()["title"] == "Updated Title"
    assert response.json()["is_contingency"] is True


def test_delete_step(client):
    """Test deleting a step reorders remaining steps."""
    create_response = client.post(
        "/api/procedures",
        json={"name": "Delete Step Procedure"},
    )
    proc_id = create_response.json()["id"]

    # Add three steps
    client.post(f"/api/procedures/{proc_id}/steps", json={"title": "Step 1"})
    step2 = client.post(f"/api/procedures/{proc_id}/steps", json={"title": "Step 2"}).json()
    client.post(f"/api/procedures/{proc_id}/steps", json={"title": "Step 3"})

    # Delete step 2
    delete_response = client.delete(f"/api/procedures/{proc_id}/steps/{step2['id']}")
    assert delete_response.status_code == 204

    # Check remaining steps are reordered
    proc_response = client.get(f"/api/procedures/{proc_id}")
    steps = proc_response.json()["steps"]
    assert len(steps) == 2
    assert steps[0]["title"] == "Step 1"
    assert steps[0]["order"] == 1
    assert steps[1]["title"] == "Step 3"
    assert steps[1]["order"] == 2


def test_publish_version(client):
    """Test publishing a procedure version."""
    create_response = client.post(
        "/api/procedures",
        json={"name": "Version Test Procedure"},
    )
    proc_id = create_response.json()["id"]

    # Add steps
    client.post(f"/api/procedures/{proc_id}/steps", json={"title": "Step 1"})
    client.post(f"/api/procedures/{proc_id}/steps", json={"title": "Step 2"})

    # Publish
    response = client.post(f"/api/procedures/{proc_id}/publish")
    assert response.status_code == 201

    data = response.json()
    assert data["version_number"] == 1

    # Procedure should now be active
    proc_response = client.get(f"/api/procedures/{proc_id}")
    assert proc_response.json()["status"] == "active"
    assert proc_response.json()["current_version_id"] == data["id"]


def test_cannot_publish_without_steps(client):
    """Test cannot publish procedure without steps."""
    create_response = client.post(
        "/api/procedures",
        json={"name": "Empty Procedure"},
    )
    proc_id = create_response.json()["id"]

    response = client.post(f"/api/procedures/{proc_id}/publish")
    assert response.status_code == 400


def test_list_versions(client):
    """Test listing procedure versions."""
    create_response = client.post(
        "/api/procedures",
        json={"name": "Multiple Versions"},
    )
    proc_id = create_response.json()["id"]

    # Add step and publish twice
    client.post(f"/api/procedures/{proc_id}/steps", json={"title": "Step 1"})
    client.post(f"/api/procedures/{proc_id}/publish")

    # Add another step and publish again
    client.post(f"/api/procedures/{proc_id}/steps", json={"title": "Step 2"})
    client.post(f"/api/procedures/{proc_id}/publish")

    response = client.get(f"/api/procedures/{proc_id}/versions")
    assert response.status_code == 200

    versions = response.json()
    assert len(versions) == 2
    assert versions[0]["version_number"] == 2  # Most recent first
    assert versions[1]["version_number"] == 1


def test_kit_crud(client):
    """Test kit (bill of materials) CRUD."""
    # Create procedure
    proc_response = client.post("/api/procedures", json={"name": "Kit Test Procedure"})
    proc_id = proc_response.json()["id"]

    # Create part
    part_response = client.post("/api/parts", json={"name": "Widget Part"})
    part_id = part_response.json()["id"]

    # Add to kit
    kit_response = client.post(
        f"/api/procedures/{proc_id}/kit",
        json={"part_id": part_id, "quantity_required": 2.5},
    )
    assert kit_response.status_code == 201
    assert kit_response.json()["quantity_required"] == 2.5

    # Get kit
    get_response = client.get(f"/api/procedures/{proc_id}/kit")
    assert get_response.status_code == 200
    assert len(get_response.json()) == 1

    # Remove from kit
    delete_response = client.delete(f"/api/procedures/{proc_id}/kit/{part_id}")
    assert delete_response.status_code == 204

    # Verify removed
    verify_response = client.get(f"/api/procedures/{proc_id}/kit")
    assert len(verify_response.json()) == 0


def test_update_procedure_type(client):
    """Test changing procedure_type from op to build persists correctly."""
    create_response = client.post(
        "/api/procedures",
        json={"name": "Build Procedure", "procedure_type": "op"},
    )
    assert create_response.status_code == 201
    proc_id = create_response.json()["id"]
    assert create_response.json()["procedure_type"] == "op"

    # PATCH to build
    patch_response = client.patch(
        f"/api/procedures/{proc_id}",
        json={"procedure_type": "build"},
    )
    assert patch_response.status_code == 200
    assert patch_response.json()["procedure_type"] == "build"

    # GET should also show build
    get_response = client.get(f"/api/procedures/{proc_id}")
    assert get_response.status_code == 200
    assert get_response.json()["procedure_type"] == "build"


def test_cannot_add_duplicate_kit_item(client):
    """Test cannot add same part twice to kit."""
    proc_response = client.post("/api/procedures", json={"name": "Duplicate Kit Test"})
    proc_id = proc_response.json()["id"]

    part_response = client.post("/api/parts", json={"name": "Unique Part"})
    part_id = part_response.json()["id"]

    # Add first time
    client.post(f"/api/procedures/{proc_id}/kit", json={"part_id": part_id, "quantity_required": 1})

    # Try to add again
    response = client.post(
        f"/api/procedures/{proc_id}/kit",
        json={"part_id": part_id, "quantity_required": 2},
    )
    assert response.status_code == 400


# --- Output BOM→Kit auto-population tests ---


def _create_assembly_with_bom(client, component_quantities: list[tuple[str, int]]):
    """Helper: create an assembly part with BOM lines. Returns (assembly_id, {name: part_id})."""
    assembly = client.post("/api/parts", json={"name": "Assembly"}).json()
    assembly_id = assembly["id"]
    parts = {}
    for name, qty in component_quantities:
        comp = client.post("/api/parts", json={"name": name}).json()
        parts[name] = comp["id"]
        client.post(
            f"/api/bom/assemblies/{assembly_id}",
            json={"component_id": comp["id"], "quantity": qty},
        )
    return assembly_id, parts


def test_add_output_auto_populates_kit_from_bom(client):
    """Adding an output part with a BOM should auto-populate kit items."""
    assembly_id, parts = _create_assembly_with_bom(client, [("Resistor", 4), ("Capacitor", 2)])
    proc = client.post("/api/procedures", json={"name": "Build Proc"}).json()
    proc_id = proc["id"]

    # Add assembly as output (quantity_produced defaults to 1)
    resp = client.post(
        f"/api/procedures/{proc_id}/outputs",
        json={"part_id": assembly_id},
    )
    assert resp.status_code == 201

    # Kit should now contain both BOM components
    kit = client.get(f"/api/procedures/{proc_id}/kit").json()
    kit_by_part = {item["part_id"]: item["quantity_required"] for item in kit}
    assert kit_by_part[parts["Resistor"]] == 4.0
    assert kit_by_part[parts["Capacitor"]] == 2.0


def test_add_output_accumulates_kit_qty_for_existing_items(client):
    """If a BOM component is already in the kit, its quantity should accumulate."""
    assembly_id, parts = _create_assembly_with_bom(client, [("Bolt", 3)])
    proc = client.post("/api/procedures", json={"name": "Accumulate Proc"}).json()
    proc_id = proc["id"]

    # Manually add Bolt to kit with qty 5
    client.post(
        f"/api/procedures/{proc_id}/kit",
        json={"part_id": parts["Bolt"], "quantity_required": 5},
    )

    # Add output → should add 3 more
    client.post(
        f"/api/procedures/{proc_id}/outputs",
        json={"part_id": assembly_id},
    )

    kit = client.get(f"/api/procedures/{proc_id}/kit").json()
    kit_by_part = {item["part_id"]: item["quantity_required"] for item in kit}
    assert kit_by_part[parts["Bolt"]] == 8.0  # 5 + 3


def test_add_output_no_bom_no_kit_changes(client):
    """Adding an output part with no BOM should not create any kit items."""
    part = client.post("/api/parts", json={"name": "Simple Part"}).json()
    proc = client.post("/api/procedures", json={"name": "No BOM Proc"}).json()
    proc_id = proc["id"]

    client.post(
        f"/api/procedures/{proc_id}/outputs",
        json={"part_id": part["id"]},
    )

    kit = client.get(f"/api/procedures/{proc_id}/kit").json()
    assert len(kit) == 0


def test_add_output_multiplies_bom_qty_by_output_qty(client):
    """Kit quantities should be bom_qty * output quantity_produced."""
    assembly_id, parts = _create_assembly_with_bom(client, [("Screw", 2)])
    proc = client.post("/api/procedures", json={"name": "Multiply Proc"}).json()
    proc_id = proc["id"]

    client.post(
        f"/api/procedures/{proc_id}/outputs",
        json={"part_id": assembly_id, "quantity_produced": 3},
    )

    kit = client.get(f"/api/procedures/{proc_id}/kit").json()
    kit_by_part = {item["part_id"]: item["quantity_required"] for item in kit}
    assert kit_by_part[parts["Screw"]] == 6.0  # 2 * 3


# ============ Operation dependencies + gating ============


def _make_proc_with_n_ops(client, n: int = 3) -> tuple[int, list[int]]:
    """Create a procedure with N top-level ops, return (proc_id, [op_id, ...])."""
    proc = client.post("/api/procedures", json={"name": "Dep Test"}).json()
    proc_id = proc["id"]
    op_ids: list[int] = []
    for i in range(1, n + 1):
        s = client.post(f"/api/procedures/{proc_id}/steps", json={"title": f"OP {i}"}).json()
        op_ids.append(s["id"])
    return proc_id, op_ids


def test_set_and_list_dependencies(client):
    """PUT /steps/{id}/dependencies stores edges; GET /dependencies returns them."""
    proc_id, op_ids = _make_proc_with_n_ops(client, 3)
    # OP 3 depends on OP 1 and OP 2
    r = client.put(
        f"/api/procedures/{proc_id}/steps/{op_ids[2]}/dependencies",
        json={"depends_on": [op_ids[0], op_ids[1]]},
    )
    assert r.status_code == 200
    listing = client.get(f"/api/procedures/{proc_id}/dependencies").json()
    edges = {(d["step_id"], d["depends_on_step_id"]) for d in listing}
    assert edges == {(op_ids[2], op_ids[0]), (op_ids[2], op_ids[1])}


def test_dependency_self_loop_rejected(client):
    proc_id, op_ids = _make_proc_with_n_ops(client, 2)
    r = client.put(
        f"/api/procedures/{proc_id}/steps/{op_ids[0]}/dependencies",
        json={"depends_on": [op_ids[0]]},
    )
    assert r.status_code == 400
    assert "itself" in r.json()["detail"].lower()


def test_dependency_cycle_rejected(client):
    """Existing edge A→B; adding B→A creates a cycle and must be rejected."""
    proc_id, op_ids = _make_proc_with_n_ops(client, 2)
    # B (op 2) depends on A (op 1)
    client.put(
        f"/api/procedures/{proc_id}/steps/{op_ids[1]}/dependencies",
        json={"depends_on": [op_ids[0]]},
    )
    # Try to add reverse: A depends on B
    r = client.put(
        f"/api/procedures/{proc_id}/steps/{op_ids[0]}/dependencies",
        json={"depends_on": [op_ids[1]]},
    )
    assert r.status_code == 400
    assert "cycle" in r.json()["detail"].lower()


def test_published_version_snapshots_dependencies(client):
    """When a procedure is published, dep edges land in version content as
    `depends_on: [order, ...]` on each op's snapshot."""
    proc_id, op_ids = _make_proc_with_n_ops(client, 3)
    client.put(
        f"/api/procedures/{proc_id}/steps/{op_ids[2]}/dependencies",
        json={"depends_on": [op_ids[0], op_ids[1]]},
    )
    publish = client.post(f"/api/procedures/{proc_id}/publish").json()
    version_id = publish["id"]
    # Pull the version content via the version endpoint
    version = client.get(f"/api/procedures/versions/{version_id}").json()
    steps = version["content"]["steps"]
    op3 = next(s for s in steps if s["title"] == "OP 3")
    assert sorted(op3["depends_on"]) == sorted(
        [
            next(s["order"] for s in steps if s["title"] == "OP 1"),
            next(s["order"] for s in steps if s["title"] == "OP 2"),
        ]
    )


def test_reorder_renumbers_step_labels(client):
    """After a reorder the step_number display labels follow the new sequence:
    normal ops → 1, 2, 3...; contingency ops → C1, C2...; sub-steps → <op>.N."""
    proc = client.post("/api/procedures", json={"name": "Renumber Test"}).json()
    proc_id = proc["id"]
    a = client.post(f"/api/procedures/{proc_id}/steps", json={"title": "A"}).json()
    b = client.post(f"/api/procedures/{proc_id}/steps", json={"title": "B"}).json()
    c = client.post(f"/api/procedures/{proc_id}/steps", json={"title": "C"}).json()
    # Sub-step under B
    b1 = client.post(
        f"/api/procedures/{proc_id}/steps",
        json={"title": "B.1", "parent_step_id": b["id"]},
    ).json()

    # Initial labels
    initial = {
        s["title"]: s["step_number"]
        for s in client.get(f"/api/procedures/{proc_id}").json()["steps"]
    }
    assert initial["A"] == "1"
    assert initial["B"] == "2"
    assert initial["C"] == "3"

    # Reorder to: C, A, B(+B.1)
    new_order = [c["id"], a["id"], b["id"], b1["id"]]
    r = client.post(f"/api/procedures/{proc_id}/steps/reorder", json={"step_ids": new_order})
    assert r.status_code == 200

    # /api/procedures/{id} returns a hierarchical structure: top-level
    # steps with nested sub_steps. Flatten for lookup.
    top = client.get(f"/api/procedures/{proc_id}").json()["steps"]
    flat = []
    for s in top:
        flat.append(s)
        flat.extend(s.get("sub_steps", []))
    labels = {s["title"]: s["step_number"] for s in flat}
    assert labels["C"] == "1"
    assert labels["A"] == "2"
    assert labels["B"] == "3"
    # Sub-step inherits parent's new number
    assert labels["B.1"] == "3.1"


def test_execution_gating_blocks_complete_until_prereqs_complete(client):
    """OP 2 (deps on OP 1) cannot be completed until OP 1 is completed."""
    proc_id, op_ids = _make_proc_with_n_ops(client, 2)
    client.put(
        f"/api/procedures/{proc_id}/steps/{op_ids[1]}/dependencies",
        json={"depends_on": [op_ids[0]]},
    )
    client.post(f"/api/procedures/{proc_id}/publish")

    inst = client.post("/api/procedure-instances", json={"procedure_id": proc_id}).json()
    instance_id = inst["id"]

    # Attempt to complete OP 2 first → blocked on the declared dependency.
    r = client.post(f"/api/procedure-instances/{instance_id}/steps/2/complete", json={})
    assert r.status_code == 400
    assert "Waiting on OP" in r.json()["detail"]

    # Complete OP 1, then OP 2's COMPLETE succeeds.
    assert (
        client.post(f"/api/procedure-instances/{instance_id}/steps/1/complete", json={}).status_code
        == 200
    )
    assert (
        client.post(f"/api/procedure-instances/{instance_id}/steps/2/complete", json={}).status_code
        == 200
    )


# ============ Photo / inline-image attachments ============


def test_upload_attachment_with_procedure_id(client, test_user):
    """An attachment uploaded with procedure_id persists the FK so it
    cascade-deletes with the procedure."""
    proc = client.post("/api/procedures", json={"name": "Image Test"}).json()
    proc_id = proc["id"]

    r = client.post(
        "/api/attachments/upload",
        files={"file": ("ref.png", b"\x89PNG\r\n\x1a\nfake", "image/png")},
        data={"procedure_id": str(proc_id)},
        headers=user_headers(test_user),
    )
    assert r.status_code == 201
    data = r.json()
    assert data["procedure_id"] == proc_id
    assert data["mime_type"] == "image/png"


def test_reference_docs_filter_excludes_inline_images(client, test_user):
    """GET /api/attachments?procedure_id=N&kind=reference returns only the
    reference-doc uploads, not inline images."""
    proc = client.post("/api/procedures", json={"name": "Docs Test"}).json()
    proc_id = proc["id"]
    headers = user_headers(test_user)

    # Upload one inline image and one reference doc on the same procedure.
    r1 = client.post(
        "/api/attachments/upload",
        files={"file": ("inline.png", b"\x89PNG\r\n\x1a\nfake", "image/png")},
        data={"procedure_id": str(proc_id), "kind": "inline"},
        headers=headers,
    )
    assert r1.status_code == 201
    inline_id = r1.json()["id"]

    r2 = client.post(
        "/api/attachments/upload",
        files={"file": ("drawing.pdf", b"%PDF-fake", "application/pdf")},
        data={"procedure_id": str(proc_id), "kind": "reference"},
        headers=headers,
    )
    assert r2.status_code == 201
    ref_id = r2.json()["id"]
    assert r2.json()["kind"] == "reference"

    # Filtered list returns only the reference doc.
    listing = client.get(f"/api/attachments?procedure_id={proc_id}&kind=reference").json()
    ids = {a["id"] for a in listing}
    assert ref_id in ids
    assert inline_id not in ids


def test_photo_field_round_trips_through_publish(client):
    """A required_data_schema field of type=photo persists on the step and
    is included in the published version snapshot."""
    proc = client.post("/api/procedures", json={"name": "Photo Schema Test"}).json()
    proc_id = proc["id"]
    step = client.post(f"/api/procedures/{proc_id}/steps", json={"title": "Inspect"}).json()
    step_id = step["id"]

    # Save a schema with both a single-photo and a multi-photo field.
    schema = {
        "fields": [
            {
                "name": "witness_photo",
                "label": "Witness Photo",
                "type": "photo",
                "required": True,
                "multiple": False,
            },
            {
                "name": "defect_photos",
                "label": "Defect Photos",
                "type": "photo",
                "required": False,
                "multiple": True,
            },
        ]
    }
    r = client.patch(
        f"/api/procedures/{proc_id}/steps/{step_id}",
        json={"required_data_schema": schema},
    )
    assert r.status_code == 200
    # Round-trip via the procedure detail
    top = client.get(f"/api/procedures/{proc_id}").json()["steps"]
    saved = top[0]["required_data_schema"]
    assert saved == schema

    # Publish; snapshot must include both photo fields with their multiple flags.
    publish = client.post(f"/api/procedures/{proc_id}/publish").json()
    version = client.get(f"/api/procedures/versions/{publish['id']}").json()
    snap_fields = version["content"]["steps"][0]["required_data_schema"]["fields"]
    assert snap_fields[0]["type"] == "photo"
    assert snap_fields[0]["required"] is True
    assert snap_fields[0]["multiple"] is False
    assert snap_fields[1]["multiple"] is True


def test_step_safety_fields_round_trip(client):
    """required_role and caution persist through create, update, and detail."""
    proc_id = client.post("/api/procedures", json={"name": "Safety Fields"}).json()["id"]

    step = client.post(
        f"/api/procedures/{proc_id}/steps",
        json={
            "title": "Pressurize",
            "required_role": "QE",
            "caution": "High voltage present",
        },
    ).json()
    assert step["required_role"] == "QE"
    assert step["caution"] == "High voltage present"

    # Update both fields
    r = client.patch(
        f"/api/procedures/{proc_id}/steps/{step['id']}",
        json={"required_role": "MFG-LEAD", "caution": "Pinch hazard"},
    )
    assert r.status_code == 200
    assert r.json()["required_role"] == "MFG-LEAD"
    assert r.json()["caution"] == "Pinch hazard"

    # Round-trip via the procedure detail
    top = client.get(f"/api/procedures/{proc_id}").json()["steps"]
    assert top[0]["required_role"] == "MFG-LEAD"
    assert top[0]["caution"] == "Pinch hazard"

    # Explicit null clears; omitted field is untouched
    r = client.patch(
        f"/api/procedures/{proc_id}/steps/{step['id']}",
        json={"caution": None},
    )
    assert r.status_code == 200
    assert r.json()["caution"] is None
    assert r.json()["required_role"] == "MFG-LEAD"


def test_publish_snapshots_safety_fields(client):
    """Published version content includes required_role and caution per step."""
    proc_id = client.post("/api/procedures", json={"name": "Safety Snapshot"}).json()["id"]
    client.post(
        f"/api/procedures/{proc_id}/steps",
        json={"title": "Hot work", "required_role": "QE", "caution": "Hot surfaces"},
    )
    client.post(f"/api/procedures/{proc_id}/steps", json={"title": "No safety fields"})

    publish = client.post(f"/api/procedures/{proc_id}/publish").json()
    version = client.get(f"/api/procedures/versions/{publish['id']}").json()
    steps = version["content"]["steps"]
    assert steps[0]["required_role"] == "QE"
    assert steps[0]["caution"] == "Hot surfaces"
    assert steps[1]["required_role"] is None
    assert steps[1]["caution"] is None


def test_add_step_image_upload(client):
    """POST .../steps/{id}/images uploads an authored reference image.

    Regression: add_step_image calls upload_attachment as a plain function,
    so the omitted Form(...) parameters must be passed as explicit None —
    otherwise the truthy Form sentinels reach the entity-validation queries
    and every upload 500s.
    """
    proc_id = client.post("/api/procedures", json={"name": "Img Proc"}).json()["id"]
    step_id = client.post(
        f"/api/procedures/{proc_id}/steps", json={"title": "Step with image"}
    ).json()["id"]

    resp = client.post(
        f"/api/procedures/{proc_id}/steps/{step_id}/images",
        files={"file": ("diagram.png", b"\x89PNG\r\n\x1a\n", "image/png")},
        data={"caption": "wiring diagram"},
    )
    assert resp.status_code == 201, resp.text
    assert resp.json()["caption"] == "wiring diagram"

    listed = client.get(f"/api/procedures/{proc_id}/steps/{step_id}/images").json()
    assert len(listed) == 1
    assert listed[0]["caption"] == "wiring diagram"


# ============ Template list, activation, versions, diff, print ============


def _published(client, name="Pub", steps=("A", "B"), **extra):
    proc = client.post("/api/procedures", json={"name": name, **extra}).json()
    for t in steps:
        client.post(f"/api/procedures/{proc['id']}/steps", json={"title": t})
    v = client.post(f"/api/procedures/{proc['id']}/publish").json()
    return proc["id"], v


def test_list_rows_carry_version_and_counts(client):
    proc_id, v = _published(client, "Counted")
    client.post("/api/procedures", json={"name": "Draft Build", "procedure_type": "build"})
    client.post("/api/procedure-instances", json={"procedure_id": proc_id})

    items = {i["name"]: i for i in client.get("/api/procedures").json()["items"]}
    counted = items["Counted"]
    assert counted["current_version_number"] == 1
    assert counted["step_count"] == 2
    assert counted["execution_count"] == 1
    assert "steps" not in counted
    assert items["Draft Build"]["current_version_number"] is None
    assert items["Draft Build"]["procedure_type"] == "build"


def test_list_filters_and_sorts(client):
    _published(client, "Zeta Op")
    client.post("/api/procedures", json={"name": "Alpha Build", "procedure_type": "build"})

    builds = client.get("/api/procedures", params={"procedure_type": "build"}).json()
    assert [i["name"] for i in builds["items"]] == ["Alpha Build"]
    active = client.get("/api/procedures", params={"status": "active"}).json()
    assert [i["name"] for i in active["items"]] == ["Zeta Op"]
    by_name = client.get("/api/procedures", params={"sort": "name", "dir": "asc"}).json()
    assert [i["name"] for i in by_name["items"]] == ["Alpha Build", "Zeta Op"]
    assert client.get("/api/procedures", params={"sort": "bogus"}).status_code == 400


def test_activate_requires_published_version(client):
    proc = client.post("/api/procedures", json={"name": "Unpublished"}).json()
    r = client.patch(f"/api/procedures/{proc['id']}", json={"status": "active"})
    assert r.status_code == 400
    # After publish, deprecate then re-activate is allowed
    proc_id, _ = _published(client, "Cycle")
    assert (
        client.patch(f"/api/procedures/{proc_id}", json={"status": "deprecated"}).status_code == 200
    )
    r = client.patch(f"/api/procedures/{proc_id}", json={"status": "active"})
    assert r.status_code == 200 and r.json()["status"] == "active"


def test_publish_change_note_and_version_metadata(client):
    proc = client.post("/api/procedures", json={"name": "Noted"}).json()
    pid = proc["id"]
    client.post(f"/api/procedures/{pid}/steps", json={"title": "Only"})
    v1 = client.post(f"/api/procedures/{pid}/publish", json={"change_note": "  first cut "}).json()
    assert v1["change_note"] == "first cut"
    assert v1["step_count"] == 1
    assert v1["created_by_name"]
    v2 = client.post(f"/api/procedures/{pid}/publish").json()
    assert v2["change_note"] is None

    listed = client.get(f"/api/procedures/{pid}/versions").json()
    assert [v["version_number"] for v in listed] == [2, 1]
    assert listed[1]["change_note"] == "first cut"

    detail = client.get(f"/api/procedures/versions/{v1['id']}").json()
    assert detail["procedure_id"] == pid
    assert detail["procedure_name"] == "Noted"
    assert detail["is_current"] is False
    assert client.get(f"/api/procedures/versions/{v2['id']}").json()["is_current"] is True


def test_version_detail_names_kit_and_output_parts(client):
    assembly_id, parts = _create_assembly_with_bom(client, [("Rivet", 2)])
    proc = client.post("/api/procedures", json={"name": "Parted", "procedure_type": "build"}).json()
    client.post(f"/api/procedures/{proc['id']}/steps", json={"title": "Build"})
    client.post(f"/api/procedures/{proc['id']}/outputs", json={"part_id": assembly_id})
    # Draft parts block publish; activate everything referenced
    for pid in (assembly_id, parts["Rivet"]):
        client.post(f"/api/parts/{pid}/activate", json={"cause": "test"})
    v = client.post(f"/api/procedures/{proc['id']}/publish").json()
    detail = client.get(f"/api/procedures/versions/{v['id']}").json()
    by_id = {p["id"]: p for p in detail["parts"]}
    assert by_id[parts["Rivet"]]["name"] == "Rivet"
    assert assembly_id in by_id


def test_unpublished_changes_flag(client):
    proc_id, _ = _published(client, "Flagged")
    assert client.get(f"/api/procedures/{proc_id}").json()["unpublished_changes"] is False
    client.post(f"/api/procedures/{proc_id}/steps", json={"title": "C"})
    assert client.get(f"/api/procedures/{proc_id}").json()["unpublished_changes"] is True
    fresh = client.post("/api/procedures", json={"name": "Fresh"}).json()
    assert client.get(f"/api/procedures/{fresh['id']}").json()["unpublished_changes"] is None


def test_restore_clears_unpublished_changes(client):
    proc_id, v = _published(client, "Restorable")
    client.post(f"/api/procedures/{proc_id}/steps", json={"title": "Extra"})
    assert client.get(f"/api/procedures/{proc_id}").json()["unpublished_changes"] is True
    r = client.post(f"/api/procedures/{proc_id}/versions/{v['id']}/restore")
    assert r.status_code == 200
    assert client.get(f"/api/procedures/{proc_id}").json()["unpublished_changes"] is False


def test_version_diff_endpoint(client):
    proc_id, v1 = _published(client, "Diffed", steps=("Prep", "Run"))
    steps = client.get(f"/api/procedures/{proc_id}").json()["steps"]
    run = next(s for s in steps if s["title"] == "Run")
    client.patch(
        f"/api/procedures/{proc_id}/steps/{run['id']}",
        json={"title": "Run", "requires_signoff": True},
    )
    client.post(f"/api/procedures/{proc_id}/steps", json={"title": "Clean"})
    comp = client.post("/api/parts", json={"name": "Glue"}).json()
    client.post(f"/api/parts/{comp['id']}/activate", json={"cause": "test"})
    client.post(
        f"/api/procedures/{proc_id}/kit", json={"part_id": comp["id"], "quantity_required": 2}
    )
    client.patch(f"/api/procedures/{proc_id}", json={"name": "Diffed 2"})
    v2 = client.post(f"/api/procedures/{proc_id}/publish", json={"change_note": "tweaks"}).json()

    r = client.get(f"/api/procedures/{proc_id}/versions/{v1['id']}/diff/{v2['id']}")
    assert r.status_code == 200
    d = r.json()
    assert d["version_a"]["version_number"] == 1 and d["version_b"]["version_number"] == 2
    assert d["added"] == 1 and d["modified"] == 1 and d["unchanged"] == 1 and d["removed"] == 0
    by_num = {s["step_number"]: s for s in d["steps"]}
    assert by_num["2"]["changed_fields"] == ["requires_signoff", "signoffs"]
    assert by_num["2"]["changes"]["requires_signoff"] == {"a": False, "b": True}
    assert by_num["3"]["status"] == "added"
    assert len(d["kit"]) == 1
    assert d["kit"][0]["name"] == "Glue"
    assert d["kit"][0]["status"] == "added"
    assert d["kit"][0]["quantity_b"] == 2.0
    assert d["procedure_changes"][0]["field"] == "procedure_name"
    assert d["procedure_changes"][0]["b"] == "Diffed 2"


def test_version_diff_rejects_foreign_version(client):
    a, va = _published(client, "A proc")
    _, vb = _published(client, "B proc")
    r = client.get(f"/api/procedures/{a}/versions/{va['id']}/diff/{vb['id']}")
    assert r.status_code == 404


def test_version_qr_svg(client):
    _, v = _published(client, "QR")
    r = client.get(
        f"/api/procedures/versions/{v['id']}/qr", params={"url": "http://x/procedures/versions/1"}
    )
    assert r.status_code == 200
    assert r.headers["content-type"].startswith("image/svg+xml")
    assert b"<svg" in r.content
    assert client.get("/api/procedures/versions/99999/qr", params={"url": "x"}).status_code == 404


def test_clone_keeps_type_and_dependencies(client):
    proc_id, op_ids = _make_proc_with_n_ops(client, 2)
    client.patch(f"/api/procedures/{proc_id}", json={"procedure_type": "build"})
    client.put(
        f"/api/procedures/{proc_id}/steps/{op_ids[1]}/dependencies",
        json={"depends_on": [op_ids[0]]},
    )
    clone = client.post(f"/api/procedures/{proc_id}/clone", json={}).json()
    assert clone["procedure_type"] == "build"
    assert len(client.get(f"/api/procedures/{clone['id']}/dependencies").json()) == 1


def test_delete_blocked_by_open_execution(client):
    proc_id, _ = _published(client, "Busy")
    client.post("/api/procedure-instances", json={"procedure_id": proc_id})
    r = client.delete(f"/api/procedures/{proc_id}")
    assert r.status_code == 409


def test_kit_rows_carry_part_number_and_stock(client):
    proc = client.post("/api/procedures", json={"name": "Kitted"}).json()
    part = client.post("/api/parts", json={"name": "Washer"}).json()
    row = client.post(
        f"/api/procedures/{proc['id']}/kit", json={"part_id": part["id"], "quantity_required": 3}
    ).json()
    assert row["part_internal_pn"] == part["internal_pn"]
    assert row["part_lifecycle_state"] == "draft"
    assert row["part_on_hand"] == 0


def test_diff_part_lists_and_equivalence():
    from opal.core.diff import diff_part_lists, snapshots_equivalent

    rows = diff_part_lists(
        [{"part_id": 1, "quantity_required": 1}, {"part_id": 2, "quantity_required": 2}],
        [{"part_id": 2, "quantity_required": 5}, {"part_id": 3, "quantity_required": 1}],
    )
    assert [(r["part_id"], r["status"]) for r in rows] == [
        (1, "removed"),
        (2, "modified"),
        (3, "added"),
    ]

    a = {
        "procedure_name": "P",
        "steps": [
            {"id": 1, "order": 1, "parent_step_id": None, "title": "T"},
            {"id": 2, "order": 2, "parent_step_id": 1, "title": "S"},
        ],
    }
    b = {
        "procedure_name": "P",
        "steps": [
            {"id": 10, "order": 1, "parent_step_id": None, "title": "T"},
            {"id": 11, "order": 2, "parent_step_id": 10, "title": "S"},
        ],
    }
    assert snapshots_equivalent(a, b)
    b["steps"][1]["title"] = "changed"
    assert not snapshots_equivalent(a, b)


def test_cannot_cut_work_order_from_deprecated_template(client):
    proc_id, _ = _published(client, "Retired")
    client.patch(f"/api/procedures/{proc_id}", json={"status": "deprecated"})
    r = client.post("/api/procedure-instances", json={"procedure_id": proc_id})
    assert r.status_code == 400
    client.patch(f"/api/procedures/{proc_id}", json={"status": "active"})
    r = client.post("/api/procedure-instances", json={"procedure_id": proc_id})
    assert r.status_code == 201


def test_version_detail_carries_effective_signoffs(client):
    proc = client.post("/api/procedures", json={"name": "Signed"}).json()
    pid = proc["id"]
    step = client.post(f"/api/procedures/{pid}/steps", json={"title": "Run"}).json()
    client.patch(
        f"/api/procedures/{pid}/steps/{step['id']}",
        json={"signoffs": [{"label": "Primary", "role": "QE"}, {"label": "Second", "role": None}]},
    )
    v = client.post(f"/api/procedures/{pid}/publish").json()
    steps = client.get(f"/api/procedures/versions/{v['id']}").json()["content"]["steps"]
    assert steps[0]["signoffs"] == [
        {"label": "Primary", "role": "QE"},
        {"label": "Second", "role": None},
    ]
