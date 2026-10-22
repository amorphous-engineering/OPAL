"""Overview summary, audit log API, undo, and onboarding state."""

from datetime import UTC, datetime, timedelta

from fastapi.testclient import TestClient
from sqlalchemy.orm import Session

from opal.db.models.user import User

# ============ Audit log ============


def _make_part(client: TestClient, **body) -> dict:
    r = client.post("/api/parts", json={"name": "Audit Widget", **body})
    assert r.status_code == 201, r.text
    return r.json()


def test_audit_resolves_entries_to_readable_records(client: TestClient) -> None:
    part = _make_part(client)
    r = client.get("/api/audit", params={"table_name": "part"})
    assert r.status_code == 200
    entry = r.json()["items"][0]
    assert entry["action"] == "create"
    assert entry["entity_label"] == "Part"
    assert entry["record_label"] in (part.get("internal_pn"), part["name"])
    assert entry["href"] == f"/parts/{part['id']}"
    assert entry["user_name"] == "Test Client"
    assert any(c["field"] == "name" and c["new"] == "Audit Widget" for c in entry["changes"])


def test_audit_update_lists_only_changed_fields(client: TestClient) -> None:
    part = _make_part(client)
    client.patch(f"/api/parts/{part['id']}", json={"name": "Renamed", "category": "Cat"})

    items = client.get("/api/audit", params={"table_name": "part", "action": "update"}).json()[
        "items"
    ]
    fields = {c["field"]: c for c in items[0]["changes"]}
    assert fields["name"]["old"] == "Audit Widget"
    assert fields["name"]["new"] == "Renamed"
    assert "updated_at" not in fields
    assert "description" not in fields


def test_audit_filters_by_action_user_and_record(client: TestClient) -> None:
    a = _make_part(client, name="A")
    b = _make_part(client, name="B")
    client.patch(f"/api/parts/{a['id']}", json={"name": "A2"})

    only_a = client.get("/api/audit", params={"table_name": "part", "record_id": a["id"]}).json()
    assert only_a["total"] == 2
    assert {e["action"] for e in only_a["items"]} == {"create", "update"}

    creates = client.get("/api/audit", params={"table_name": "part", "action": "create"}).json()
    assert creates["total"] == 2
    assert b["id"] and creates["items"][0]["action"] == "create"

    facets = client.get("/api/audit/facets").json()
    assert {"value": "part", "label": "Part"} in facets["entity_types"]
    uid = facets["users"][0]["id"]
    by_user = client.get("/api/audit", params={"user_id": uid}).json()
    assert by_user["total"] >= 3
    assert client.get("/api/audit", params={"user_id": uid + 999}).json()["total"] == 0


def test_audit_date_range(client: TestClient) -> None:
    _make_part(client)
    today = datetime.now(UTC).date()
    tomorrow = today + timedelta(days=1)

    inside = client.get("/api/audit", params={"date_from": str(today), "date_to": str(today)})
    assert inside.json()["total"] >= 1
    after = client.get("/api/audit", params={"date_from": str(tomorrow)})
    assert after.json()["total"] == 0
    # Whole-day upper bound is exclusive at the next midnight; an instant is exact.
    before = client.get("/api/audit", params={"date_to": "2000-01-01T00:00:00Z"})
    assert before.json()["total"] == 0
    assert client.get("/api/audit", params={"date_from": "garbage"}).status_code == 422


def test_audit_pagination(client: TestClient) -> None:
    for n in range(3):
        _make_part(client, name=f"P{n}")
    page = client.get("/api/audit", params={"table_name": "part", "limit": 2}).json()
    assert page["total"] == 3 and len(page["items"]) == 2
    rest = client.get("/api/audit", params={"table_name": "part", "limit": 2, "skip": 2}).json()
    assert len(rest["items"]) == 1


def test_audit_requires_a_user(client: TestClient) -> None:
    from opal.api.app import create_app

    anon = TestClient(create_app())
    assert anon.get("/api/audit").status_code == 401
    assert anon.get("/api/overview").status_code == 401


# ============ Undo ============


def test_undo_create_soft_deletes_and_names_the_record(client: TestClient) -> None:
    part = _make_part(client, name="Undo Me")
    preview = client.get("/api/undo/last").json()
    assert preview["can_undo"] is True
    assert "#" not in preview["summary"]
    assert "Part" in preview["summary"]

    result = client.post("/api/undo/last")
    assert result.status_code == 200, result.text
    assert client.get(f"/api/parts/{part['id']}").status_code == 404


def test_undo_update_reverts_the_change(client: TestClient) -> None:
    part = _make_part(client, name="Before")
    client.patch(f"/api/parts/{part['id']}", json={"name": "After"})

    result = client.post("/api/undo/last")
    assert result.status_code == 200, result.text
    assert client.get(f"/api/parts/{part['id']}").json()["name"] == "Before"


