"""Project config API: DB-backed create/update, no filesystem writes."""

import pytest

import opal.config as config_mod
from opal.config import PROJECT_CONFIG_KEY, get_app_setting


@pytest.fixture(autouse=True)
def _isolate_active_project(monkeypatch):
    monkeypatch.setattr(config_mod, "_active_project", None)


@pytest.fixture
def admin_headers(db_session):
    from opal.db.models import User

    admin = User(
        name="Admin",
        email="admin@test.local",
        is_active=True,
        is_admin=True,
        needs_profile_setup=False,
        needs_onboarding=False,
    )
    db_session.add(admin)
    db_session.flush()
    return {"X-User-Id": str(admin.id)}


_PAYLOAD = {
    "name": "Bench Project",
    "description": "test bench",
    "tiers": [{"level": 1, "name": "FLIGHT", "code": "F", "description": ""}],
    "part_numbering": {
        "prefix": "BP",
        "separator": "-",
        "sequence_digits": 4,
        "format": "{prefix}{sep}{tier_code}{sep}{sequence}",
    },
    "categories": ["Test"],
}


def test_create_persists_blob(client, db_session, admin_headers, tmp_path, monkeypatch):
    monkeypatch.chdir(tmp_path)
    resp = client.post("/api/project/config", json=_PAYLOAD, headers=admin_headers)
    assert resp.status_code == 200, resp.text
    assert resp.json()["name"] == "Bench Project"

    # Stored in the database, not on disk
    assert "Bench Project" in (get_app_setting(db_session, PROJECT_CONFIG_KEY) or "")
    assert not (tmp_path / "opal.project.yaml").exists()

    detail = client.get("/api/project/config")
    assert detail.status_code == 200
    assert detail.json()["part_numbering"]["prefix"] == "BP"


def test_second_create_rejected(client, admin_headers):
    assert (
        client.post("/api/project/config", json=_PAYLOAD, headers=admin_headers).status_code == 200
    )
    resp = client.post("/api/project/config", json=_PAYLOAD, headers=admin_headers)
    assert resp.status_code == 400
    assert "already" in resp.json()["detail"]


def test_update_persists(client, db_session, admin_headers):
    client.post("/api/project/config", json=_PAYLOAD, headers=admin_headers)

    updated = dict(_PAYLOAD, name="Renamed Project")
    resp = client.put("/api/project/config", json=updated, headers=admin_headers)
    assert resp.status_code == 200
    assert resp.json()["name"] == "Renamed Project"
    assert "Renamed Project" in (get_app_setting(db_session, PROJECT_CONFIG_KEY) or "")


def test_create_requires_admin(client, db_session, test_user):
    resp = client.post(
        "/api/project/config", json=_PAYLOAD, headers={"X-User-Id": str(test_user.id)}
    )
    assert resp.status_code in (401, 403)
