"""Settings API: system facts, sign-in methods, Onshape credentials, lifecycle."""

import pytest

import opal.config as config_mod


@pytest.fixture(autouse=True)
def _restore_settings(monkeypatch):
    """Settings edits apply a DB overlay to the process-wide runtime settings."""
    monkeypatch.setattr(config_mod, "_runtime_settings", config_mod._runtime_settings)


def test_system_info_is_open_to_any_user(client, auth_headers):
    response = client.get("/api/settings/system", headers=auth_headers)
    assert response.status_code == 200
    body = response.json()
    assert body["opal_version"]
    assert body["python_version"]
    assert body["max_upload_bytes"] > 0


# ============ Sign-in methods ============


def test_auth_settings_are_admin_only(client, auth_headers):
    assert client.get("/api/settings/auth", headers=auth_headers).status_code == 403
    response = client.put(
        "/api/settings/auth",
        json={"password_login_enabled": True, "passkeys_enabled": True},
        headers=auth_headers,
    )
    assert response.status_code == 403


def test_auth_settings_roundtrip_without_echoing_the_secret(client, admin_headers):
    response = client.put(
        "/api/settings/auth",
        json={
            "password_login_enabled": True,
            "passkeys_enabled": False,
            "oidc_enabled": True,
            "oidc_issuer": "https://id.example.com/",
            "oidc_client_id": "opal",
            "oidc_client_secret": "s3cret",
            "oidc_provider_name": "Pocket ID",
        },
        headers=admin_headers,
    )
    assert response.status_code == 200, response.text
    body = response.json()
    assert body["oidc_issuer"] == "https://id.example.com"
    assert body["has_client_secret"] is True
    assert "s3cret" not in response.text
    assert body["callback_url"].endswith("/oidc/callback")
    assert body["passkeys_enabled"] is False

    # A blank secret keeps the stored one; the clear flag removes it.
    kept = client.put(
        "/api/settings/auth",
        json={
            "password_login_enabled": True,
            "passkeys_enabled": False,
            "oidc_enabled": True,
            "oidc_issuer": "https://id.example.com",
            "oidc_client_id": "opal",
        },
        headers=admin_headers,
    )
    assert kept.json()["has_client_secret"] is True
    cleared = client.put(
        "/api/settings/auth",
        json={
            "password_login_enabled": True,
            "passkeys_enabled": False,
            "oidc_enabled": True,
            "oidc_issuer": "https://id.example.com",
            "oidc_client_id": "opal",
            "clear_client_secret": True,
        },
        headers=admin_headers,
    )
    assert cleared.json()["has_client_secret"] is False

    public = client.get("/api/auth/config").json()
    assert public["oidc_enabled"] is True
    assert public["oidc_provider_name"] == "SSO"  # the last PUT omitted it


@pytest.mark.parametrize(
    ("payload", "fragment"),
    [
        ({"oidc_enabled": True, "oidc_issuer": "", "oidc_client_id": ""}, "issuer URL"),
        (
            {"oidc_enabled": True, "oidc_issuer": "http://evil.example", "oidc_client_id": "x"},
            "https://",
        ),
        (
            {
                "oidc_enabled": True,
                "oidc_issuer": "https://id.example.com",
                "oidc_client_id": "x",
                "oidc_scopes": "profile",
            },
            "openid",
        ),
        ({"password_login_enabled": False}, "Disabling password sign-in"),
    ],
)
def test_auth_settings_refuse_unsafe_configurations(client, admin_headers, payload, fragment):
    body = {"password_login_enabled": True, "passkeys_enabled": True, **payload}
    response = client.put("/api/settings/auth", json=body, headers=admin_headers)
    assert response.status_code == 400
    assert fragment in response.json()["detail"]


def test_auth_discovery_test_reports_missing_configuration(client, admin_headers, monkeypatch):
    from opal.config import get_active_settings

    monkeypatch.setattr(get_active_settings(), "oidc_issuer", "")
    response = client.post("/api/settings/auth/test", headers=admin_headers)
    assert response.status_code == 200
    assert response.json()["ok"] is False


# ============ Onshape credentials ============


def test_onshape_settings_hide_secrets_and_validate_the_url(client, admin_headers, auth_headers):
    assert client.get("/api/settings/onshape", headers=auth_headers).status_code == 403

    saved = client.put(
        "/api/settings/onshape",
        json={
            "access_key": "AK",
            "secret_key": "SK",
            "webhook_secret": "WH",
            "poll_interval_minutes": 5,
        },
        headers=admin_headers,
    )
    assert saved.status_code == 200, saved.text
    body = saved.json()
    assert body["configured"] is True
    assert body["has_secret_key"] is True
    assert body["has_webhook_secret"] is True
    assert body["poll_interval_minutes"] == 5
    assert "secret_key" not in body and "webhook_secret" not in body

    kept = client.put(
        "/api/settings/onshape",
        json={"access_key": "AK2", "poll_interval_minutes": 5},
        headers=admin_headers,
    )
    assert kept.json()["has_secret_key"] is True
    assert kept.json()["access_key"] == "AK2"

    cleared = client.put(
        "/api/settings/onshape",
        json={"access_key": "AK2", "clear_secret_key": True},
        headers=admin_headers,
    )
    assert cleared.json()["configured"] is False

    bad = client.put(
        "/api/settings/onshape",
        json={"access_key": "AK", "base_url": "http://internal.local"},
        headers=admin_headers,
    )
    assert bad.status_code == 400


def test_onshape_connection_test_needs_credentials(client, admin_headers, monkeypatch):
    from opal.config import get_active_settings

    monkeypatch.setattr(get_active_settings(), "onshape_access_key", "")
    response = client.post("/api/settings/onshape/test", headers=admin_headers)
    assert response.status_code == 200
    assert response.json()["ok"] is False


# ============ Lifecycle ============


def test_lifecycle_state_readable_by_any_user(client, auth_headers):
    response = client.get("/api/settings/lifecycle", headers=auth_headers)
    assert response.status_code == 200
    assert response.json()["demo_active"] is False


def test_lifecycle_mutations_are_admin_only(client, auth_headers):
    assert client.post("/api/settings/demo/enter", headers=auth_headers).status_code == 403
    assert client.post("/api/settings/demo/exit", headers=auth_headers).status_code == 403
    assert client.delete("/api/settings/demo", headers=auth_headers).status_code == 403
    response = client.post(
        "/api/settings/factory-reset", json={"confirm": "RESET"}, headers=auth_headers
    )
    assert response.status_code == 403


def test_factory_reset_requires_the_confirmation_word(client, admin_headers, monkeypatch):
    from opal.core import lifecycle

    called = []
    monkeypatch.setattr(lifecycle, "factory_reset", lambda: called.append(True))

    response = client.post(
        "/api/settings/factory-reset", json={"confirm": "reset?"}, headers=admin_headers
    )
    assert response.status_code == 400
    assert called == []

    response = client.post(
        "/api/settings/factory-reset", json={"confirm": " RESET "}, headers=admin_headers
    )
    assert response.status_code == 200
    assert called == [True]


def test_delete_demo_file_refuses_while_the_demo_is_active(client, admin_headers, monkeypatch):
    from opal.core import lifecycle

    def active() -> None:
        raise RuntimeError("Cannot delete the demo database while it is active")

    monkeypatch.setattr(lifecycle, "delete_demo_file", active)
    response = client.delete("/api/settings/demo", headers=admin_headers)
    assert response.status_code == 409
