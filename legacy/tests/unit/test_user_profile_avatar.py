"""Profile fields, avatars (upload, serve, remove) and the OIDC picture fetch."""

import base64
from contextlib import contextmanager

import httpx
import pytest

from opal.core import avatars
from opal.db.models import AuditLog, User, Workcenter
from tests.conftest import TEST_PASSWORD_HASH, user_headers

# A real 1x1 PNG.
PNG = base64.b64decode(
    "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg=="
)


@pytest.fixture(autouse=True)
def avatar_store(tmp_path, monkeypatch):
    """Avatar files go to a throwaway directory."""
    monkeypatch.setattr(avatars, "avatar_dir", lambda: tmp_path / "avatars")
    return tmp_path / "avatars"


def _user(db, username="pat", *, admin=False) -> User:
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


# ============ profile fields ============


def test_profile_fields_self_other_and_admin(client, db_session, test_user, auth_headers):
    wc = Workcenter(code="BENCH", name="Assembly Bench")
    db_session.add(wc)
    db_session.commit()
    other = _user(db_session, "other")

    body = {"job_title": " Machinist ", "phone": "555-0100", "workcenter_id": wc.id}
    r = client.patch(f"/api/users/{test_user.id}", json=body, headers=auth_headers)
    assert r.status_code == 200, r.text
    got = r.json()
    assert got["job_title"] == "Machinist" and got["phone"] == "555-0100"
    assert got["workcenter"] == {"id": wc.id, "name": "Assembly Bench"}

    # Seen on /me and the directory.
    me = client.get("/api/auth/me", headers=auth_headers).json()
    assert me["job_title"] == "Machinist" and me["workcenter"]["name"] == "Assembly Bench"
    entry = next(
        u
        for u in client.get("/api/users/directory", headers=auth_headers).json()
        if u["id"] == test_user.id
    )
    assert entry["phone"] == "555-0100"

    # Another non-admin is refused; so is a non-admin touching admin-only fields.
    denied = client.patch(
        f"/api/users/{other.id}", json={"job_title": "Boss"}, headers=auth_headers
    )
    assert denied.status_code == 403
    assert (
        client.patch(
            f"/api/users/{test_user.id}", json={"is_admin": True}, headers=auth_headers
        ).status_code
        == 403
    )

    # An admin may edit anyone, and may clear a field.
    r = client.patch(f"/api/users/{other.id}", json={"job_title": "Inspector", "phone": "1"})
    assert r.status_code == 200 and r.json()["job_title"] == "Inspector"
    r = client.patch(f"/api/users/{test_user.id}", json={"workcenter_id": None, "phone": " "})
    assert r.json()["workcenter"] is None and r.json()["phone"] is None

    # Validation.
    assert client.patch(f"/api/users/{other.id}", json={"workcenter_id": 9999}).status_code == 400
    assert client.patch(f"/api/users/{other.id}", json={"job_title": "x" * 121}).status_code == 422
    assert client.patch(f"/api/users/{other.id}", json={"phone": "9" * 41}).status_code == 422


# ============ avatar upload / serve / remove ============


def _upload(client, user_id, content=PNG, ctype="image/png", headers=None):
    return client.post(
        f"/api/users/{user_id}/avatar",
        files={"file": ("me.png", content, ctype)},
        headers=headers,
    )


