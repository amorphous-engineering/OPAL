"""Part identity lifecycle tests: draft birth, deliberate activation, guarded writes.

Parts are born draft and become active only by deliberate activation;
physical/financial writes refuse draft parts with a structured 409
(error=draft_parts_blocked). Design-time references (BOM, kits) stay legal.
"""

import asyncio
import json
from datetime import UTC, datetime, timedelta
from typing import Any

from opal.db.models import Part, Supplier
from opal.db.models.audit import AuditAction, AuditLog
from opal.mcp import server
from opal.se.dashboard import stale_draft_parts


def _create_part(client, name: str, **extra) -> dict:
    """Create a part via the API; parts are born draft."""
    response = client.post("/api/parts", json={"name": name, **extra})
    assert response.status_code == 201, response.text
    return response.json()


def _activate(client, part_id: int, cause: str | None = None) -> dict:
    body = {"cause": cause} if cause else {}
    response = client.post(f"/api/parts/{part_id}/activate", json=body)
    assert response.status_code == 200, response.text
    return response.json()


def _call(handler, db, args: dict) -> dict[str, Any]:
    """Run an MCP handler coroutine and return the parsed JSON payload."""
    result = asyncio.run(handler(db, args))
    assert len(result) == 1
    return json.loads(result[0].text)


def _assert_blocked(response, part: dict) -> dict:
    """Assert a 409 draft_parts_blocked payload naming `part`; return the detail."""
    assert response.status_code == 409, response.text
    detail = response.json()["detail"]
    assert detail["error"] == "draft_parts_blocked"
    blocked = {(p["id"], p["internal_pn"]) for p in detail["draft_parts"]}
    assert (part["id"], part["internal_pn"]) in blocked
    assert detail["remedy"]
    return detail


# ============ Birth ============


def test_parts_are_born_draft(client):
    part = _create_part(client, "Newborn Bracket")
    assert part["lifecycle_state"] == "draft"
    assert part["activated_at"] is None
    assert part["activation_cause"] is None


def test_list_parts_state_filter(client):
    draft = _create_part(client, "Draft Filter Part")

    drafts = client.get("/api/parts?state=draft").json()
    assert draft["id"] in {p["id"] for p in drafts["items"]}

    actives = client.get("/api/parts?state=active").json()
    assert draft["id"] not in {p["id"] for p in actives["items"]}

    response = client.get("/api/parts?state=bogus")
    assert response.status_code == 400


# ============ Activation ============


def test_activate_part_default_cause(client, db_session):
    part = _create_part(client, "To Activate")

    activated = _activate(client, part["id"])
    assert activated["lifecycle_state"] == "active"
    assert activated["activated_at"] is not None
    assert activated["activation_cause"] == "manual activation from part page"

    # Activation leaves an UPDATE audit row carrying the new state
    rows = (
        db_session.query(AuditLog)
        .filter(
            AuditLog.table_name == "part",
            AuditLog.record_id == part["id"],
            AuditLog.action == AuditAction.UPDATE,
        )
        .all()
    )
    assert any(
        row.new_values.get("lifecycle_state") == "active"
        and row.new_values.get("activation_cause") == "manual activation from part page"
        for row in rows
    )


def test_activate_part_custom_cause(client):
    part = _create_part(client, "Custom Cause Part")
    activated = _activate(client, part["id"], cause="released for flight build")
    assert activated["activation_cause"] == "released for flight build"


def test_activate_twice_conflicts(client):
    part = _create_part(client, "Double Activate")
    _activate(client, part["id"])

    response = client.post(f"/api/parts/{part['id']}/activate", json={})
    assert response.status_code == 409


# ============ Guarded physical/financial writes ============


def test_po_create_with_draft_line_blocked(client):
    part = _create_part(client, "PO Draft Part")

    po_body = {"supplier": "ACME", "lines": [{"part_id": part["id"], "qty_ordered": 5}]}
    detail = _assert_blocked(client.post("/api/purchases", json=po_body), part)
    assert "line add" in detail["action"]

    _activate(client, part["id"])
    response = client.post("/api/purchases", json=po_body)
    assert response.status_code == 201, response.text


def test_po_add_line_with_draft_part_blocked(client):
    active = _create_part(client, "PO Active Part")
    _activate(client, active["id"])
    po = client.post(
        "/api/purchases",
        json={"supplier": "ACME", "lines": [{"part_id": active["id"], "qty_ordered": 1}]},
    ).json()

    draft = _create_part(client, "PO Late Draft Part")
    line_body = {"part_id": draft["id"], "qty_ordered": 2}
    _assert_blocked(client.post(f"/api/purchases/{po['id']}/lines", json=line_body), draft)

    _activate(client, draft["id"])
    response = client.post(f"/api/purchases/{po['id']}/lines", json=line_body)
    assert response.status_code == 201, response.text


def test_inventory_create_with_draft_part_blocked(client):
    part = _create_part(client, "Inventory Draft Part")

    inv_body = {"part_id": part["id"], "quantity": 10, "location": "SHELF-A"}
    detail = _assert_blocked(client.post("/api/inventory", json=inv_body), part)
    assert detail["action"] == "inventory record create"

    _activate(client, part["id"])
    response = client.post("/api/inventory", json=inv_body)
    assert response.status_code == 201, response.text


# ============ Publish blocker ============


