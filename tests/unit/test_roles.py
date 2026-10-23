"""Roles (qualifications): CRUD, assignment, template validation and sign-off enforcement."""

import pytest

from opal.db.models import AuditLog, Role, User, UserRole
from tests.conftest import TEST_PASSWORD_HASH, grant_roles, user_headers


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


# ============ role CRUD ============


def test_role_crud_is_admin_only_and_soft_deletes(client, db_session, test_user, auth_headers):
    created = client.post("/api/roles", json={"name": " Engineer ", "description": "Eng"})
    assert created.status_code == 201, created.text
    role = created.json()
    assert role["name"] == "Engineer" and role["member_count"] == 0

    # Duplicate, case-insensitive.
    assert client.post("/api/roles", json={"name": "ENGINEER"}).status_code == 409
    assert client.post("/api/roles", json={"name": "   "}).status_code == 422

    # Any signed-in user reads; only an admin writes.
    listing = client.get("/api/roles", headers=auth_headers)
    assert [r["name"] for r in listing.json()] == ["Engineer"]
    assert client.post("/api/roles", json={"name": "X"}, headers=auth_headers).status_code == 403
    assert (
        client.patch(f"/api/roles/{role['id']}", json={"name": "Y"}, headers=auth_headers)
    ).status_code == 403
    assert client.delete(f"/api/roles/{role['id']}", headers=auth_headers).status_code == 403

    patched = client.patch(f"/api/roles/{role['id']}", json={"name": "Lead Engineer"})
    assert patched.status_code == 200 and patched.json()["name"] == "Lead Engineer"
    other = client.post("/api/roles", json={"name": "QA"}).json()
    clash = client.patch(f"/api/roles/{other['id']}", json={"name": "lead engineer"})
    assert clash.status_code == 409

    assert client.delete(f"/api/roles/{role['id']}").status_code == 204
    row = db_session.get(Role, role["id"])
    assert row is not None and row.deleted_at is not None  # soft delete
    assert [r["name"] for r in client.get("/api/roles").json()] == ["QA"]
    assert client.get(f"/api/roles/{role['id']}").status_code == 404
    assert client.delete(f"/api/roles/{role['id']}").status_code == 404

    # The name is free again and comes back as the same row.
    again = client.post("/api/roles", json={"name": "Lead Engineer"})
    assert again.status_code == 201 and again.json()["id"] == role["id"]

    actions = {
        (a.table_name, a.action.value if hasattr(a.action, "value") else a.action)
        for a in db_session.query(AuditLog)
    }
    assert ("role", "CREATE") in actions or ("role", "create") in actions


def test_member_counts_and_detail(client, db_session, test_user, auth_headers):
    eng = client.post("/api/roles", json={"name": "Engineer"}).json()
    other = _user(db_session, "someone")
    r = client.put(f"/api/users/{test_user.id}/roles", json={"role_ids": [eng["id"]]})
    assert r.status_code == 200
    client.put(f"/api/users/{other.id}/roles", json={"role_ids": [eng["id"]]})
    other.is_active = False
    db_session.commit()

    listing = client.get("/api/roles", headers=auth_headers).json()
    assert listing[0]["member_count"] == 1  # deactivated accounts do not count
    detail = client.get(f"/api/roles/{eng['id']}", headers=auth_headers).json()
    assert [m["id"] for m in detail["members"]] == [test_user.id]
    assert set(detail["members"][0]) == {"id", "name", "avatar_url"}


# ============ assignment ============


