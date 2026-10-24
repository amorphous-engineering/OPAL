"""System roles and permission gates: Admin role mirrors is_admin, gate registry
API, enforcement on issue disposition / approval, per-viewer flags, MCP."""

import asyncio
import json

from opal.core.roles import ensure_system_roles
from opal.db.models import AuditLog, Role, RoleGate, User
from opal.mcp import server
from tests.conftest import TEST_PASSWORD_HASH, grant_roles, system_roles, user_headers


def _user(db, username: str, *, admin: bool = False) -> User:
    u = User(
        name=username.title(),
        username=username,
        password_hash=TEST_PASSWORD_HASH,
        email=f"{username}@example.com",
        is_admin=admin,
    )
    db.add(u)
    db.commit()
    return u


def _issue(client, containment: str = "wo") -> dict:
    return client.post(
        "/api/issues", json={"title": "Gate test", "containment": containment}
    ).json()


def _dispo(client, iid, headers=None):
    return client.post(
        f"/api/issues/{iid}/disposition",
        json={"disposition_type": "rework", "disposition_rationale": "per redline"},
        headers=headers,
    )


# ============ system roles ============


def test_system_roles_listed_first_and_protected(client, db_session):
    system_roles(db_session)
    client.post("/api/roles", json={"name": "Welder"})
    client.post("/api/roles", json={"name": "Apprentice"})
    listing = client.get("/api/roles").json()
    assert [r["name"] for r in listing] == [
        "Engineer",
        "Technician",
        "Quality",
        "Admin",
        "Apprentice",
        "Welder",
    ]
    assert [r["key"] for r in listing[:4]] == ["engineer", "technician", "quality", "admin"]
    assert all(r["is_system"] for r in listing[:4]) and not listing[4]["is_system"]

    for role in listing[:4]:
        gone = client.delete(f"/api/roles/{role['id']}")
        assert gone.status_code == 400 and "system role" in gone.json()["detail"]
        renamed = client.patch(f"/api/roles/{role['id']}", json={"name": "Other"})
        assert renamed.status_code == 400
    # Same name in other casing is a rename too; the description may change.
    eng = listing[0]
    assert client.patch(f"/api/roles/{eng['id']}", json={"name": "ENGINEER"}).status_code == 400
    ok = client.patch(f"/api/roles/{eng['id']}", json={"description": "Does engineering"})
    assert ok.status_code == 200 and ok.json()["description"] == "Does engineering"
    # A custom role cannot take a system name.
    assert client.post("/api/roles", json={"name": "quality"}).status_code == 409
    assert db_session.get(Role, eng["id"]).deleted_at is None


def test_ensure_system_roles_is_idempotent_and_converts_custom_roles(db_session):
    custom = Role(name="engineer", description="Mine")
    db_session.add(custom)
    db_session.commit()
    first = ensure_system_roles(db_session)
    again = ensure_system_roles(db_session)
    db_session.commit()
    assert [r.id for r in first] == [r.id for r in again]
    assert first[0].id == custom.id and first[0].name == "Engineer"
    assert first[0].description == "Mine" and first[0].is_system
    assert db_session.query(Role).count() == 4
    gates = {(g.role_id, g.gate) for g in db_session.query(RoleGate)}
    assert gates == {(first[0].id, "issue.disposition"), (first[2].id, "issue.approve")}