def test_publish_blocked_by_draft_kit_part(client):
    part = _create_part(client, "Kit Draft Part")
    procedure = client.post("/api/procedures", json={"name": "Lifecycle Proc"}).json()
    proc_id = procedure["id"]

    step = client.post(f"/api/procedures/{proc_id}/steps", json={"title": "Step 1"})
    assert step.status_code == 201, step.text

    # Authoring with drafts is legal — kit add succeeds
    kit = client.post(
        f"/api/procedures/{proc_id}/kit",
        json={"part_id": part["id"], "quantity_required": 1},
    )
    assert kit.status_code == 201, kit.text

    # Publish is the commitment moment — drafts block it
    detail = _assert_blocked(client.post(f"/api/procedures/{proc_id}/publish"), part)
    assert detail["action"] == f"publish of procedure {proc_id}"

    _activate(client, part["id"])
    response = client.post(f"/api/procedures/{proc_id}/publish")
    assert response.status_code == 201, response.text


# ============ Design-time stays legal ============


def test_bom_line_between_drafts_is_legal(client):
    assembly = _create_part(client, "Draft Assembly")
    component = _create_part(client, "Draft Component")

    response = client.post(
        f"/api/bom/assemblies/{assembly['id']}",
        json={"component_id": component["id"], "quantity": 2},
    )
    assert response.status_code == 201, response.text


# ============ Deletion ============


def test_delete_unreferenced_draft(client):
    part = _create_part(client, "Stillborn Part")
    response = client.delete(f"/api/parts/{part['id']}")
    assert response.status_code == 204

    assert client.get(f"/api/parts/{part['id']}").status_code == 404


def test_delete_referenced_draft_blocked(client):
    assembly = _create_part(client, "Referencing Assembly")
    component = _create_part(client, "Referenced Draft")
    client.post(
        f"/api/bom/assemblies/{assembly['id']}",
        json={"component_id": component["id"], "quantity": 1},
    )

    response = client.delete(f"/api/parts/{component['id']}")
    assert response.status_code == 409
    assert "used_in_assemblies" in response.json()["detail"]


def test_delete_active_part_blocked(client):
    part = _create_part(client, "Active Forever")
    _activate(client, part["id"])

    response = client.delete(f"/api/parts/{part['id']}")
    assert response.status_code == 409
    assert "cannot be deleted" in response.json()["detail"]


# ============ Identity immutability ============


def test_active_part_identity_immutable(client):
    part = _create_part(client, "Locked Identity")
    _activate(client, part["id"])

    response = client.patch(f"/api/parts/{part['id']}", json={"internal_pn": "PN-NEW-001"})
    assert response.status_code == 409

    response = client.patch(f"/api/parts/{part['id']}", json={"tier": 2})
    assert response.status_code == 409

    # Non-identity fields stay mutable
    response = client.patch(f"/api/parts/{part['id']}", json={"name": "Renamed but Same Part"})
    assert response.status_code == 200
    assert response.json()["name"] == "Renamed but Same Part"


# ============ Stale draft dashboard ============


def test_stale_draft_parts(client, db_session):
    fresh = _create_part(client, "Fresh Draft")
    stale = _create_part(client, "Forgotten Draft")
    referenced = _create_part(client, "Old Referenced Draft")
    assembly = _create_part(client, "Stale Assembly Holder")
    client.post(
        f"/api/bom/assemblies/{assembly['id']}",
        json={"component_id": referenced["id"], "quantity": 1},
    )

    backdate = datetime.now(UTC) - timedelta(days=35)
    for part_id in (stale["id"], referenced["id"]):
        part_obj = db_session.query(Part).filter(Part.id == part_id).one()
        part_obj.created_at = backdate
    db_session.flush()

    stale_ids = {p.id for p in stale_draft_parts(db_session, older_than_days=30)}
    assert stale["id"] in stale_ids
    assert fresh["id"] not in stale_ids
    assert referenced["id"] not in stale_ids


# ============ MCP tools ============


def _make_part(db, name: str, lifecycle_state: str = "draft") -> Part:
    part = Part(name=name, internal_pn=f"PN-{name}", tier=1, lifecycle_state=lifecycle_state)
    db.add(part)
    db.flush()
    return part


def test_mcp_activate_part_requires_user(db_session):
    part = _make_part(db_session, "MCP-NoUser")
    data = _call(server._activate_part, db_session, {"part_id": part.id})
    assert "error" in data
    assert "user_id" in data["error"]


def test_mcp_activate_part_with_valid_user(db_session, test_user):
    part = _make_part(db_session, "MCP-Activate")
    data = _call(server._activate_part, db_session, {"part_id": part.id, "user_id": test_user.id})
    assert data["success"] is True
    assert "activated by" in data["message"]
    assert data["part"]["lifecycle_state"] == "active"


def test_mcp_bulk_activate_skips_already_active(db_session, test_user):
    draft = _make_part(db_session, "MCP-Bulk-Draft")
    active = _make_part(db_session, "MCP-Bulk-Active", lifecycle_state="active")

    data = _call(
        server._bulk_activate_parts,
        db_session,
        {"part_ids": [draft.id, active.id], "user_id": test_user.id},
    )
    assert data["success"] is True
    assert [p["id"] for p in data["activated"]] == [draft.id]
    assert len(data["skipped"]) == 1
    assert data["skipped"][0]["id"] == active.id


def test_mcp_create_purchase_order_blocked_by_draft(db_session):
    supplier = Supplier(name="MCP Supplier")
    db_session.add(supplier)
    db_session.flush()
    draft = _make_part(db_session, "MCP-PO-Draft")

    data = _call(
        server._create_purchase_order,
        db_session,
        {"supplier_id": supplier.id, "lines": [{"part_id": draft.id, "quantity": 3}]},
    )
    assert data["error"] == "draft_parts_blocked"
    assert draft.id in {p["id"] for p in data["draft_parts"]}
