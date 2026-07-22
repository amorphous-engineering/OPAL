"""Regression tests for the v1.4.0 security-hardening pass.

Each test pins a specific finding closed; see SECURITY-AUDIT-v1.4.0.md.
"""

from datetime import UTC, datetime
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


# ── M4: cycle count writes a reconciling ledger row (no silent stock rewrite) ──


def _bulk_inventory(client, qty=10):
    part = client.post(
        "/api/parts",
        json={"name": "Ledger Widget", "tracking_type": "bulk", "category": "Fasteners"},
    ).json()
    client.post(f"/api/parts/{part['id']}/activate", json={"cause": "t"})
    inv = client.post(
        "/api/inventory",
        json={"part_id": part["id"], "quantity": qty, "location": "A"},
    ).json()
    return part, inv["items"][0]["id"]


def test_count_writes_ledger_row(client, db_session):
    from opal.db.models.inventory import InventoryConsumption

    _, inv_id = _bulk_inventory(client, qty=10)
    resp = client.post(f"/api/inventory/{inv_id}/count", json={"counted_quantity": 7})
    assert resp.status_code == 200
    assert float(resp.json()["quantity"]) == 7

    rows = (
        db_session.query(InventoryConsumption)
        .filter(InventoryConsumption.inventory_record_id == inv_id)
        .all()
    )
    assert len(rows) == 1
    assert float(rows[0].quantity) == 3  # 10 → 7 recorded as a −3 delta


def test_count_rejects_negative(client):
    _, inv_id = _bulk_inventory(client, qty=5)
    resp = client.post(f"/api/inventory/{inv_id}/count", json={"counted_quantity": -1})
    assert resp.status_code == 400


# ── M5: transfer rejects a soft-deleted source part ──


def test_transfer_rejected_for_soft_deleted_part(client, db_session):
    from opal.db.models import Part

    part, inv_id = _bulk_inventory(client, qty=10)
    p = db_session.query(Part).filter(Part.id == part["id"]).first()
    p.deleted_at = datetime.now(UTC)
    db_session.commit()

    resp = client.post(
        "/api/inventory/transfer",
        json={"source_inventory_id": inv_id, "target_location": "B", "quantity": 2},
    )
    assert resp.status_code == 404


# ── M6: child endpoints reject a soft-deleted parent procedure ──


def test_step_ops_rejected_on_soft_deleted_procedure(client):
    proc_id = client.post("/api/procedures", json={"name": "Doomed Procedure"}).json()["id"]
    step_id = client.post(
        f"/api/procedures/{proc_id}/steps",
        json={"title": "S1", "instructions": "x"},
    ).json()["id"]

    assert client.delete(f"/api/procedures/{proc_id}").status_code in (200, 204)

    # Parent soft-deleted → its step is neither readable nor mutable.
    assert (
        client.patch(
            f"/api/procedures/{proc_id}/steps/{step_id}", json={"title": "hacked"}
        ).status_code
        == 404
    )
    assert client.get(f"/api/procedures/{proc_id}/steps/{step_id}/kit").status_code == 404
    assert client.delete(f"/api/procedures/{proc_id}/steps/{step_id}").status_code == 404


# ── file handling: CSV formula injection, header filename, upload size ──


def test_csv_export_neutralizes_formula(client):
    ds = client.post(
        "/api/datasets",
        json={"name": "Formulas", "schema": {"fields": [{"name": "note", "type": "text"}]}},
    ).json()
    client.post(f"/api/datasets/{ds['id']}/points", json={"values": {"note": "=1+2"}})

    resp = client.get(f"/api/datasets/{ds['id']}/export")
    assert resp.status_code == 200
    assert "'=1+2" in resp.text  # leading '=' neutralized with a quote


def test_csv_export_filename_has_no_quote_breakout(client):
    ds = client.post(
        "/api/datasets",
        json={"name": 'Evil"; x=1', "schema": {"fields": []}},
    ).json()
    resp = client.get(f"/api/datasets/{ds['id']}/export")
    cd = resp.headers["content-disposition"]
    assert cd.count('"') == 2  # only the wrapping quotes; the name's " was stripped


def test_upload_rejects_oversize_by_declared_size(client, monkeypatch):
    from opal.config import get_active_settings

    monkeypatch.setattr(get_active_settings(), "max_upload_size", 10)
    resp = client.post(
        "/api/attachments/upload",
        files={"file": ("x.png", b"x" * 5000, "image/png")},
    )
    assert resp.status_code == 413


# ── MCP: list limit is clamped (uncapped result materialization) ──


def test_mcp_clamp_limit():
    from opal.mcp.server import _MAX_LIST_LIMIT, _clamp_limit

    assert _clamp_limit(None, 50) == 50
    assert _clamp_limit(10, 50) == 10
    assert _clamp_limit(10**9, 50) == _MAX_LIST_LIMIT
    assert _clamp_limit(0, 50) == 50
    assert _clamp_limit(-5, 50) == 50
    assert _clamp_limit("garbage", 50) == 50


# ── web/config hardening: /docs gating + OriginCheck ──


