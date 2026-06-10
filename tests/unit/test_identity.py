"""Stale identity handling: unknown user IDs degrade gracefully, never 500."""

from opal.db.models import AuditLog


def test_stale_header_id_degrades_to_anonymous(client, db_session):
    """An audited write with a bogus X-User-Id succeeds with a NULL audit user."""
    resp = client.post(
        "/api/parts",
        json={"name": "Ghost Part", "tier": 3},
        headers={"X-User-Id": "99999"},
    )
    assert resp.status_code == 201, resp.text

    entry = (
        db_session.query(AuditLog)
        .filter(AuditLog.table_name == "part", AuditLog.record_id == resp.json()["id"])
        .one()
    )
    assert entry.user_id is None


def test_valid_header_id_still_attributed(client, db_session, test_user):
    resp = client.post(
        "/api/parts",
        json={"name": "Owned Part", "tier": 3},
        headers={"X-User-Id": str(test_user.id)},
    )
    assert resp.status_code == 201, resp.text

    entry = (
        db_session.query(AuditLog)
        .filter(AuditLog.table_name == "part", AuditLog.record_id == resp.json()["id"])
        .one()
    )
    assert entry.user_id == test_user.id


def test_stale_header_id_401s_on_required_user_routes(client):
    """Routes requiring identity reject a stale ID cleanly instead of 500."""
    resp = client.post("/api/welcome/complete", headers={"X-User-Id": "99999"})
    assert resp.status_code == 401


def test_local_cookie_validation(db_session, test_user, monkeypatch):
    """Middleware cookie check: real user passes, stale id and garbage fail."""
    from contextlib import contextmanager

    import opal.api.middleware as mw

    @contextmanager
    def fake_get_session():
        yield db_session

    monkeypatch.setattr("opal.db.session.get_session", fake_get_session)

    check = mw.UserSelectionMiddleware._local_user_exists
    assert check(str(test_user.id)) is True
    assert check("99999") is False
    assert check("not-a-number") is False