def test_admin_role_mirrors_is_admin_both_ways(client, db_session, test_user, auth_headers):
    roles = system_roles(db_session)
    admin_role = roles["admin"]
    eng = roles["engineer"]

    assert [r["name"] for r in client.get(f"/api/users/{test_user.id}").json()["roles"]] == []
    put = client.put(f"/api/users/{test_user.id}/roles", json={"role_ids": [admin_role.id, eng.id]})
    assert put.status_code == 200, put.text
    body = put.json()
    assert body["is_admin"] is True
    assert [r["name"] for r in body["roles"]] == ["Admin", "Engineer"]
    db_session.refresh(test_user)
    assert test_user.is_admin is True
    # No stored grant for Admin: membership is the flag.
    from opal.db.models import UserRole

    assert [g.role_id for g in db_session.query(UserRole).filter_by(user_id=test_user.id)] == [
        eng.id
    ]
    # Reads agree: /me, the member list and the count.
    me = client.get("/api/auth/me", headers=auth_headers).json()
    assert "Admin" in [r["name"] for r in me["roles"]]
    listing = {r["name"]: r for r in client.get("/api/roles").json()}
    assert listing["Admin"]["member_count"] == 2  # service admin + test user
    detail = client.get(f"/api/roles/{admin_role.id}").json()
    assert test_user.id in [m["id"] for m in detail["members"]]

    # Excluding Admin demotes.
    down = client.put(f"/api/users/{test_user.id}/roles", json={"role_ids": [eng.id]})
    assert down.json()["is_admin"] is False
    db_session.refresh(test_user)
    assert test_user.is_admin is False
    audited = db_session.query(AuditLog).filter(AuditLog.table_name == "user").count()
    assert audited >= 2  # promotion and demotion are logged


def test_flag_change_shows_in_roles_and_last_admin_is_protected(
    client, db_session, admin_user, admin_headers
):
    system_roles(db_session)
    # admin_user and the service admin are active admins.
    shown = client.get(f"/api/users/{admin_user.id}").json()
    assert "Admin" in [r["name"] for r in shown["roles"]]
    service = db_session.query(User).filter(User.username == "test.client").one()
    db_session.query(User).filter(User.id == service.id).update({"is_active": False})
    db_session.commit()
    # Now admin_user is the last active admin.
    admin_role = db_session.query(Role).filter_by(key="admin").one()
    eng = db_session.query(Role).filter_by(key="engineer").one()
    refused = client.put(
        f"/api/users/{admin_user.id}/roles", json={"role_ids": [eng.id]}, headers=admin_headers
    )
    assert refused.status_code == 400
    assert refused.json()["detail"] == "Cannot remove the last admin"
    db_session.refresh(admin_user)
    assert admin_user.is_admin is True
    # Keeping Admin in the set is fine.
    kept = client.put(
        f"/api/users/{admin_user.id}/roles",
        json={"role_ids": [admin_role.id, eng.id]},
        headers=admin_headers,
    )
    assert kept.status_code == 200


# ============ gates API ============


def test_gates_api(client, db_session, auth_headers):
    roles = system_roles(db_session)
    listing = client.get("/api/gates", headers=auth_headers)  # any signed-in user
    assert listing.status_code == 200
    gates = {g["key"]: g for g in listing.json()}
    assert set(gates) == {"issue.disposition", "issue.approve"}
    assert gates["issue.disposition"]["label"] == "Disposition issue tickets"
    assert gates["issue.disposition"]["role_ids"] == [roles["engineer"].id]
    assert gates["issue.approve"]["role_ids"] == [roles["quality"].id]
    assert gates["issue.approve"]["description"]

    both = [roles["engineer"].id, roles["quality"].id]
    # Admin only.
    denied = client.put("/api/gates/issue.approve", json={"role_ids": both}, headers=auth_headers)
    assert denied.status_code == 403
    ok = client.put("/api/gates/issue.approve", json={"role_ids": both})
    assert ok.status_code == 200 and sorted(ok.json()["role_ids"]) == sorted(both)
    assert db_session.query(AuditLog).filter(AuditLog.table_name == "role_gate").count() >= 1

    # Unknown role -> 400; unknown gate -> 404; nothing changed by a refusal.
    bad = client.put("/api/gates/issue.approve", json={"role_ids": [9999]})
    assert bad.status_code == 400
    assert client.put("/api/gates/nope", json={"role_ids": []}).status_code == 404
    custom = client.post("/api/roles", json={"name": "Welder"}).json()
    client.delete(f"/api/roles/{custom['id']}")
    assert (
        client.put("/api/gates/issue.approve", json={"role_ids": [custom["id"]]}).status_code == 400
    )
    again = {g["key"]: g for g in client.get("/api/gates").json()}
    assert sorted(again["issue.approve"]["role_ids"]) == sorted(both)

    # Empty is allowed: admins alone pass.
    cleared = client.put("/api/gates/issue.approve", json={"role_ids": []})
    assert cleared.json()["role_ids"] == []


