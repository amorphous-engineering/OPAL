"""OpenID Connect sign-in: discovery, the code flow, and identity mapping.

The provider is stubbed at the httpx boundary; the ID token is signed with a
throwaway RSA key served through a real JWKS document, so signature, issuer,
audience and nonce verification all run for real.
"""

import base64
import json
from datetime import UTC, datetime, timedelta

import jwt
import pytest
from cryptography.hazmat.primitives.asymmetric import rsa

from opal.core import oidc
from opal.db.models import User

ISSUER = "https://id.example.test"
CLIENT_ID = "opal-test-client"


# ---------------------------------------------------------------------------
# Stub provider
# ---------------------------------------------------------------------------


@pytest.fixture(scope="module")
def signing_key():
    return rsa.generate_private_key(public_exponent=65537, key_size=2048)


def _b64u(value: int) -> str:
    raw = value.to_bytes((value.bit_length() + 7) // 8, "big")
    return base64.urlsafe_b64encode(raw).decode().rstrip("=")


def _jwks(key) -> dict:
    numbers = key.public_key().public_numbers()
    return {
        "keys": [
            {
                "kty": "RSA",
                "kid": "test-key",
                "use": "sig",
                "alg": "RS256",
                "n": _b64u(numbers.n),
                "e": _b64u(numbers.e),
            }
        ]
    }


def _metadata() -> dict:
    return {
        "issuer": ISSUER,
        "authorization_endpoint": f"{ISSUER}/authorize",
        "token_endpoint": f"{ISSUER}/api/oidc/token",
        "userinfo_endpoint": f"{ISSUER}/api/oidc/userinfo",
        "jwks_uri": f"{ISSUER}/.well-known/jwks.json",
        "scopes_supported": ["openid", "profile", "email", "groups"],
        "id_token_signing_alg_values_supported": ["RS256"],
        "token_endpoint_auth_methods_supported": ["client_secret_basic"],
    }


def make_id_token(key, **claims) -> str:
    now = datetime.now(UTC)
    payload = {
        "iss": ISSUER,
        "aud": CLIENT_ID,
        "sub": "sub-abc-123",
        "iat": int(now.timestamp()),
        "exp": int((now + timedelta(minutes=5)).timestamp()),
        "nonce": "test-nonce",
        **claims,
    }
    return jwt.encode(payload, key, algorithm="RS256", headers={"kid": "test-key"})


class _Response:
    def __init__(self, payload, status_code=200):
        self._payload = payload
        self.status_code = status_code

    def json(self):
        return self._payload

    def raise_for_status(self):
        if self.status_code >= 400:
            import httpx

            raise httpx.HTTPStatusError("boom", request=None, response=None)

    @property
    def text(self):
        return json.dumps(self._payload)


@pytest.fixture
def provider(monkeypatch, signing_key):
    """Serve discovery, JWKS, token and userinfo from an in-process stub."""
    oidc.reset_discovery_cache()
    state = {"tokens": {}, "userinfo": {}, "token_status": 200, "last_token_request": None}

    def fake_get(url, **kwargs):
        if url.endswith("/.well-known/openid-configuration"):
            return _Response(_metadata())
        if url.endswith("/.well-known/jwks.json"):
            return _Response(_jwks(signing_key))
        if url.endswith("/userinfo"):
            return _Response(state["userinfo"])
        raise AssertionError(f"unexpected GET {url}")

    def fake_post(url, **kwargs):
        state["last_token_request"] = kwargs
        return _Response(state["tokens"], status_code=state["token_status"])

    monkeypatch.setattr(oidc.httpx, "get", fake_get)
    monkeypatch.setattr(oidc.httpx, "post", fake_post)

    # PyJWKClient fetches the JWKS with urllib, not httpx — serve it directly.
    class _StubJWKClient:
        def __init__(self, *args, **kwargs):
            pass

        def get_signing_key_from_jwt(self, token):
            from jwt import PyJWK

            return PyJWK.from_dict(_jwks(signing_key)["keys"][0])

    monkeypatch.setattr(oidc, "PyJWKClient", _StubJWKClient)
    yield state
    oidc.reset_discovery_cache()


@pytest.fixture
def config():
    return oidc.OidcConfig(
        issuer=ISSUER,
        client_id=CLIENT_ID,
        client_secret="s3cret",
        scopes="openid profile email groups",
        provider_name="Pocket ID",
        groups_claim="groups",
        admin_group="opal-admins",
        auto_create_users=True,
        redirect_base_url="https://opal.example.test",
    )


# ---------------------------------------------------------------------------
# Discovery
# ---------------------------------------------------------------------------


def test_discovery_reads_and_caches_metadata(provider, config):
    metadata = oidc.discover(ISSUER)
    assert metadata["token_endpoint"] == f"{ISSUER}/api/oidc/token"
    # Second call is served from cache, so it must not need the network.
    assert oidc.discover(ISSUER) is metadata


def test_discovery_rejects_plain_http_issuer():
    with pytest.raises(oidc.OidcError, match="https"):
        oidc.discover("http://id.example.test")


def test_discovery_allows_loopback_http(monkeypatch):
    oidc.reset_discovery_cache()
    monkeypatch.setattr(
        oidc.httpx,
        "get",
        lambda url, **kw: _Response({**_metadata(), "issuer": "http://localhost:9000"}),
    )
    assert oidc.discover("http://localhost:9000")["issuer"] == "http://localhost:9000"
    oidc.reset_discovery_cache()


def test_discovery_rejects_issuer_mismatch(monkeypatch):
    oidc.reset_discovery_cache()
    monkeypatch.setattr(
        oidc.httpx,
        "get",
        lambda url, **kw: _Response({**_metadata(), "issuer": "https://evil.test"}),
    )
    with pytest.raises(oidc.OidcError, match="Issuer mismatch"):
        oidc.discover(ISSUER)
    oidc.reset_discovery_cache()


# ---------------------------------------------------------------------------
# Authorization request
# ---------------------------------------------------------------------------


def test_authorization_url_carries_pkce_and_state(provider, config):
    verifier, challenge = oidc.make_pkce_pair()
    url = oidc.build_authorization_url(
        config, "https://opal.example.test/oidc/callback", "st", "no", challenge
    )
    assert url.startswith(f"{ISSUER}/authorize?")
    assert "response_type=code" in url
    assert "code_challenge_method=S256" in url
    assert f"code_challenge={challenge}" in url
    assert "state=st" in url
    assert "nonce=no" in url
    assert verifier != challenge


def test_pkce_challenge_is_s256_of_verifier():
    import hashlib

    verifier, challenge = oidc.make_pkce_pair()
    expected = (
        base64.urlsafe_b64encode(hashlib.sha256(verifier.encode()).digest()).decode().rstrip("=")
    )
    assert challenge == expected


def test_redirect_uri_prefers_configured_base(config):
    assert (
        oidc.redirect_uri("https://ignored.test/", config)
        == "https://opal.example.test/oidc/callback"
    )


def test_redirect_uri_falls_back_to_request(config):
    bare = oidc.OidcConfig(**{**config.__dict__, "redirect_base_url": ""})
    assert (
        oidc.redirect_uri("http://localhost:8080/", bare) == "http://localhost:8080/oidc/callback"
    )


# ---------------------------------------------------------------------------
# Token exchange and verification
# ---------------------------------------------------------------------------


def test_exchange_code_posts_verifier_and_uses_basic_auth(provider, config, signing_key):
    provider["tokens"] = {"id_token": make_id_token(signing_key), "access_token": "at"}
    tokens = oidc.exchange_code(config, "the-code", "https://opal.example.test/oidc/callback", "v")
    assert tokens["access_token"] == "at"
    sent = provider["last_token_request"]
    assert sent["data"]["code_verifier"] == "v"
    assert sent["data"]["grant_type"] == "authorization_code"
    assert sent["auth"] == (CLIENT_ID, "s3cret")
    # A secret sent via Basic auth is never duplicated in the body.
    assert "client_secret" not in sent["data"]


def test_exchange_code_reports_provider_rejection(provider, config):
    provider["token_status"] = 400
    provider["tokens"] = {"error": "invalid_grant", "error_description": "code expired"}
    with pytest.raises(oidc.OidcError, match="code expired"):
        oidc.exchange_code(config, "bad", "https://opal.example.test/oidc/callback", "v")


def test_verify_id_token_accepts_valid_token(provider, config, signing_key):
    claims = oidc.verify_id_token(config, make_id_token(signing_key), "test-nonce")
    assert claims["sub"] == "sub-abc-123"


def test_verify_id_token_rejects_wrong_nonce(provider, config, signing_key):
    with pytest.raises(oidc.OidcError, match="nonce"):
        oidc.verify_id_token(config, make_id_token(signing_key), "other-nonce")


def test_verify_id_token_rejects_wrong_audience(provider, config, signing_key):
    token = make_id_token(signing_key, aud="someone-else")
    with pytest.raises(oidc.OidcError, match="not valid"):
        oidc.verify_id_token(config, token, "test-nonce")


def test_verify_id_token_rejects_expired_token(provider, config, signing_key):
    past = datetime.now(UTC) - timedelta(hours=1)
    token = make_id_token(signing_key, exp=int(past.timestamp()))
    with pytest.raises(oidc.OidcError, match="not valid"):
        oidc.verify_id_token(config, token, "test-nonce")


def test_verify_id_token_rejects_foreign_signature(provider, config):
    """A token signed by a key the issuer does not publish must not verify."""
    other = rsa.generate_private_key(public_exponent=65537, key_size=2048)
    token = jwt.encode(
        {
            "iss": ISSUER,
            "aud": CLIENT_ID,
            "sub": "attacker",
            "nonce": "test-nonce",
            "iat": int(datetime.now(UTC).timestamp()),
            "exp": int((datetime.now(UTC) + timedelta(minutes=5)).timestamp()),
        },
        other,
        algorithm="RS256",
        headers={"kid": "test-key"},
    )
    with pytest.raises(oidc.OidcError):
        oidc.verify_id_token(config, token, "test-nonce")


# ---------------------------------------------------------------------------
# Handshake state cookie
# ---------------------------------------------------------------------------


def test_state_cookie_round_trips():
    signed = oidc.sign_state({"state": "s", "nonce": "n", "verifier": "v", "next": "/parts"})
    recovered = oidc.verify_state(signed)
    assert recovered["state"] == "s"
    assert recovered["verifier"] == "v"
    assert recovered["next"] == "/parts"


def test_state_cookie_rejects_tampering():
    signed = oidc.sign_state({"state": "s", "nonce": "n", "verifier": "v"})
    body, sig = signed.rsplit(".", 1)
    assert oidc.verify_state(body + "." + ("0" * len(sig))) is None


def test_state_cookie_rejects_other_payload_kinds():
    from opal.core.auth import sign_payload

    assert oidc.verify_state(sign_payload({"kind": "account-claim", "uid": 1})) is None


# ---------------------------------------------------------------------------
# Claim extraction
# ---------------------------------------------------------------------------


@pytest.mark.parametrize(
    "raw,expected",
    [
        (["a", "b"], ["a", "b"]),
        ("a b", ["a", "b"]),
        ("a,b", ["a", "b"]),
        (None, []),
        (42, []),
    ],
)
def test_extract_groups_tolerates_provider_variance(raw, expected):
    assert oidc.extract_groups({"groups": raw}, "groups") == expected


# ---------------------------------------------------------------------------
# Identity resolution
# ---------------------------------------------------------------------------


def test_provisions_new_user_from_claims(db_session, config):
    user = oidc.resolve_identity(
        db_session,
        config,
        {"sub": "s1", "email": "ada@example.test", "name": "Ada Lovelace", "groups": []},
    )
    assert user.name == "Ada Lovelace"
    assert user.email == "ada@example.test"
    assert user.oidc_subject == "s1"
    assert user.oidc_issuer == ISSUER
    # No password is ever set for a federated account.
    assert user.password_hash is None


def test_first_user_is_admin_regardless_of_groups(db_session, config):
    user = oidc.resolve_identity(db_session, config, {"sub": "s1", "email": "a@example.test"})
    assert user.is_admin is True


def test_admin_group_grants_and_revokes(db_session, config):
    db_session.add(User(name="Seed", username="seed", is_active=True))
    db_session.flush()

    granted = oidc.resolve_identity(
        db_session,
        config,
        {"sub": "s2", "email": "b@example.test", "groups": ["opal-admins", "eng"]},
    )
    assert granted.is_admin is True

    revoked = oidc.resolve_identity(
        db_session, config, {"sub": "s2", "email": "b@example.test", "groups": ["eng"]}
    )
    assert revoked.id == granted.id
    assert revoked.is_admin is False


def test_blank_admin_group_leaves_admin_alone(db_session, config):
    db_session.add(User(name="Seed", username="seed2", is_active=True))
    db_session.flush()
    no_group = oidc.OidcConfig(**{**config.__dict__, "admin_group": ""})

    user = oidc.resolve_identity(db_session, no_group, {"sub": "s3", "email": "c@example.test"})
    user.is_admin = True
    db_session.flush()

    again = oidc.resolve_identity(db_session, no_group, {"sub": "s3", "email": "c@example.test"})
    assert again.is_admin is True


def test_matches_on_subject_after_email_change(db_session, config):
    db_session.add(User(name="Seed", username="seed3", is_active=True))
    db_session.flush()

    first = oidc.resolve_identity(db_session, config, {"sub": "s4", "email": "old@example.test"})
    second = oidc.resolve_identity(db_session, config, {"sub": "s4", "email": "new@example.test"})
    assert second.id == first.id
    assert second.email == "new@example.test"


def test_links_existing_password_account_by_email(db_session, config):
    existing = User(
        name="Grace Hopper",
        username="grace",
        email="grace@example.test",
        password_hash="x",
        is_active=True,
    )
    db_session.add(existing)
    db_session.flush()

    linked = oidc.resolve_identity(
        db_session, config, {"sub": "s5", "email": "grace@example.test", "name": "Grace Hopper"}
    )
    assert linked.id == existing.id
    assert linked.oidc_subject == "s5"
    # The password still works — linking adds a method, it does not replace one.
    assert linked.password_hash == "x"


def test_unverified_email_never_claims_an_account(db_session, config):
    existing = User(name="Victim", username="victim", email="victim@example.test", is_active=True)
    db_session.add(existing)
    db_session.flush()

    with pytest.raises(oidc.OidcError, match="unverified"):
        oidc.resolve_identity(
            db_session,
            config,
            {"sub": "attacker", "email": "victim@example.test", "email_verified": False},
        )
    db_session.rollback()


def test_auto_create_off_refuses_unknown_identity(db_session, config):
    db_session.add(User(name="Seed", username="seed4", is_active=True))
    db_session.flush()
    closed = oidc.OidcConfig(**{**config.__dict__, "auto_create_users": False})

    with pytest.raises(oidc.OidcError, match="no OPAL account"):
        oidc.resolve_identity(db_session, closed, {"sub": "s6", "email": "nobody@example.test"})


def test_deactivated_account_cannot_sign_in(db_session, config):
    db_session.add(User(name="Seed", username="seed5", is_active=True))
    db_session.flush()

    user = oidc.resolve_identity(db_session, config, {"sub": "s7", "email": "d@example.test"})
    user.is_active = False
    db_session.flush()

    with pytest.raises(oidc.OidcError, match="deactivated"):
        oidc.resolve_identity(db_session, config, {"sub": "s7", "email": "d@example.test"})


def test_missing_subject_is_refused(db_session, config):
    with pytest.raises(oidc.OidcError, match="subject"):
        oidc.resolve_identity(db_session, config, {"email": "e@example.test"})


def test_email_collision_leaves_existing_value(db_session, config):
    taken = User(name="Taken", username="taken", email="shared@example.test", is_active=True)
    mine = User(
        name="Mine",
        username="mine",
        email="mine@example.test",
        oidc_issuer=ISSUER,
        oidc_subject="s8",
        is_active=True,
    )
    db_session.add_all([taken, mine])
    db_session.flush()

    resolved = oidc.resolve_identity(
        db_session, config, {"sub": "s8", "email": "shared@example.test"}
    )
    assert resolved.id == mine.id
    assert resolved.email == "mine@example.test"


def test_display_name_falls_back_through_claims(db_session, config):
    db_session.add(User(name="Seed", username="seed6", is_active=True))
    db_session.flush()

    user = oidc.resolve_identity(
        db_session,
        config,
        {
            "sub": "s9",
            "email": "alan.turing@example.test",
            "given_name": "Alan",
            "family_name": "Turing",
        },
    )
    assert user.name == "Alan Turing"


# ---------------------------------------------------------------------------
# Web routes
# ---------------------------------------------------------------------------


@pytest.fixture
def oidc_settings(monkeypatch, config):
    """Turn OIDC on for the whole app without touching the database."""
    monkeypatch.setattr(oidc, "get_config", lambda: config)
    monkeypatch.setattr(oidc, "is_enabled", lambda: True)
    return config


def test_login_page_offers_sso_and_password(client, test_user, oidc_settings):
    html = client.get("/login").text
    assert "SIGN IN WITH POCKET ID" in html
    assert "/oidc/login" in html
    assert 'name="password"' in html


def test_login_page_without_oidc_shows_only_password(client, test_user):
    html = client.get("/login").text
    assert "/oidc/login" not in html
    assert 'name="password"' in html


def test_oidc_login_redirects_to_provider_and_sets_state(client, provider, oidc_settings):
    resp = client.get("/oidc/login", follow_redirects=False)
    assert resp.status_code == 302
    assert resp.headers["location"].startswith(f"{ISSUER}/authorize?")
    assert "code_challenge_method=S256" in resp.headers["location"]

    # The base64 payload carries '=' padding, so the cookie is sent quoted;
    # a client unquotes it on the way back (see the round-trip test below).
    cookie = (resp.cookies.get(oidc.STATE_COOKIE) or "").strip('"')
    assert oidc.verify_state(cookie)["verifier"]


def test_full_handshake_round_trip(client, db_session, provider, oidc_settings, signing_key):
    """/oidc/login → provider → /oidc/callback, carrying the real state cookie."""
    begin = client.get("/oidc/login?next=/parts", follow_redirects=False)
    query = dict(
        pair.split("=", 1) for pair in begin.headers["location"].split("?", 1)[1].split("&")
    )

    provider["tokens"] = {
        "id_token": make_id_token(
            signing_key,
            sub="rt-1",
            email="rt@example.test",
            name="Round Trip",
            nonce=query["nonce"],
        ),
        "access_token": "at",
    }

    # The client carries the state cookie set by /oidc/login, exactly as a
    # browser would after the provider redirects back.
    resp = client.get(f"/oidc/callback?code=c&state={query['state']}", follow_redirects=False)
    assert resp.status_code == 302
    assert resp.cookies.get("opal_session")
    assert db_session.query(User).filter(User.oidc_subject == "rt-1").one()


def test_oidc_login_is_inert_when_disabled(client):
    resp = client.get("/oidc/login", follow_redirects=False)
    assert resp.status_code == 302
    assert resp.headers["location"] == "/login"


def test_oidc_callback_signs_user_in(client, db_session, provider, oidc_settings, signing_key):
    provider["tokens"] = {
        "id_token": make_id_token(
            signing_key,
            sub="web-1",
            email="web@example.test",
            name="Web User",
            groups=["opal-admins"],
        ),
        "access_token": "at",
    }
    state = oidc.sign_state(
        {"state": "st", "nonce": "test-nonce", "verifier": "v", "next": "/parts"}
    )
    client.cookies.set(oidc.STATE_COOKIE, state)

    resp = client.get("/oidc/callback?code=c&state=st", follow_redirects=False)
    assert resp.status_code == 302
    assert resp.cookies.get("opal_session")

    user = db_session.query(User).filter(User.oidc_subject == "web-1").one()
    assert user.email == "web@example.test"
    assert user.is_admin is True


def test_oidc_callback_rejects_mismatched_state(client, provider, oidc_settings):
    client.cookies.set(
        oidc.STATE_COOKIE,
        oidc.sign_state({"state": "expected", "nonce": "n", "verifier": "v"}),
    )
    resp = client.get("/oidc/callback?code=c&state=forged", follow_redirects=False)
    assert resp.status_code == 400
    assert "did not match" in resp.text


def test_oidc_callback_rejects_missing_state_cookie(client, provider, oidc_settings):
    resp = client.get("/oidc/callback?code=c&state=st", follow_redirects=False)
    assert resp.status_code == 400
    assert "expired" in resp.text


def test_oidc_callback_surfaces_provider_error(client, oidc_settings):
    resp = client.get(
        "/oidc/callback?error=access_denied&error_description=User+said+no",
        follow_redirects=False,
    )
    assert resp.status_code == 400
    assert "User said no" in resp.text


@pytest.mark.parametrize(
    "target,expected",
    [("//evil.test/", "/"), ("https://evil.test", "/"), ("/parts", "/parts"), ("", "/")],
)
def test_next_redirect_is_confined_to_this_app(target, expected):
    from opal.web.routes import _safe_next

    assert _safe_next(target) == expected


def test_password_login_refused_when_disabled(client, test_user, monkeypatch):
    from opal.config import get_active_settings

    settings = get_active_settings()
    monkeypatch.setattr(settings, "password_login_enabled", False)
    resp = client.post(
        "/login",
        data={"username": "testuser", "password": "test-password-123"},
        follow_redirects=False,
    )
    assert resp.status_code == 403
