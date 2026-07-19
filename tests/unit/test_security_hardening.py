"""Regression tests for the v1.4.0 security-hardening pass.

Each test pins a specific finding closed; see SECURITY-AUDIT-v1.4.0.md.
"""

from types import SimpleNamespace

import pytest
from starlette.applications import Starlette
from starlette.responses import PlainTextResponse
from starlette.routing import Route
from starlette.testclient import TestClient

from opal.api.middleware import UserSelectionMiddleware

# ── M1: supplier website must be http(s), never javascript: (stored XSS) ──


def test_supplier_rejects_javascript_url(client):
    resp = client.post(
        "/api/suppliers",
        json={"name": "Evil Co", "website": "javascript:alert(document.cookie)"},
    )
    assert resp.status_code == 422


def test_supplier_rejects_data_url(client):
    resp = client.post(
        "/api/suppliers",
        json={"name": "Evil Co 2", "website": "data:text/html,<script>alert(1)</script>"},
    )
    assert resp.status_code == 422


def test_supplier_accepts_https_url(client):
    resp = client.post(
        "/api/suppliers",
        json={"name": "Good Co", "website": "https://example.com"},
    )
    assert resp.status_code == 201
    assert resp.json()["website"] == "https://example.com"


# ── M3: GET /api/users/{id} leaks email + admin flag → admin-only ──


def test_get_user_requires_admin(client, auth_headers, admin_user):
    # auth_headers is a non-admin user; the client default is an admin token.
    resp = client.get(f"/api/users/{admin_user.id}", headers=auth_headers)
    assert resp.status_code == 403


def test_get_user_allowed_for_admin(client, admin_headers, test_user):
    resp = client.get(f"/api/users/{test_user.id}", headers=admin_headers)
    assert resp.status_code == 200
    assert resp.json()["email"] == "test@example.com"


# ── M2: Onshape document/config mutation is admin-only ──


def test_onshape_add_document_requires_admin(client, auth_headers):
    resp = client.post(
        "/api/onshape/documents",
        json={"url": "https://cad.onshape.com/documents/abc/w/def/e/ghi"},
        headers=auth_headers,
    )
    assert resp.status_code == 403


# ── H1: dataset values are HTML-escaped in the detail page (stored XSS) ──


def test_dataset_detail_escapes_script_payload(web_client):
    create = web_client.post(
        "/api/datasets",
        json={"name": "XSS probe", "schema": {"fields": [{"name": "note", "type": "text"}]}},
    )
    dataset_id = create.json()["id"]
    web_client.post(
        f"/api/datasets/{dataset_id}/points",
        json={"values": {"note": "</script><script>alert(1)</script>"}},
    )

    page = web_client.get(f"/datasets/{dataset_id}")
    assert page.status_code == 200
    html = page.text
    # The injected sequence must never appear able to close the script element.
    assert "</script><script>alert(1)" not in html
    # tojson escapes `<` to < — evidence the safe filter ran.
    assert "\\u003c" in html


# ── H2 is covered by the updated tests/unit/test_inventory.py::test_update_inventory ──


# ── C1: exe-mode refuses spoofed identity headers without the proxy secret ──


def _exe_app(monkeypatch, *, secret: str):
    """Minimal app carrying only UserSelectionMiddleware in exe mode."""
    monkeypatch.setattr(
        "opal.api.middleware.get_active_settings",
        lambda: SimpleNamespace(auth_mode="exe", exe_proxy_secret=secret),
    )
    app = Starlette(routes=[Route("/", lambda request: PlainTextResponse("ok"))])
    app.add_middleware(UserSelectionMiddleware)
    return TestClient(app, follow_redirects=False)


def test_exe_rejects_missing_proxy_secret(monkeypatch):
    tc = _exe_app(monkeypatch, secret="topsecret")
    resp = tc.get(
        "/",
        headers={"X-ExeDev-UserID": "1", "X-ExeDev-Email": "victim@example.com"},
    )
    assert resp.status_code == 403


def test_exe_rejects_wrong_proxy_secret(monkeypatch):
    tc = _exe_app(monkeypatch, secret="topsecret")
    resp = tc.get(
        "/",
        headers={
            "X-ExeDev-Proxy-Secret": "wrong",
            "X-ExeDev-UserID": "1",
            "X-ExeDev-Email": "victim@example.com",
        },
    )
    assert resp.status_code == 403


def test_exe_fails_closed_when_secret_unset(monkeypatch):
    # No secret configured → identity headers are refused even if the client
    # also sends a (meaningless) proxy-secret header.
    tc = _exe_app(monkeypatch, secret="")
    resp = tc.get(
        "/",
        headers={
            "X-ExeDev-Proxy-Secret": "anything",
            "X-ExeDev-UserID": "1",
            "X-ExeDev-Email": "victim@example.com",
        },
    )
    assert resp.status_code == 403


def test_exe_valid_secret_passes_gate(monkeypatch):
    # Correct secret but no identity headers → falls through to the exe.dev
    # login redirect (302), proving the secret gate was cleared.
    tc = _exe_app(monkeypatch, secret="topsecret")
    resp = tc.get("/", headers={"X-ExeDev-Proxy-Secret": "topsecret"})
    assert resp.status_code == 302
    assert "/__exe.dev/login" in resp.headers["location"]


@pytest.mark.parametrize("path", ["/login", "/static/x.css", "/api/health"])
def test_exe_exempt_paths_skip_secret(monkeypatch, path):
    tc = _exe_app(monkeypatch, secret="topsecret")
    # Exempt paths return 404 (no such route) rather than 403 — they never
    # reach the secret gate.
    assert tc.get(path).status_code == 404