def test_deleting_a_custom_role_drops_its_gate_mapping(client, db_session):
    system_roles(db_session)
    custom = client.post("/api/roles", json={"name": "Welder"}).json()
    client.put("/api/gates/issue.disposition", json={"role_ids": [custom["id"]]})
    client.delete(f"/api/roles/{custom['id']}")
    assert db_session.query(RoleGate).filter_by(role_id=custom["id"]).count() == 0
    revived = client.post("/api/roles", json={"name": "Welder"}).json()
    gates = {g["key"]: g for g in client.get("/api/gates").json()}
    assert revived["id"] not in gates["issue.disposition"]["role_ids"]


# ============ enforcement ============


def test_disposition_gate(client, db_session):
    roles = system_roles(db_session)
    iid = _issue(client)["id"]
    plain = _user(db_session, "plain")
    quality_only = _user(db_session, "qonly")
    grant_roles(db_session, quality_only, "Quality")
    engineer = _user(db_session, "eng")
    grant_roles(db_session, engineer, "Engineer")

    for who in (plain, quality_only):
        refused = _dispo(client, iid, user_headers(who))
        assert refused.status_code == 403
        assert refused.json()["detail"] == "Requires Engineer"
    assert client.get(f"/api/issues/{iid}").json()["dispositioned"] is False

    ok = _dispo(client, iid, user_headers(engineer))
    assert ok.status_code == 200 and ok.json()["dispositioned"] is True

    # Admin always passes without holding Engineer.
    other = _issue(client)["id"]
    boss = _user(db_session, "boss", admin=True)
    assert _dispo(client, other, user_headers(boss)).status_code == 200

    # Remapping the gate changes who passes; the message names the new roles.
    third = _issue(client)["id"]
    client.put(
        "/api/gates/issue.disposition",
        json={"role_ids": [roles["engineer"].id, roles["quality"].id]},
    )
    assert _dispo(client, third, user_headers(quality_only)).status_code == 200
    fourth = _issue(client)["id"]
    refused = _dispo(client, fourth, user_headers(plain))
    assert refused.json()["detail"] == "Requires Engineer or Quality"


def test_approve_gate_on_signoff_and_close(client, db_session):
    system_roles(db_session)
    plain = _user(db_session, "plain")
    quality = _user(db_session, "qual")
    grant_roles(db_session, quality, "Quality")
    engineer = _user(db_session, "eng")
    grant_roles(db_session, engineer, "Engineer")

    # Review sign-off (In Review -> Done).
    iid = _issue(client, "advisory")["id"]
    client.post(f"/api/issues/{iid}/start", headers=user_headers(plain))
    client.post(f"/api/issues/{iid}/review", headers=user_headers(plain))  # not gated
    for who in (plain, engineer):
        refused = client.post(f"/api/issues/{iid}/signoff", headers=user_headers(who))
        assert refused.status_code == 403
        assert refused.json()["detail"] == "Requires Quality"
    assert client.get(f"/api/issues/{iid}").json()["status"] == "open"
    ok = client.post(f"/api/issues/{iid}/signoff", headers=user_headers(quality))
    assert ok.status_code == 200 and ok.json()["status"] == "closed"

    # PATCH status=closed (back-compat close path).
    jid = _issue(client, "advisory")["id"]
    refused = client.patch(
        f"/api/issues/{jid}", json={"status": "closed"}, headers=user_headers(engineer)
    )
    assert refused.status_code == 403 and refused.json()["detail"] == "Requires Quality"
    other_edit = client.patch(
        f"/api/issues/{jid}", json={"title": "Renamed"}, headers=user_headers(plain)
    )
    assert other_edit.status_code == 200  # only closing is gated
    closed = client.patch(
        f"/api/issues/{jid}", json={"status": "closed"}, headers=user_headers(quality)
    )
    assert closed.status_code == 200 and closed.json()["status"] == "closed"
    # Reopening is not an approval.
    reopened = client.patch(
        f"/api/issues/{jid}", json={"status": "open"}, headers=user_headers(plain)
    )
    assert reopened.status_code == 200

    # Admin always passes.
    kid = _issue(client, "advisory")["id"]
    boss = _user(db_session, "boss", admin=True)
    assert (
        client.patch(
            f"/api/issues/{kid}", json={"status": "closed"}, headers=user_headers(boss)
        ).status_code
        == 200
    )


