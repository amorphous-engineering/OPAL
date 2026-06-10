"""Stale identity handling: credentials for vanished users degrade gracefully, never 500.

A session or API token can outlive its user — a demo-database switch or
factory reset replaces the user table underneath the browser. These must
read as logged out / unauthorized, not as server errors.
"""

from opal.core.auth import SESSION_COOKIE, create_api_token, create_session
from opal.db.models import AuditLog


def test_audited_write_attributed_to_token_user(client, db_session, auth_headers, test_user):
    resp = client.post(
        "/api/parts",
        json={"name": "Owned Part", "tier": 3},
        headers=auth_headers,
    )
    assert resp.status_code == 201, resp.text

    entry = (
        db_session.query(AuditLog)
        .filter(AuditLog.table_name == "part", AuditLog.record_id == resp.json()["id"])
        .one()
    )
    assert entry.user_id == test_user.id


def test_token_for_deactivated_user_401s(client, db_session, test_user):
    """A credential whose user vanished rejects cleanly instead of 500."""
    _, raw_token = create_api_token(db_session, test_user, "stale")
    db_session.commit()

    test_user.is_active = False
    db_session.commit()

    resp = client.post(
        "/api/parts",
        json={"name": "Ghost Part", "tier": 3},
        headers={"Authorization": f"Bearer {raw_token}"},
    )
    assert resp.status_code == 401


def test_session_for_deactivated_user_logs_out_web(client, db_session, test_user):
    """Middleware treats a session whose user vanished as logged out."""
    token = create_session(db_session, test_user)
    db_session.commit()

    test_user.is_active = False
    db_session.commit()

    client.cookies.set(SESSION_COOKIE, token)
    client.headers.pop("Authorization", None)
    resp = client.get("/parts", follow_redirects=False)
    assert resp.status_code == 302
    assert resp.headers["location"] == "/login"
