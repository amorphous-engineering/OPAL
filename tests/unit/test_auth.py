"""Tests for credentialed authentication: passwords, sessions, tokens, flows."""

from datetime import UTC, datetime, timedelta

from opal.core.auth import (
    SESSION_COOKIE,
    LoginRateLimiter,
    authenticate_password,
    create_api_token,
    create_session,
    generate_unique_username,
    hash_password,
    resolve_api_token,
    resolve_session,
    revoke_all_sessions,
    revoke_session,
    sign_payload,
    validate_password_strength,
    verify_password,
    verify_payload,
)
from opal.db.models import AuthSession, User

# ---------------------------------------------------------------------------
# Passwords
# ---------------------------------------------------------------------------


def test_password_hash_roundtrip() -> None:
    h = hash_password("correct horse battery staple")
    assert h != "correct horse battery staple"
    assert verify_password(h, "correct horse battery staple")
    assert not verify_password(h, "wrong password 123")
    assert not verify_password(None, "anything at all")


def test_password_strength() -> None:
    assert validate_password_strength("short") is not None
    assert validate_password_strength("x" * 257) is not None
    assert validate_password_strength("long-enough-password") is None


def test_authenticate_password(db_session, test_user) -> None:
    from tests.conftest import TEST_PASSWORD

    assert authenticate_password(db_session, "testuser", TEST_PASSWORD) is test_user
    assert authenticate_password(db_session, "TESTUSER", TEST_PASSWORD) is test_user  # normalized
    assert authenticate_password(db_session, "testuser", "wrong-password") is None
    assert authenticate_password(db_session, "ghost", TEST_PASSWORD) is None


def test_passwordless_account_never_authenticates(db_session) -> None:
    user = User(name="Migrated", username="migrated", password_hash=None)
    db_session.add(user)
    db_session.commit()
    assert authenticate_password(db_session, "migrated", "") is None
    assert authenticate_password(db_session, "migrated", "any-password-10") is None


# ---------------------------------------------------------------------------
# Sessions
# ---------------------------------------------------------------------------


def test_session_lifecycle(db_session, test_user) -> None:
    token = create_session(db_session, test_user)
    assert resolve_session(db_session, token) is test_user
    assert resolve_session(db_session, "bogus") is None
    assert resolve_session(db_session, None) is None

    revoke_session(db_session, token)
    assert resolve_session(db_session, token) is None


def test_session_expiry(db_session, test_user) -> None:
    token = create_session(db_session, test_user)
    session = db_session.query(AuthSession).filter(AuthSession.user_id == test_user.id).one()
    session.expires_at = datetime.now(UTC) - timedelta(seconds=1)
    db_session.flush()
    assert resolve_session(db_session, token) is None


def test_session_rejected_for_inactive_user(db_session, test_user) -> None:
    token = create_session(db_session, test_user)
    test_user.is_active = False
    db_session.flush()
    assert resolve_session(db_session, token) is None


def test_revoke_all_sessions_keeps_current(db_session, test_user) -> None:
    keep = create_session(db_session, test_user)
    other1 = create_session(db_session, test_user)
    other2 = create_session(db_session, test_user)
    revoked = revoke_all_sessions(db_session, test_user.id, except_token=keep)
    assert revoked == 2
    assert resolve_session(db_session, keep) is test_user
    assert resolve_session(db_session, other1) is None
    assert resolve_session(db_session, other2) is None


# ---------------------------------------------------------------------------
# API tokens
# ---------------------------------------------------------------------------


def test_api_token_lifecycle(db_session, test_user) -> None:
    record, raw = create_api_token(db_session, test_user, "test token")
    assert raw.startswith("opal_")
    assert resolve_api_token(db_session, raw) is test_user
    assert resolve_api_token(db_session, "opal_bogus") is None
    assert resolve_api_token(db_session, None) is None

    record.revoked_at = datetime.now(UTC)
    db_session.flush()
    assert resolve_api_token(db_session, raw) is None


# ---------------------------------------------------------------------------
# Signed payloads / usernames / rate limiting
# ---------------------------------------------------------------------------


