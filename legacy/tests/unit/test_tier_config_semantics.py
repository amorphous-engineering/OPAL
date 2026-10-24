"""Tier behavior derives from the configured tiers, not hardcoded levels.

Covers: legacy-default derivation for config blobs written before the
semantic fields existed, the tier_semantics resolver, config-driven default
tracking / lot enforcement / auto-serial at PO receive, tier-input
validation against the configured set, and semantic-field passthrough in
the project config API — exercised with a 2-tier and a 6-tier project.
"""

import pytest
from fastapi.testclient import TestClient

import opal.config as config_mod
from opal.config import PROJECT_CONFIG_KEY, set_app_setting
from opal.project import (
    PartNumberingConfig,
    ProjectConfig,
    TierConfig,
    tier_semantics,
)


@pytest.fixture(autouse=True)
def _isolate_active_project(monkeypatch):
    """Module-global _active_project must not leak between tests."""
    monkeypatch.setattr(config_mod, "_active_project", None)


def _activate(project: ProjectConfig) -> ProjectConfig:
    config_mod._active_project = project
    return project


def _make_project(tiers: list[TierConfig]) -> ProjectConfig:
    return ProjectConfig(
        name="Tiered",
        tiers=tiers,
        part_numbering=PartNumberingConfig(prefix="TP"),
    )


# Semantics deliberately diverge from the legacy level rules so a hardcoded
# check can't pass by coincidence.
def _two_tier_project() -> ProjectConfig:
    return _make_project(
        [
            TierConfig(
                level=1,
                name="Critical",
                code="C",
                default_tracking="serialized",
                require_lot=True,
                auto_serial=False,  # legacy rule would auto-serial tier 1
            ),
            TierConfig(
                level=2,
                name="Shop",
                code="S",
                default_tracking="bulk",  # legacy rule would serialize tier 2
                require_lot=False,  # legacy rule would require a lot
                auto_serial=False,
            ),
        ]
    )


def _six_tier_project() -> ProjectConfig:
    return _make_project(
        [
            TierConfig(level=1, name="Flight", code="F"),
            TierConfig(level=2, name="Qual", code="Q"),
            TierConfig(level=3, name="EDU", code="E"),
            TierConfig(
                level=4,
                name="Bench",
                code="B",
                default_tracking="serialized",
                auto_serial=True,  # legacy rule stops auto-serial at tier 1
            ),
            TierConfig(level=5, name="GSE", code="G"),
            TierConfig(
                level=6,
                name="Consumable",
                code="X",
                require_lot=True,  # legacy rule stops lot enforcement at tier 2
            ),
        ]
    )


# ---- TierConfig legacy derivation ----


def test_tier_config_derives_legacy_semantics_when_absent():
    """Old blobs/yaml omit the semantic fields; the level rules fill them."""
    t1 = TierConfig(level=1, name="Flight", code="F")
    assert (t1.default_tracking, t1.require_lot, t1.auto_serial) == ("serialized", True, True)

    t2 = TierConfig(level=2, name="Ground", code="G")
    assert (t2.default_tracking, t2.require_lot, t2.auto_serial) == ("serialized", True, False)

    t3 = TierConfig(level=3, name="Loose", code="L")
    assert (t3.default_tracking, t3.require_lot, t3.auto_serial) == ("bulk", False, False)

    t7 = TierConfig(level=7, name="Scrap", code="Z")
    assert (t7.default_tracking, t7.require_lot, t7.auto_serial) == ("bulk", False, False)


def test_tier_config_explicit_semantics_win_over_derivation():
    t = TierConfig(level=3, name="Kit", code="K", default_tracking="serialized", require_lot=True)
    assert t.default_tracking == "serialized"
    assert t.require_lot is True
    assert t.auto_serial is False  # still derived: legacy tier 3 never auto-serials