def test_undo_with_nothing_recent_is_404(client: TestClient) -> None:
    assert client.get("/api/undo/last").status_code == 404


# ============ Onboarding ============


def test_welcome_state_setup_for_admin_on_empty_catalog(client: TestClient) -> None:
    assert client.get("/api/welcome").json() == {"mode": "setup"}


def test_welcome_state_tutorial_once_parts_exist_or_for_non_admins(
    client: TestClient, auth_headers: dict
) -> None:
    assert TestClient(client.app).get("/api/welcome", headers=auth_headers).json() == {
        "mode": "tutorial"
    }
    _make_part(client)
    assert client.get("/api/welcome").json() == {"mode": "tutorial"}


def test_completing_onboarding_clears_the_flag(
    client: TestClient, db_session: Session, test_user: User, auth_headers: dict
) -> None:
    assert test_user.needs_onboarding is True
    me = TestClient(client.app)
    assert me.get("/api/auth/me", headers=auth_headers).json()["needs_onboarding"] is True
    assert me.post("/api/welcome/complete", headers=auth_headers).status_code == 200
    assert me.get("/api/auth/me", headers=auth_headers).json()["needs_onboarding"] is False


# ============ Overview ============


def test_overview_shape_when_empty(client: TestClient) -> None:
    data = client.get("/api/overview").json()
    assert data["issue_counts"]["open"] == 0
    for key in ("issues", "executions", "low_stock", "purchases", "stock_attention", "risks"):
        assert data[key] == {"items": [], "total": 0}
    assert isinstance(data["activity"], list)


def test_overview_issues_put_mine_first_and_count_by_priority(
    client: TestClient, db_session: Session, test_user: User, auth_headers: dict
) -> None:
    client.post("/api/issues", json={"title": "Crit unassigned", "priority": "critical"})
    mine = TestClient(client.app)
    created = mine.post(
        "/api/issues",
        json={"title": "Low but mine", "priority": "low", "assigned_to_id": test_user.id},
        headers=auth_headers,
    )
    assert created.status_code == 201, created.text

    data = mine.get("/api/overview", headers=auth_headers).json()
    counts = data["issue_counts"]
    assert (counts["open"], counts["critical"], counts["low"]) == (2, 1, 1)
    assert counts["unassigned"] == 1 and counts["mine"] == 1
    titles = [i["title"] for i in data["issues"]["items"]]
    assert titles == ["Low but mine", "Crit unassigned"]
    assert data["issues"]["items"][0]["mine"] is True
    assert data["issues"]["items"][0]["href"].startswith("/issues/")


def test_overview_low_stock_lists_parts_under_reorder_point(client: TestClient) -> None:
    _make_part(client, name="Barely", reorder_point=1)
    low = _make_part(client, name="Short", reorder_point=5)
    client.post(f"/api/parts/{low['id']}/activate")
    client.post(
        "/api/inventory",
        json={"part_id": low["id"], "quantity": 2, "location": "Shelf"},
    )

    data = client.get("/api/overview").json()["low_stock"]
    names = {r["name"]: r for r in data["items"]}
    assert set(names) == {"Barely", "Short"}
    assert names["Short"]["on_hand"] == 2 and names["Short"]["reorder_point"] == 5
    # Furthest below the reorder point first.
    assert data["items"][0]["name"] == "Short"
    assert data["total"] == 2


def test_overview_activity_carries_readable_entries(client: TestClient) -> None:
    _make_part(client, name="Feed Item")
    activity = client.get("/api/overview").json()["activity"]
    assert activity and activity[0]["entity_label"] == "Part"
    assert activity[0]["href"].startswith("/parts/")


def test_overview_executions_flag_blocked_runs(client: TestClient) -> None:
    proc = client.post("/api/procedures", json={"name": "Ov Proc"}).json()["id"]
    client.post(f"/api/procedures/{proc}/steps", json={"title": "S1"})
    client.post(f"/api/procedures/{proc}/publish")
    inst = client.post("/api/procedure-instances", json={"procedure_id": proc}).json()["id"]

    rows = client.get("/api/overview").json()["executions"]
    assert rows["total"] == 1
    row = rows["items"][0]
    assert row["blocked"] is False and row["steps_total"] == 1 and row["steps_done"] == 0
    assert row["href"] == f"/executions/{inst}"

    client.post(
        f"/api/procedure-instances/{inst}/steps/1/nc",
        json={"title": "Out of range", "containment": "step"},
    )
    assert client.get("/api/overview").json()["executions"]["items"][0]["blocked"] is True