def test_signed_payload_roundtrip_and_tamper() -> None:
    value = sign_payload({"uid": 42})
    assert verify_payload(value) == {"uid": 42}
    assert verify_payload(value[:-2] + "xx") is None
    assert verify_payload("garbage") is None
    expired = sign_payload({"uid": 1}, max_age=timedelta(seconds=-1))
    assert verify_payload(expired) is None


def test_generate_unique_username(db_session) -> None:
    first = generate_unique_username(db_session, "Abby B!")
    db_session.add(User(name="A", username=first))
    db_session.flush()
    second = generate_unique_username(db_session, "Abby B!")
    assert first != second
    assert second.startswith(first.rstrip("2"))


def test_rate_limiter_blocks_and_recovers() -> None:
    limiter = LoginRateLimiter(max_failures=3, window_seconds=60)
    key = "1.2.3.4:abby"
    assert not limiter.is_blocked(key)
    for _ in range(3):
        limiter.record_failure(key)
    assert limiter.is_blocked(key)
    limiter.reset(key)
    assert not limiter.is_blocked(key)


# ---------------------------------------------------------------------------
# API enforcement
# ---------------------------------------------------------------------------


def test_api_requires_auth(client) -> None:
    # No Authorization header at all
    r = client.get("/api/parts", headers={"Authorization": ""})
    assert r.status_code == 401

    r = client.get("/api/parts", headers={"Authorization": "Bearer opal_invalid"})
    assert r.status_code == 401


def test_api_health_is_public(client) -> None:
    r = client.get("/api/health", headers={"Authorization": ""})
    assert r.status_code == 200


def test_bearer_token_authenticates(client, auth_headers, test_user) -> None:
    r = client.get("/api/auth/me", headers=auth_headers)
    assert r.status_code == 200
    assert r.json()["id"] == test_user.id
    assert r.json()["username"] == "testuser"


def test_x_user_id_header_no_longer_works(client, test_user) -> None:
    r = client.get("/api/parts", headers={"Authorization": "", "X-User-Id": str(test_user.id)})
    assert r.status_code == 401


# ---------------------------------------------------------------------------
# Web login flows
# ---------------------------------------------------------------------------


def test_web_login_with_credentials(client, db_session, test_user) -> None:
    from tests.conftest import TEST_PASSWORD

    r = client.post(
        "/login",
        data={"username": "testuser", "password": TEST_PASSWORD},
        follow_redirects=False,
    )
    assert r.status_code == 302
    assert SESSION_COOKIE in r.cookies


def test_web_login_rejects_bad_password(client, db_session, test_user) -> None:
    r = client.post(
        "/login",
        data={"username": "testuser", "password": "wrong-password"},
        follow_redirects=False,
    )
    assert r.status_code == 401
    assert SESSION_COOKIE not in r.cookies


def test_web_pages_redirect_without_session(client, test_user) -> None:
    client.cookies.clear()
    r = client.get("/parts", follow_redirects=False)
    assert r.status_code == 302
    assert r.headers["location"] == "/login"


def test_web_session_cookie_grants_access(web_client) -> None:
    r = web_client.get("/parts", follow_redirects=False)
    assert r.status_code == 200


def test_forged_or_legacy_cookie_rejected(client, test_user) -> None:
    client.cookies.clear()
    client.cookies.set(SESSION_COOKIE, "forged-token")
    r = client.get("/parts", follow_redirects=False)
    assert r.status_code == 302
    assert r.headers["location"] == "/login"

    client.cookies.clear()
    client.cookies.set("opal_user_id", str(test_user.id))  # pre-auth-era cookie
    r = client.get("/parts", follow_redirects=False)
    assert r.status_code == 302