def test_old_config_blob_loads_with_legacy_semantics(db_session):
    """A stored project_config written before the semantic fields existed
    deserializes with the historical behavior intact."""
    raw = (
        '{"name": "Legacy", "tiers": ['
        '{"level": 1, "name": "Flight", "code": "F", "description": ""},'
        '{"level": 2, "name": "Ground", "code": "G", "description": ""},'
        '{"level": 3, "name": "Loose", "code": "L", "description": ""}]}'
    )
    set_app_setting(db_session, PROJECT_CONFIG_KEY, raw)
    db_session.commit()

    loaded = config_mod.load_project_from_db(db_session)
    assert loaded is not None
    assert loaded.get_tier(1).auto_serial is True
    assert loaded.get_tier(2).default_tracking == "serialized"
    assert loaded.get_tier(2).require_lot is True
    assert loaded.get_tier(3).default_tracking == "bulk"
    assert loaded.get_tier(3).require_lot is False


def test_tier_semantics_falls_back_to_legacy_rules():
    # No project at all
    assert tier_semantics(None, 1).default_tracking == "serialized"
    assert tier_semantics(None, 3).default_tracking == "bulk"
    assert tier_semantics(None, 2).require_lot is True
    # Level missing from the configured set (legacy part rows)
    project = _two_tier_project()
    assert tier_semantics(project, 9).default_tracking == "bulk"
    assert tier_semantics(project, 9).require_lot is False
    # Configured level wins
    assert tier_semantics(project, 2).default_tracking == "bulk"
    assert tier_semantics(project, 2).require_lot is False


# ---- Default tracking type on part creation ----


def test_create_part_default_tracking_from_config(client: TestClient):
    _activate(_two_tier_project())
    resp = client.post("/api/parts", json={"name": "Shop bin", "tier": 2})
    assert resp.status_code == 201, resp.text
    assert resp.json()["tracking_type"] == "bulk"  # legacy rule said serialized

    resp = client.post("/api/parts", json={"name": "Crit unit", "tier": 1})
    assert resp.status_code == 201, resp.text
    assert resp.json()["tracking_type"] == "serialized"


def test_create_part_default_tracking_six_tier(client: TestClient):
    _activate(_six_tier_project())
    resp = client.post("/api/parts", json={"name": "Bench rig", "tier": 4})
    assert resp.status_code == 201, resp.text
    assert resp.json()["tracking_type"] == "serialized"  # legacy rule said bulk


def test_next_pn_preview_reports_configured_tracking(client: TestClient):
    _activate(_six_tier_project())
    resp = client.get("/api/parts/next-pn", params={"tier": 4})
    assert resp.status_code == 200, resp.text
    body = resp.json()
    assert body["default_tracking"] == "serialized"
    assert body["tier_name"] == "Bench"


# ---- Tier input validation against the configured set ----


def test_create_part_rejects_unconfigured_tier(client: TestClient):
    _activate(_two_tier_project())
    resp = client.post("/api/parts", json={"name": "Nope", "tier": 3})
    assert resp.status_code == 422
    assert "configured tiers: 1, 2" in resp.json()["detail"]


def test_create_part_accepts_high_tier_when_configured(client: TestClient):
    _activate(_six_tier_project())
    resp = client.post("/api/parts", json={"name": "Wipes", "tier": 6})
    assert resp.status_code == 201, resp.text
    assert resp.json()["internal_pn"] == "TP-X-0001"


def test_update_part_rejects_unconfigured_tier(client: TestClient):
    _activate(_two_tier_project())
    part = client.post("/api/parts", json={"name": "Draft", "tier": 1}).json()
    resp = client.patch(f"/api/parts/{part['id']}", json={"tier": 5})
    assert resp.status_code == 422
    assert "configured tiers: 1, 2" in resp.json()["detail"]


def test_reserve_rejects_unconfigured_tier(client: TestClient):
    _activate(_two_tier_project())
    resp = client.post("/api/parts/reserve", json={"tier": 4, "count": 2})
    assert resp.status_code == 422
    assert "configured tiers: 1, 2" in resp.json()["detail"]