def test_avatar_upload_serve_and_remove(client, db_session, test_user, auth_headers, avatar_store):
    assert client.get(f"/api/users/{test_user.id}/avatar", headers=auth_headers).status_code == 404

    r = _upload(client, test_user.id, headers=auth_headers)
    assert r.status_code == 200, r.text
    url = r.json()["avatar_url"]
    assert url.startswith(f"/api/users/{test_user.id}/avatar?v=")
    assert len(list(avatar_store.iterdir())) == 1

    db_session.refresh(test_user)
    assert test_user.avatar_source == "upload" and test_user.avatar_mime == "image/png"

    got = client.get(url, headers=auth_headers)
    assert got.status_code == 200
    assert got.content == PNG
    assert got.headers["content-type"] == "image/png"
    assert got.headers["cache-control"] == "private, max-age=31536000"

    # Every place that shows the user carries the URL.
    me = client.get("/api/auth/me", headers=auth_headers).json()
    assert me["avatar_url"] == url
    entry = next(
        u
        for u in client.get("/api/users/directory", headers=auth_headers).json()
        if u["id"] == test_user.id
    )
    assert entry["avatar_url"] == url

    # Replacing deletes the old file.
    assert _upload(client, test_user.id, headers=auth_headers).status_code == 200
    assert len(list(avatar_store.iterdir())) == 1

    gone = client.delete(f"/api/users/{test_user.id}/avatar", headers=auth_headers)
    assert gone.status_code == 200 and gone.json()["avatar_url"] is None
    db_session.refresh(test_user)
    assert test_user.avatar_source == "removed" and test_user.avatar_filename is None
    assert list(avatar_store.iterdir()) == []
    assert client.get(f"/api/users/{test_user.id}/avatar", headers=auth_headers).status_code == 404

    audited = (
        db_session.query(AuditLog).filter_by(table_name="user", record_id=test_user.id).count()
    )
    assert audited >= 3


def test_avatar_upload_validation(client, db_session, test_user, auth_headers):
    other = _user(db_session, "other")

    wrong_type = _upload(client, test_user.id, b"<svg/>", "image/svg+xml", auth_headers)
    assert wrong_type.status_code == 400
    # Declared as PNG but not an image.
    liar = _upload(client, test_user.id, b"definitely not a png", "image/png", auth_headers)
    assert liar.status_code == 400
    too_big = _upload(
        client, test_user.id, PNG + b"\0" * avatars.MAX_AVATAR_BYTES, "image/png", auth_headers
    )
    assert too_big.status_code == 413
    exactly = PNG + b"\0" * (avatars.MAX_AVATAR_BYTES - len(PNG))
    assert _upload(client, test_user.id, exactly, "image/png", auth_headers).status_code == 200

    # Self or admin only.
    assert _upload(client, other.id, headers=auth_headers).status_code == 403
    assert client.delete(f"/api/users/{other.id}/avatar", headers=auth_headers).status_code == 403
    assert _upload(client, other.id).status_code == 200  # admin
    assert _upload(client, 9999).status_code == 404


def test_avatar_is_served_to_other_signed_in_users(client, db_session, test_user, auth_headers):
    other = _user(db_session, "other")
    assert _upload(client, test_user.id, headers=auth_headers).status_code == 200
    assert (
        client.get(f"/api/users/{test_user.id}/avatar", headers=user_headers(other)).status_code
        == 200
    )


# ============ OIDC picture ============


class _FakeResponse:
    def __init__(self, body=PNG, ctype="image/png", status=200, length=None):
        self._body = body
        self.headers = {"content-type": ctype}
        if length is not None:
            self.headers["content-length"] = str(length)
        self._status = status

    def raise_for_status(self):
        if self._status >= 400:
            raise httpx.HTTPStatusError("bad", request=None, response=None)  # type: ignore[arg-type]

    def iter_bytes(self):
        yield from (self._body[i : i + 1024] for i in range(0, len(self._body), 1024))


@pytest.fixture
def fetch(monkeypatch):
    """Replace httpx.stream; records the URLs asked for and never touches the network."""
    calls: list[str] = []
    state: dict = {"response": _FakeResponse(), "error": None}

    @contextmanager
    def fake_stream(method, url, **kwargs):
        calls.append(url)
        assert kwargs["timeout"] == 5.0
        if state["error"]:
            raise state["error"]
        yield state["response"]

    monkeypatch.setattr(avatars.httpx, "stream", fake_stream)
    state["calls"] = calls
    return state