def test_openapi_schema_not_served(client):
    # Outside debug the FastAPI OpenAPI schema / Swagger / ReDoc routes are
    # disabled; /openapi.json also sits behind the web-auth redirect. Either
    # way it never returns the schema. (/docs is OPAL's own documentation
    # page, which disabling the built-in explorer unshadows — not asserted
    # here beyond it no longer being the API explorer.)
    assert client.get("/openapi.json", follow_redirects=False).status_code != 200


def test_origin_check_rejects_null_origin(client):
    resp = client.post(
        "/api/datasets",
        json={"name": "x", "schema": {"fields": []}},
        headers={"Origin": "null"},
    )
    assert resp.status_code == 403


def test_origin_check_rejects_cross_origin(client):
    resp = client.post(
        "/api/datasets",
        json={"name": "x", "schema": {"fields": []}},
        headers={"Origin": "http://evil.example"},
    )
    assert resp.status_code == 403


def test_origin_check_rejects_cross_origin_referer(client):
    resp = client.post(
        "/api/datasets",
        json={"name": "x", "schema": {"fields": []}},
        headers={"Referer": "http://evil.example/x"},
    )
    assert resp.status_code == 403


def test_origin_check_allows_same_origin(client):
    resp = client.post(
        "/api/datasets",
        json={"name": "same origin ok", "schema": {"fields": []}},
        headers={"Origin": "http://testserver"},
    )
    assert resp.status_code == 201


# ── trust-proxy: X-Forwarded-* honored only when OPAL_TRUST_PROXY is set ──


def _fake_request(headers=None, scheme="http", client_host="10.0.0.9"):
    from types import SimpleNamespace

    from starlette.datastructures import URL, Headers

    req = SimpleNamespace()
    req.headers = Headers(headers or {})
    req.url = URL(f"{scheme}://opal.local/x")
    req.client = SimpleNamespace(host=client_host) if client_host else None
    return req


def test_request_is_secure_ignores_forwarded_without_trust(monkeypatch):
    from types import SimpleNamespace

    from opal.api import net

    monkeypatch.setattr(net, "get_active_settings", lambda: SimpleNamespace(trust_proxy=False))
    req = _fake_request({"x-forwarded-proto": "https"}, scheme="http")
    assert net.request_is_secure(req) is False


def test_request_is_secure_honors_forwarded_with_trust(monkeypatch):
    from types import SimpleNamespace

    from opal.api import net

    monkeypatch.setattr(net, "get_active_settings", lambda: SimpleNamespace(trust_proxy=True))
    req = _fake_request({"x-forwarded-proto": "https"}, scheme="http")
    assert net.request_is_secure(req) is True


def test_request_is_secure_true_for_direct_https(monkeypatch):
    from types import SimpleNamespace

    from opal.api import net

    monkeypatch.setattr(net, "get_active_settings", lambda: SimpleNamespace(trust_proxy=False))
    assert net.request_is_secure(_fake_request(scheme="https")) is True


def test_client_ip_uses_forwarded_leftmost_with_trust(monkeypatch):
    from types import SimpleNamespace

    from opal.api import net

    monkeypatch.setattr(net, "get_active_settings", lambda: SimpleNamespace(trust_proxy=True))
    req = _fake_request({"x-forwarded-for": "203.0.113.7, 10.0.0.1"}, client_host="10.0.0.1")
    assert net.client_ip(req) == "203.0.113.7"


def test_client_ip_ignores_forwarded_without_trust(monkeypatch):
    from types import SimpleNamespace

    from opal.api import net

    monkeypatch.setattr(net, "get_active_settings", lambda: SimpleNamespace(trust_proxy=False))
    req = _fake_request({"x-forwarded-for": "203.0.113.7"}, client_host="10.0.0.1")
    assert net.client_ip(req) == "10.0.0.1"


# ── API token expiry: optional TTL, expired tokens rejected on resolve ──


def test_token_created_without_expiry_is_non_expiring(client, auth_headers):
    resp = client.post("/api/auth/tokens", json={"name": "forever"}, headers=auth_headers)
    assert resp.status_code == 201
    assert resp.json()["expires_at"] is None


def test_token_created_with_ttl_reports_expiry(client, auth_headers):
    resp = client.post(
        "/api/auth/tokens", json={"name": "short", "expires_in_days": 30}, headers=auth_headers
    )
    assert resp.status_code == 201
    assert resp.json()["expires_at"] is not None


def test_expired_token_does_not_authenticate(client, db_session, test_user):
    from datetime import UTC, datetime, timedelta

    from opal.core.auth import create_api_token, resolve_api_token

    record, raw = create_api_token(
        db_session, test_user, "expired", expires_at=datetime.now(UTC) - timedelta(seconds=1)
    )
    db_session.commit()
    assert record.is_valid is False
    assert resolve_api_token(db_session, raw) is None


def test_unexpired_token_authenticates(client, db_session, test_user):
    from datetime import UTC, datetime, timedelta

    from opal.core.auth import create_api_token, resolve_api_token

    _, raw = create_api_token(
        db_session, test_user, "live", expires_at=datetime.now(UTC) + timedelta(days=1)
    )
    db_session.commit()
    assert resolve_api_token(db_session, raw) is not None