def test_csv_preview_validates_against_configured_tiers(client: TestClient):
    _activate(_six_tier_project())
    csv_content = "name,tier\nGood part,6\nBad part,9\n"
    resp = client.post(
        "/api/parts/import/preview",
        files={"file": ("parts.csv", csv_content.encode(), "text/csv")},
    )
    assert resp.status_code == 200, resp.text
    rows = resp.json()["rows"]
    assert rows[0]["valid"] is True  # tier 6 invalid under the old 1-5 hardcode
    assert rows[1]["valid"] is False
    assert "Tier must be one of 1, 2, 3, 4, 5, 6" in rows[1]["errors"][0]


def test_csv_preview_two_tier_rejects_tier_three(client: TestClient):
    _activate(_two_tier_project())
    csv_content = "name,tier\nLoose part,3\n"
    resp = client.post(
        "/api/parts/import/preview",
        files={"file": ("parts.csv", csv_content.encode(), "text/csv")},
    )
    assert resp.status_code == 200, resp.text
    row = resp.json()["rows"][0]
    assert row["valid"] is False  # tier 3 was always valid under the hardcode
    assert "Tier must be one of 1, 2" in row["errors"][0]


# ---- Receive enforcement from per-tier flags ----


def _create_active_part(client: TestClient, **kwargs: object) -> dict:
    resp = client.post("/api/parts", json=kwargs)
    assert resp.status_code == 201, resp.text
    part = resp.json()
    resp = client.post(f"/api/parts/{part['id']}/activate", json={"cause": "test setup"})
    assert resp.status_code == 200, resp.text
    return part


def _create_and_order_po(client: TestClient, auth_headers: dict, part_id: int) -> dict:
    resp = client.post(
        "/api/purchases",
        json={"supplier": "Test Supplier", "lines": [{"part_id": part_id, "qty_ordered": 3}]},
        headers=auth_headers,
    )
    assert resp.status_code == 201, resp.text
    resp = client.patch(
        f"/api/purchases/{resp.json()['id']}", json={"status": "ordered"}, headers=auth_headers
    )
    assert resp.status_code == 200, resp.text
    return resp.json()


def _receive(client: TestClient, auth_headers: dict, po: dict, **line_kwargs: object):
    line = {"line_id": po["lines"][0]["id"], "qty_received": 1, "location": "Bin A", **line_kwargs}
    return client.post(
        f"/api/purchases/{po['id']}/receive", json={"lines": [line]}, headers=auth_headers
    )


def test_receive_lot_required_on_configured_tier_six(client: TestClient, auth_headers: dict):
    """Tier 6 bulk requires a lot when the config says so (legacy rule: 1-2 only)."""
    _activate(_six_tier_project())
    part = _create_active_part(client, name="Solvent", tier=6, tracking_type="bulk")
    po = _create_and_order_po(client, auth_headers, part["id"])

    resp = _receive(client, auth_headers, po)
    assert resp.status_code == 422
    assert "Tier 6" in resp.json()["detail"]
    assert "lot_number" in resp.json()["detail"]

    resp = _receive(client, auth_headers, po, lot_number="LOT-X-01")
    assert resp.status_code == 200, resp.text


def test_receive_no_lot_required_when_config_disables_it(client: TestClient, auth_headers: dict):
    """2-tier config turns lot enforcement off for tier 2 (legacy rule: required)."""
    _activate(_two_tier_project())
    part = _create_active_part(client, name="Shop stock", tier=2, tracking_type="bulk")
    po = _create_and_order_po(client, auth_headers, part["id"])

    resp = _receive(client, auth_headers, po, qty_received=3)
    assert resp.status_code == 200, resp.text