def test_assign_roles_to_a_user(client, db_session, test_user, auth_headers):
    a = client.post("/api/roles", json={"name": "Technician"}).json()
    b = client.post("/api/roles", json={"name": "QA"}).json()

    # Non-admins cannot assign, not even to themselves.
    denied = client.put(
        f"/api/users/{test_user.id}/roles", json={"role_ids": [a["id"]]}, headers=auth_headers
    )
    assert denied.status_code == 403

    r = client.put(f"/api/users/{test_user.id}/roles", json={"role_ids": [a["id"], b["id"]]})
    assert r.status_code == 200
    assert [x["name"] for x in r.json()["roles"]] == ["QA", "Technician"]
    grant = db_session.query(UserRole).filter_by(user_id=test_user.id, role_id=a["id"]).one()
    assert grant.granted_by_id is not None

    # Replace semantics: drop one, keep one.
    r = client.put(f"/api/users/{test_user.id}/roles", json={"role_ids": [b["id"]]})
    assert [x["name"] for x in r.json()["roles"]] == ["QA"]
    assert db_session.query(UserRole).filter_by(user_id=test_user.id).count() == 1

    # The roles ride on /me, the directory and the admin listing.
    me = client.get("/api/auth/me", headers=auth_headers).json()
    assert [x["name"] for x in me["roles"]] == ["QA"]
    entry = next(
        u
        for u in client.get("/api/users/directory", headers=auth_headers).json()
        if u["id"] == test_user.id
    )
    assert [x["name"] for x in entry["roles"]] == ["QA"]
    listed = next(u for u in client.get("/api/users").json()["items"] if u["id"] == test_user.id)
    assert [x["name"] for x in listed["roles"]] == ["QA"]

    # Unknown or deleted role ids are refused; unknown users 404.
    assert (
        client.put(f"/api/users/{test_user.id}/roles", json={"role_ids": [9999]}).status_code == 400
    )
    client.delete(f"/api/roles/{b['id']}")
    assert (
        client.put(f"/api/users/{test_user.id}/roles", json={"role_ids": [b["id"]]}).status_code
        == 400
    )
    assert client.put("/api/users/9999/roles", json={"role_ids": []}).status_code == 404
    # Deleting the role dropped the grant.
    assert db_session.query(UserRole).filter_by(user_id=test_user.id).count() == 0


# ============ template role validation ============


def test_template_roles_must_exist_and_are_canonicalised(client, db_session):
    grant_roles(db_session, db_session.query(User).filter_by(username="test.client").one(), "QA")
    proc_id = client.post("/api/procedures", json={"name": "Role validation"}).json()["id"]
    url = f"/api/procedures/{proc_id}/steps"

    bad = client.post(url, json={"title": "A", "signoffs": [{"label": "Buyoff", "role": "Wizard"}]})
    assert bad.status_code == 400 and "Wizard" in bad.json()["detail"]
    assert client.post(url, json={"title": "A", "required_role": "Wizard"}).status_code == 400

    ok = client.post(
        url, json={"title": "B", "signoffs": [{"label": "Buyoff", "role": "qa"}, {"label": "X"}]}
    )
    assert ok.status_code == 201, ok.text
    assert ok.json()["signoffs"][0]["role"] == "QA"  # canonical casing
    assert ok.json()["signoffs"][1]["role"] is None  # none is always allowed
    assert ok.json()["required_role"] == "QA"

    legacy = client.post(url, json={"title": "C", "required_role": "qa"})
    assert legacy.json()["required_role"] == "QA"

    # Updates validate the same way.
    step_id = ok.json()["id"]
    upd = client.patch(
        f"{url}/{step_id}", json={"signoffs": [{"label": "Buyoff", "role": "Wizard"}]}
    )
    assert upd.status_code == 400
    upd = client.patch(f"{url}/{step_id}", json={"required_role": "Wizard"})
    assert upd.status_code == 400
    upd = client.patch(f"{url}/{step_id}", json={"signoffs": [{"label": "Buyoff", "role": "QA"}]})
    assert upd.status_code == 200
    # A role deleted later no longer validates.
    qa = client.get("/api/roles").json()[0]["id"]
    client.delete(f"/api/roles/{qa}")
    assert (
        client.patch(
            f"{url}/{step_id}", json={"signoffs": [{"label": "Buyoff", "role": "QA"}]}
        ).status_code
        == 400
    )


# ============ sign-off enforcement ============


