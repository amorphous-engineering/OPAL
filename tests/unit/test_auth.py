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
# Sign-in API (the web client's login surface)
# ---------------------------------------------------------------------------


def _anon(client):
    client.cookies.clear()
    client.headers.pop("Authorization", None)
    return client


def test_sign_in_config_is_public(client, test_user) -> None:
    r = _anon(client).get("/api/auth/config")
    assert r.status_code == 200
    body = r.json()
    assert body["needs_setup"] is False
    assert body["password_login_enabled"] is True


def test_password_login_sets_session(client, db_session, test_user) -> None:
    from tests.conftest import TEST_PASSWORD

    r = _anon(client).post(
        "/api/auth/login", json={"username": "TestUser ", "password": TEST_PASSWORD}
    )
    assert r.status_code == 200
    assert r.json()["user"]["username"] == "testuser"
    assert SESSION_COOKIE in r.cookies
    assert resolve_session(db_session, r.cookies[SESSION_COOKIE]).id == test_user.id


def test_password_login_rejects_bad_password(client, db_session, test_user) -> None:
    r = _anon(client).post(
        "/api/auth/login", json={"username": "testuser", "password": "wrong-password"}
    )
    assert r.status_code == 401
    assert SESSION_COOKIE not in r.cookies


def test_session_cookie_grants_api_access(client, db_session, test_user) -> None:
    token = create_session(db_session, test_user)
    db_session.commit()
    c = _anon(client)
    c.cookies.set(SESSION_COOKIE, token)
    assert c.get("/api/auth/me").json()["id"] == test_user.id


def test_forged_or_legacy_cookie_rejected(client, test_user) -> None:
    c = _anon(client)
    c.cookies.set(SESSION_COOKIE, "forged-token")
    assert c.get("/api/auth/me").status_code == 401
    c.cookies.clear()
    c.cookies.set("opal_user_id", str(test_user.id))  # pre-auth-era cookie
    assert c.get("/api/parts").status_code == 401


def test_passwordless_login_is_not_a_claim_oracle(client, db_session) -> None:
    """A migrated (NULL-hash) account is NOT claimable from the login form: the
    response is indistinguishable from a wrong password."""
    user = User(name="Migrated", username="oldtimer", password_hash=None)
    db_session.add(user)
    db_session.commit()

    r = _anon(client).post("/api/auth/login", json={"username": "oldtimer", "password": "x"})
    assert r.status_code == 401
    assert r.json()["detail"] == "Invalid username or password"
    db_session.refresh(user)
    assert user.password_hash is None


def test_claim_link_requires_admin(client, db_session, test_user, auth_headers) -> None:
    user = User(name="Migrated", username="oldtimer", password_hash=None)
    db_session.add(user)
    db_session.commit()

    r = client.post(f"/api/users/{user.id}/claim-link", headers=auth_headers)
    assert r.status_code == 403
    r = _anon(client).post(f"/api/users/{user.id}/claim-link")
    assert r.status_code == 401
    db_session.refresh(user)
    assert user.password_hash is None


def test_admin_issued_claim_flow(client, db_session, admin_user, admin_headers) -> None:
    """Admin mints an out-of-band claim link; the owner sets their password once."""
    from urllib.parse import parse_qs, urlparse

    user = User(name="Migrated", username="oldtimer", password_hash=None)
    db_session.add(user)
    db_session.commit()

    r = client.post(f"/api/users/{user.id}/claim-link", headers=admin_headers)
    assert r.status_code == 200
    url = r.json()["url"]
    assert urlparse(url).path == "/claim"
    token = parse_qs(urlparse(url).query)["token"][0]

    c = _anon(client)
    assert c.get("/api/auth/claim", params={"token": token}).json() == {"username": "oldtimer"}

    r = c.post("/api/auth/claim", json={"token": token, "password": "short"})
    assert r.status_code == 400

    r = c.post("/api/auth/claim", json={"token": token, "password": "new-password-1"})
    assert r.status_code == 200
    assert SESSION_COOKIE in r.cookies
    db_session.refresh(user)
    assert user.password_hash is not None

    # A spent link cannot claim the (now password-holding) account again.
    c.cookies.clear()
    assert c.get("/api/auth/claim", params={"token": token}).status_code == 404
    r = c.post("/api/auth/claim", json={"token": token, "password": "stolen-pass-1"})
    assert r.status_code == 404


def test_claim_link_refused_for_password_holder(client, admin_headers, test_user) -> None:
    r = client.post(f"/api/users/{test_user.id}/claim-link", headers=admin_headers)
    assert r.status_code == 400
    assert "already has a password" in r.json()["detail"]


def test_logout_revokes_session(client, db_session, test_user) -> None:
    token = create_session(db_session, test_user)
    db_session.commit()
    c = _anon(client)
    c.cookies.set(SESSION_COOKIE, token)
    r = c.post("/api/auth/logout")
    assert r.status_code == 204
    assert resolve_session(db_session, token) is None


def test_login_rate_limited(client, db_session, test_user) -> None:
    from opal.core.auth import login_rate_limiter

    c = _anon(client)
    try:
        for _ in range(10):
            c.post("/api/auth/login", json={"username": "testuser", "password": "wrong-password"})
        r = c.post("/api/auth/login", json={"username": "testuser", "password": "wrong-password"})
        assert r.status_code == 429
    finally:
        login_rate_limiter._failures.clear()


def test_first_run_setup_creates_admin_once(client, db_session) -> None:
    db_session.query(User).delete()
    db_session.commit()
    c = _anon(client)
    assert c.get("/api/auth/config").json()["needs_setup"] is True

    r = c.post(
        "/api/auth/setup",
        json={"name": "Ada", "username": "Ada", "password": "correct-horse-1"},
    )
    assert r.status_code == 201
    assert r.json()["user"]["is_admin"] is True
    assert r.json()["user"]["username"] == "ada"
    assert SESSION_COOKIE in r.cookies

    r = c.post(
        "/api/auth/setup",
        json={"name": "Eve", "username": "eve", "password": "correct-horse-1"},
    )
    assert r.status_code == 409


def test_web_client_served_for_app_paths(client) -> None:
    """Non-API paths serve the SPA shell (or a 503 when it is not built)."""
    r = _anon(client).get("/parts/12")
    assert r.status_code in (200, 503)
    assert _anon(client).get("/api/nope").status_code == 404


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
