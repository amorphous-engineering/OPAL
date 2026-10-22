"""User management API: self-service reads, filters, safety rails, account hand-over."""

from opal.db.models import User


def test_user_can_read_self_but_not_others(client, test_user, admin_user, auth_headers):
    own = client.get(f"/api/users/{test_user.id}", headers=auth_headers)
    assert own.status_code == 200
    body = own.json()
    assert body["username"] == test_user.username
    assert body["has_password"] is True
    assert body["has_passkey"] is False
    assert body["is_online"] is False

    other = client.get(f"/api/users/{admin_user.id}", headers=auth_headers)
    assert other.status_code == 403
    activity = client.get(f"/api/users/{admin_user.id}/activity", headers=auth_headers)
    assert activity.status_code == 403


def test_online_route_is_not_shadowed_by_user_id(client):
    assert client.get("/api/users/online").status_code == 200


def test_list_filters_by_activity_and_search(client, db_session, test_user, admin_headers):
    inactive = User(name="Gone Person", username="gone", is_active=False)
    db_session.add(inactive)
    db_session.commit()

    everyone = client.get("/api/users", headers=admin_headers).json()
    names = {u["name"] for u in everyone["items"]}
    assert {"Gone Person", test_user.name} <= names

    active = client.get("/api/users?is_active=true", headers=admin_headers).json()
    assert "Gone Person" not in {u["name"] for u in active["items"]}
    gone = client.get("/api/users?is_active=false", headers=admin_headers).json()
    assert [u["name"] for u in gone["items"]] == ["Gone Person"]

    found = client.get("/api/users?search=gone", headers=admin_headers).json()
    assert found["total"] == 1
    assert client.get("/api/users?search=testuser", headers=admin_headers).json()["total"] == 1


def test_directory_is_open_to_users_and_hides_contact_details(client, test_user, auth_headers):
    response = client.get("/api/users/directory", headers=auth_headers)
    assert response.status_code == 200
    entry = next(u for u in response.json() if u["id"] == test_user.id)
    assert set(entry) == {"id", "name", "username"}
    assert client.get("/api/users", headers=auth_headers).status_code == 403


def test_patch_cannot_deactivate_or_demote_the_last_admin(client, db_session):
    # Only the fixture service account is an admin here.
    admins = db_session.query(User).filter(User.is_admin.is_(True)).all()
    assert len(admins) == 1
    only = admins[0]
    for payload in ({"is_active": False}, {"is_admin": False}):
        response = client.patch(f"/api/users/{only.id}", json=payload)
        assert response.status_code == 400
        assert "last admin" in response.json()["detail"]


def test_deactivating_a_user_revokes_their_sessions(client, db_session, test_user):
    from opal.core.auth import create_session, resolve_session

    token = create_session(db_session, test_user)
    db_session.commit()
    assert resolve_session(db_session, token) is not None

    response = client.patch(f"/api/users/{test_user.id}", json={"is_active": False})
    assert response.status_code == 200
    assert response.json()["is_active"] is False
    assert resolve_session(db_session, token) is None

    response = client.patch(f"/api/users/{test_user.id}", json={"is_active": True})
    assert response.json()["is_active"] is True


def test_duplicate_email_is_a_conflict(client, test_user):
    other = client.post("/api/users", json={"name": "Other", "email": "other@example.com"})
    assert other.status_code == 201
    clash = client.post("/api/users", json={"name": "Third", "email": test_user.email})
    assert clash.status_code == 409
    clash = client.patch(f"/api/users/{other.json()['id']}", json={"email": test_user.email})
    assert clash.status_code == 409


def test_lan_style_email_domains_are_accepted_and_garbage_is_not(client):
    ok = client.post("/api/users", json={"name": "Lan", "email": "lan@sphinx.local"})
    assert ok.status_code == 201
    assert ok.json()["email"] == "lan@sphinx.local"
    for bad in ("no-at-sign", "a@b", "a b@c.d", "@x.com"):
        r = client.patch(f"/api/users/{ok.json()['id']}", json={"email": bad})
        assert r.status_code == 422, bad


def test_blank_name_is_rejected(client, test_user):
    response = client.patch(f"/api/users/{test_user.id}", json={"name": "   "})
    assert response.status_code == 400


def test_reset_password_leaves_account_claimable(client, db_session, test_user):
    response = client.post(f"/api/users/{test_user.id}/reset-password")
    assert response.status_code == 200
    db_session.refresh(test_user)
    assert test_user.password_hash is None

    claim = client.post(f"/api/users/{test_user.id}/claim-link")
    assert claim.status_code == 200
    assert "/claim?token=" in claim.json()["url"]
    assert claim.json()["expires_at"]


def test_admin_cannot_reset_their_own_password(client, db_session, admin_user, admin_headers):
    response = client.post(f"/api/users/{admin_user.id}/reset-password", headers=admin_headers)
    assert response.status_code == 400
    db_session.refresh(admin_user)
    assert admin_user.password_hash is not None


def test_user_activity_lists_recent_audited_changes(client, admin_user, admin_headers):
    created = client.post("/api/users", json={"name": "Audited Person"}, headers=admin_headers)
    assert created.status_code == 201
    response = client.get(f"/api/users/{admin_user.id}/activity", headers=admin_headers)
    assert response.status_code == 200
    first = response.json()[0]
    assert first["table"] == "user"
    assert first["subject"] == "Audited Person"
    assert first["timestamp"]