def test_oidc_picture_fills_an_empty_avatar(db_session, fetch, avatar_store):
    user = _user(db_session)
    assert avatars.refresh_from_oidc(db_session, user, {"picture": "https://idp.example/me.png"})
    assert user.avatar_source == "oidc" and user.avatar_mime == "image/png"
    assert (avatar_store / user.avatar_filename).read_bytes() == PNG
    assert avatars.avatar_url(user).startswith(f"/api/users/{user.id}/avatar?v=")

    # A later sign-in refreshes an oidc avatar (and drops the old file).
    first = user.avatar_filename
    assert avatars.refresh_from_oidc(db_session, user, {"picture": "http://idp.example/me.png"})
    assert user.avatar_filename != first and not (avatar_store / first).exists()
    assert len(fetch["calls"]) == 2


@pytest.mark.parametrize("source", ["upload", "removed"])
def test_oidc_picture_never_overrides_a_user_choice(db_session, fetch, source):
    user = _user(db_session)
    user.avatar_source = source
    db_session.commit()
    assert not avatars.refresh_from_oidc(db_session, user, {"picture": "https://idp.example/p"})
    assert fetch["calls"] == []
    assert user.avatar_source == source


def test_oidc_picture_skipped_without_a_usable_claim(db_session, fetch):
    user = _user(db_session)
    for claims in ({}, {"picture": ""}, {"picture": None}, {"picture": 7}):
        assert not avatars.refresh_from_oidc(db_session, user, claims)
    for url in ("ftp://idp.example/p.png", "file:///etc/passwd", "javascript:alert(1)", "//x/p"):
        assert not avatars.refresh_from_oidc(db_session, user, {"picture": url})
    assert fetch["calls"] == []
    assert user.avatar_source is None


@pytest.mark.parametrize(
    "response",
    [
        _FakeResponse(ctype="text/html"),
        _FakeResponse(ctype="image/svg+xml", body=b"<svg/>"),
        _FakeResponse(body=b"not really an image"),
        _FakeResponse(status=404),
        _FakeResponse(length=avatars.MAX_AVATAR_BYTES + 1),
        _FakeResponse(body=PNG + b"\0" * avatars.MAX_AVATAR_BYTES),
    ],
    ids=["html", "svg", "bad-bytes", "404", "declared-too-big", "streamed-too-big"],
)
def test_oidc_picture_rejections_are_quiet(db_session, fetch, response):
    user = _user(db_session)
    fetch["response"] = response
    assert (
        avatars.refresh_from_oidc(db_session, user, {"picture": "https://idp.example/p"}) is False
    )
    assert user.avatar_source is None and user.avatar_filename is None


@pytest.mark.parametrize("error", [httpx.ConnectTimeout("slow"), httpx.ConnectError("down")])
def test_oidc_picture_network_failure_never_raises(db_session, fetch, error):
    user = _user(db_session)
    fetch["error"] = error
    assert (
        avatars.refresh_from_oidc(db_session, user, {"picture": "https://idp.example/p"}) is False
    )


def test_oidc_callback_survives_a_failing_picture(client, db_session, monkeypatch, fetch):
    """Sign-in completes even when the avatar fetch blows up."""
    from opal.core import oidc

    user = _user(db_session, "sso")
    monkeypatch.setattr(oidc, "is_enabled", lambda: True)
    monkeypatch.setattr(oidc, "get_config", lambda: object())
    monkeypatch.setattr(oidc, "redirect_uri", lambda *a, **k: "http://testserver/oidc/callback")
    monkeypatch.setattr(
        oidc, "verify_state", lambda _v: {"state": "s", "verifier": "v", "nonce": "n", "next": "/"}
    )
    monkeypatch.setattr(
        oidc, "exchange_code", lambda *a, **k: {"id_token": "t", "access_token": "a"}
    )
    monkeypatch.setattr(
        oidc, "verify_id_token", lambda *a, **k: {"sub": "1", "picture": "https://i/p"}
    )
    monkeypatch.setattr(oidc, "fetch_userinfo", lambda *a, **k: {})
    monkeypatch.setattr(oidc, "resolve_identity", lambda *a, **k: user)
    fetch["error"] = httpx.ConnectError("down")

    r = client.get("/oidc/callback?code=c&state=s", follow_redirects=False)
    assert r.status_code == 302 and r.headers["location"] == "/"