@pytest.fixture
def work_order(client, db_session):
    """A cut work order: sub-step 1.1 with an Engineer slot then a free slot; 1.2 role-free."""
    svc = db_session.query(User).filter_by(username="test.client").one()
    grant_roles(db_session, svc, "Engineer")
    proc_id = client.post("/api/procedures", json={"name": "Role signing"}).json()["id"]
    op = client.post(f"/api/procedures/{proc_id}/steps", json={"title": "OP"}).json()
    one = client.post(
        f"/api/procedures/{proc_id}/steps",
        json={
            "title": "Engineered",
            "parent_step_id": op["id"],
            "signoffs": [{"label": "Engineer buyoff", "role": "Engineer"}, {"label": "Any"}],
        },
    )
    assert one.status_code == 201, one.text
    two = client.post(
        f"/api/procedures/{proc_id}/steps", json={"title": "Open", "parent_step_id": op["id"]}
    )
    assert two.status_code == 201
    assert client.post(f"/api/procedures/{proc_id}/publish").status_code == 201
    inst = client.post("/api/procedure-instances", json={"procedure_id": proc_id}).json()
    numbers = {s["step_number_str"]: s["step_number"] for s in inst["step_executions"]}
    # The service account holds Engineer for authoring; sign as separate people.
    return inst["id"], numbers


def _sign(client, iid, number, slot, headers):
    return client.post(
        f"/api/procedure-instances/{iid}/steps/{number}/signoffs/{slot}", json={}, headers=headers
    )


def _slot(client, iid, number, slot, headers):
    doc = client.get(f"/api/procedure-instances/{iid}/document", headers=headers).json()
    for op in doc["ops"]:
        for s in op["steps"]:
            if s["order"] == number:
                return s["signoffs"][slot]
    raise AssertionError(number)


def test_only_a_role_holder_can_sign_a_role_slot(client, db_session, work_order):
    iid, n = work_order
    holder = _user(db_session, "holder")
    grant_roles(db_session, holder, "Engineer")
    plain = _user(db_session, "plain")
    boss = _user(db_session, "boss", admin=True)  # admin does not stand in for a role

    refused = _sign(client, iid, n["1.1"], 0, user_headers(plain))
    assert refused.status_code == 403
    assert refused.json()["detail"] == "Requires role Engineer"
    admin_refused = _sign(client, iid, n["1.1"], 0, user_headers(boss))
    assert admin_refused.status_code == 403
    assert admin_refused.json()["detail"] == "Requires role Engineer"

    # Case does not matter: the check is against the live role.
    ok = _sign(client, iid, n["1.1"], 0, user_headers(holder))
    assert ok.status_code == 200, ok.text

    # The later slot names no role: open to everyone, the admin without roles included.
    assert _sign(client, iid, n["1.1"], 1, user_headers(plain)).status_code == 200


def test_slot_without_a_role_is_open_to_all(client, db_session, work_order):
    iid, n = work_order
    plain = _user(db_session, "plain")
    assert _sign(client, iid, n["1.2"], 0, user_headers(plain)).status_code == 200


def test_deleted_role_cannot_be_signed(client, db_session, work_order):
    iid, n = work_order
    holder = _user(db_session, "holder")
    grant_roles(db_session, holder, "Engineer")
    role_id = db_session.query(Role).filter_by(name="Engineer").one().id
    client.delete(f"/api/roles/{role_id}")
    refused = _sign(client, iid, n["1.1"], 0, user_headers(holder))
    assert refused.status_code == 403


def test_document_is_computed_per_viewer(client, db_session, work_order):
    iid, n = work_order
    holder = _user(db_session, "holder")
    grant_roles(db_session, holder, "Engineer")
    plain = _user(db_session, "plain")

    mine = _slot(client, iid, n["1.1"], 0, user_headers(holder))
    assert mine["can_sign"] is True
    assert not [b for b in mine["blockers"] if b["kind"] == "role"]

    theirs = _slot(client, iid, n["1.1"], 0, user_headers(plain))
    assert theirs["can_sign"] is False
    assert {"kind": "role", "message": "Requires Engineer"} in [
        {"kind": b["kind"], "message": b["message"]} for b in theirs["blockers"]
    ]

    # A role-free slot is signable by the same person.
    assert _slot(client, iid, n["1.2"], 0, user_headers(plain))["can_sign"] is True
    # The role blocker rides alongside, not instead of, other blockers.
    assert theirs["role"] == "Engineer"


def test_signed_by_carries_an_avatar_url(client, db_session, work_order):
    iid, n = work_order
    holder = _user(db_session, "holder")
    grant_roles(db_session, holder, "Engineer")
    assert _sign(client, iid, n["1.1"], 0, user_headers(holder)).status_code == 200
    slot = _slot(client, iid, n["1.1"], 0, user_headers(holder))
    assert slot["signed_by"] == {"id": holder.id, "name": "Holder", "avatar_url": None}