def test_receive_auto_serial_on_configured_tier_four(client: TestClient, auth_headers: dict):
    """Tier 4 serialized auto-generates serials when the config says so
    (legacy rule: tier 1 only)."""
    _activate(_six_tier_project())
    part = _create_active_part(client, name="Bench rig", tier=4, tracking_type="serialized")
    po = _create_and_order_po(client, auth_headers, part["id"])

    resp = _receive(client, auth_headers, po, qty_received=2)
    assert resp.status_code == 200, resp.text

    items = client.get(f"/api/inventory?part_id={part['id']}").json()["items"]
    serials = [item["lot_number"] for item in items]
    assert len(serials) == 2
    assert all(s and s.isdigit() for s in serials), serials


def test_receive_no_auto_serial_when_config_disables_it(client: TestClient, auth_headers: dict):
    """2-tier config turns auto-serial off for tier 1 (legacy rule: on)."""
    _activate(_two_tier_project())
    part = _create_active_part(client, name="Crit unit", tier=1, tracking_type="serialized")
    po = _create_and_order_po(client, auth_headers, part["id"])

    resp = _receive(client, auth_headers, po)
    assert resp.status_code == 200, resp.text

    items = client.get(f"/api/inventory?part_id={part['id']}").json()["items"]
    assert len(items) == 1
    assert items[0]["lot_number"] is None


# ---- Project config API passthrough ----


_API_PROJECT = {
    "name": "API Project",
    "description": "",
    "tiers": [
        {"level": 1, "name": "Crit", "code": "C", "require_lot": False},
        {"level": 2, "name": "Shop", "code": "S", "default_tracking": "bulk"},
    ],
    "part_numbering": {
        "prefix": "AP",
        "separator": "-",
        "sequence_digits": 4,
        "format": "{prefix}{sep}{tier_code}{sep}{sequence}",
    },
}


def test_config_api_roundtrips_semantic_fields(client: TestClient, admin_headers: dict):
    resp = client.post("/api/project/config", json=_API_PROJECT, headers=admin_headers)
    assert resp.status_code == 200, resp.text

    tiers = {t["level"]: t for t in client.get("/api/project/config").json()["tiers"]}
    # Explicit values stored; unspecified ones derived from the legacy rules
    assert tiers[1]["require_lot"] is False
    assert tiers[1]["default_tracking"] == "serialized"
    assert tiers[1]["auto_serial"] is True
    assert tiers[2]["default_tracking"] == "bulk"
    assert tiers[2]["require_lot"] is True


def test_config_update_without_semantics_preserves_them(client: TestClient, admin_headers: dict):
    """An edit that doesn't mention the semantic fields must not reset them."""
    client.post("/api/project/config", json=_API_PROJECT, headers=admin_headers)

    updated = dict(
        _API_PROJECT,
        tiers=[
            {"level": 1, "name": "Critical", "code": "C"},  # rename only
            {"level": 2, "name": "Shop", "code": "S"},
        ],
    )
    resp = client.put("/api/project/config", json=updated, headers=admin_headers)
    assert resp.status_code == 200, resp.text

    tiers = {t["level"]: t for t in resp.json()["tiers"]}
    assert tiers[1]["name"] == "Critical"
    assert tiers[1]["require_lot"] is False  # custom value survived the edit
    assert tiers[2]["default_tracking"] == "bulk"


def test_config_update_with_explicit_semantics_applies_them(
    client: TestClient, admin_headers: dict
):
    client.post("/api/project/config", json=_API_PROJECT, headers=admin_headers)

    updated = dict(
        _API_PROJECT,
        tiers=[
            {"level": 1, "name": "Crit", "code": "C", "require_lot": True},
            {"level": 2, "name": "Shop", "code": "S", "default_tracking": "serialized"},
        ],
    )
    resp = client.put("/api/project/config", json=updated, headers=admin_headers)
    assert resp.status_code == 200, resp.text

    tiers = {t["level"]: t for t in resp.json()["tiers"]}
    assert tiers[1]["require_lot"] is True
    assert tiers[2]["default_tracking"] == "serialized"