def test_tofu_initial_password_flow(client, db_session) -> None:
    """Migrated accounts (NULL password hash) set a password on first login."""
    user = User(name="Migrated", username="oldtimer", password_hash=None)
    db_session.add(user)
    db_session.commit()

    # Login attempt diverts to the set-password form with a signed state
    r = client.post("/login", data={"username": "oldtimer", "password": "x"})
    assert r.status_code == 200
    assert "SET PASSWORD" in r.text
    import re

    state = re.search(r'name="state" value="([^"]+)"', r.text).group(1)

    # Mismatched confirmation is rejected
    r = client.post(
        "/login/set-password",
        data={"state": state, "password": "new-password-1", "password_confirm": "different-1"},
    )
    assert r.status_code == 400

    # Valid set-password claims the account and signs in
    r = client.post(
        "/login/set-password",
        data={"state": state, "password": "new-password-1", "password_confirm": "new-password-1"},
        follow_redirects=False,
    )
    assert r.status_code == 302
    assert SESSION_COOKIE in r.cookies
    db_session.refresh(user)
    assert user.password_hash is not None

    # The state token cannot claim the account twice
    r = client.post(
        "/login/set-password",
        data={"state": state, "password": "stolen-pass-1", "password_confirm": "stolen-pass-1"},
        follow_redirects=False,
    )
    assert r.status_code == 302
    assert r.headers["location"] == "/login"


def test_logout_revokes_session(client, db_session, test_user) -> None:
    token = create_session(db_session, test_user)
    db_session.commit()
    client.cookies.set(SESSION_COOKIE, token)
    r = client.get("/logout", follow_redirects=False)
    assert r.status_code == 302
    assert resolve_session(db_session, token) is None


def test_login_rate_limited(client, db_session, test_user) -> None:
    from opal.core.auth import login_rate_limiter

    try:
        for _ in range(10):
            client.post(
                "/login",
                data={"username": "testuser", "password": "wrong-password"},
            )
        r = client.post(
            "/login",
            data={"username": "testuser", "password": "wrong-password"},
        )
        assert r.status_code == 429
    finally:
        login_rate_limiter._failures.clear()


# ---------------------------------------------------------------------------
# Account security API
# ---------------------------------------------------------------------------


def test_change_password_revokes_other_sessions(client, db_session, test_user, auth_headers):
    from tests.conftest import TEST_PASSWORD

    other = create_session(db_session, test_user)
    db_session.commit()

    r = client.post(
        "/api/auth/password",
        json={"current_password": TEST_PASSWORD, "new_password": "brand-new-password-1"},
        headers=auth_headers,
    )
    assert r.status_code == 200
    assert resolve_session(db_session, other) is None
    assert authenticate_password(db_session, "testuser", "brand-new-password-1") is test_user


def test_change_password_requires_current(client, test_user, auth_headers):
    r = client.post(
        "/api/auth/password",
        json={"current_password": "wrong", "new_password": "brand-new-password-1"},
        headers=auth_headers,
    )
    assert r.status_code == 403


def test_token_management(client, auth_headers):
    r = client.post("/api/auth/tokens", json={"name": "tui"}, headers=auth_headers)
    assert r.status_code == 201
    body = r.json()
    assert body["token"].startswith("opal_")

    r = client.get("/api/auth/me", headers={"Authorization": f"Bearer {body['token']}"})
    assert r.status_code == 200

    r = client.delete(f"/api/auth/tokens/{body['id']}", headers=auth_headers)
    assert r.status_code == 204
    r = client.get("/api/auth/me", headers={"Authorization": f"Bearer {body['token']}"})
    assert r.status_code == 401


def test_admin_password_reset(client, db_session, test_user, admin_headers):
    token = create_session(db_session, test_user)
    db_session.commit()

    r = client.post(f"/api/users/{test_user.id}/reset-password", headers=admin_headers)
    assert r.status_code == 200
    db_session.refresh(test_user)
    assert test_user.password_hash is None
    assert resolve_session(db_session, token) is None


def test_password_reset_requires_admin(client, test_user, auth_headers):
    r = client.post(f"/api/users/{test_user.id}/reset-password", headers=auth_headers)
    assert r.status_code == 403


# ---------------------------------------------------------------------------
# CSRF origin check
# ---------------------------------------------------------------------------


def test_cross_origin_post_rejected(client, auth_headers):
    r = client.post(
        "/api/auth/tokens",
        json={"name": "evil"},
        headers={**auth_headers, "Origin": "https://evil.example.com"},
    )
    assert r.status_code == 403


def test_same_origin_post_allowed(client, auth_headers):
    r = client.post(
        "/api/auth/tokens",
        json={"name": "fine"},
        headers={**auth_headers, "Origin": "http://testserver"},
    )
    assert r.status_code == 201