def test_issue_detail_flags_per_viewer(client, db_session, auth_headers):
    system_roles(db_session)
    iid = _issue(client)["id"]
    plain = client.get(f"/api/issues/{iid}", headers=auth_headers).json()
    assert plain["can_disposition"] is False and plain["can_approve"] is False
    assert plain["gate_reasons"] == {
        "disposition": "Requires Engineer",
        "approve": "Requires Quality",
    }

    eng = _user(db_session, "eng")
    grant_roles(db_session, eng, "Engineer")
    mine = client.get(f"/api/issues/{iid}", headers=user_headers(eng)).json()
    assert mine["can_disposition"] is True and mine["can_approve"] is False
    assert mine["gate_reasons"] == {"approve": "Requires Quality"}

    admin = client.get(f"/api/issues/{iid}").json()
    assert admin["can_disposition"] is True and admin["can_approve"] is True
    assert admin["gate_reasons"] == {}


# ============ MCP ============


def _mcp(db, args):
    return json.loads(asyncio.run(server._sign_disposition(db, args))[0].text)


def test_mcp_disposition_respects_the_gate(client, db_session):
    system_roles(db_session)
    iid = _issue(client)["id"]
    plain = _user(db_session, "plain")
    eng = _user(db_session, "eng")
    grant_roles(db_session, eng, "Engineer")
    args = {"issue_id": iid, "disposition_type": "rework", "rationale": "redline"}

    refused = _mcp(db_session, {**args, "user_id": plain.id})
    assert refused["success"] is False and refused["error"] == "Requires Engineer"
    ok = _mcp(db_session, {**args, "user_id": eng.id})
    assert ok["success"] is True

    # Admin passes, and an unattributed call is refused like other human-only actions.
    other = _issue(client)["id"]
    boss = _user(db_session, "boss", admin=True)
    assert _mcp(db_session, {**args, "issue_id": other, "user_id": boss.id})["success"] is True
    anon = _mcp(db_session, {**args, "issue_id": _issue(client)["id"]})
    assert "human user" in anon["error"]


def test_mcp_dispatch_still_refuses_signing_outright(db_session):
    out = asyncio.run(server.call_tool("sign_disposition", {"issue_id": 1, "user_id": 1}))
    assert json.loads(out[0].text)["human_action_required"] is True


# ============ migration-independent fresh installs ============


def test_new_database_gets_system_roles(tmp_path):
    from sqlalchemy import create_engine
    from sqlalchemy.orm import Session

    from opal.db.base import init_database

    engine = create_engine(f"sqlite:///{tmp_path / 'fresh.db'}")
    init_database(engine)
    with Session(engine) as db:
        assert [r.key for r in db.query(Role).order_by(Role.id)] == [
            "engineer",
            "technician",
            "quality",
            "admin",
        ]
        assert db.query(RoleGate).count() == 2
    engine.dispose()
