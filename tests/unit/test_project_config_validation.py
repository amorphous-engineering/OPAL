"""Project config API: input validation, custom fields, requirement catalog import."""

import pytest

import opal.config as config_mod
from opal.db.models.requirement import Requirement
from opal.project import ProjectConfig, RequirementConfig


@pytest.fixture(autouse=True)
def _isolate_active_project(monkeypatch):
    monkeypatch.setattr(config_mod, "_active_project", None)


def payload(**overrides):
    body = {
        "name": "Bench",
        "description": "",
        "tiers": [
            {"level": 1, "name": "Flight", "code": "F"},
            {"level": 2, "name": "Ground", "code": "G"},
        ],
        "part_numbering": {
            "prefix": "BP",
            "separator": "-",
            "sequence_digits": 4,
            "format": "{prefix}{sep}{tier_code}{sep}{sequence}",
        },
        "categories": ["Avionics", " Avionics ", "", "Structures"],
    }
    body.update(overrides)
    return body


def test_categories_are_trimmed_and_deduplicated(client):
    response = client.post("/api/project/config", json=payload())
    assert response.status_code == 200, response.text
    assert response.json()["categories"] == ["Avionics", "Structures"]


@pytest.mark.parametrize(
    ("override", "fragment"),
    [
        ({"name": "  "}, "name"),
        ({"tiers": []}, "at least one tier"),
        (
            {
                "tiers": [
                    {"level": 1, "name": "A", "code": "X"},
                    {"level": 2, "name": "B", "code": "X"},
                ]
            },
            "codes must be unique",
        ),
        (
            {
                "tiers": [
                    {"level": 1, "name": "A", "code": "X"},
                    {"level": 1, "name": "B", "code": "Y"},
                ]
            },
            "levels must be unique",
        ),
        ({"tiers": [{"level": 1, "name": "", "code": "F"}]}, "blank"),
        ({"tiers": [{"level": 1, "name": "Flight", "code": "F L"}]}, "spaces"),
    ],
)
def test_invalid_project_input_is_rejected(client, override, fragment):
    response = client.post("/api/project/config", json=payload(**override))
    assert response.status_code == 422
    assert fragment in response.text


@pytest.mark.parametrize(
    "fmt",
    ["{prefix}-{nope}-{sequence}", "{prefix}-{tier_code}", "{0}{sequence}", "{prefix{sequence}"],
)
def test_unrenderable_part_number_format_is_rejected(client, fmt):
    numbering = payload()["part_numbering"] | {"format": fmt}
    response = client.post("/api/project/config", json=payload(part_numbering=numbering))
    assert response.status_code == 422


def test_part_number_format_may_embed_a_literal_separator(client):
    numbering = payload()["part_numbering"] | {"format": "{prefix}.{tier_code}.{sequence}"}
    response = client.post("/api/project/config", json=payload(part_numbering=numbering))
    assert response.status_code == 200


def test_custom_fields_roundtrip_and_survive_an_update_that_omits_them(client):
    created = client.post(
        "/api/project/config", json=payload(custom_fields={"customer": "ACME", "rev": "B"})
    )
    assert created.json()["custom_fields"] == {"customer": "ACME", "rev": "B"}

    renamed = client.put("/api/project/config", json=payload(name="Renamed"))
    assert renamed.status_code == 200
    assert renamed.json()["custom_fields"] == {"customer": "ACME", "rev": "B"}

    cleared = client.put("/api/project/config", json=payload(custom_fields={}))
    assert cleared.json()["custom_fields"] == {}


def test_project_writes_are_admin_only(client, auth_headers):
    assert (
        client.post("/api/project/config", json=payload(), headers=auth_headers).status_code == 403
    )
    assert (
        client.put("/api/project/config", json=payload(), headers=auth_headers).status_code == 403
    )
    assert client.post("/api/project/requirements/import", headers=auth_headers).status_code == 403


def test_requirement_catalog_import_is_idempotent(client, db_session, monkeypatch):
    project = ProjectConfig(
        name="Legacy",
        requirements=[
            RequirementConfig(id="REQ-001", title="Survive launch", category="structures"),
            RequirementConfig(id="REQ-002", title="Deploy chute"),
        ],
    )
    monkeypatch.setattr(config_mod, "_active_project", project)

    first = client.post("/api/project/requirements/import")
    assert first.status_code == 200, first.text
    assert first.json()["created"] == ["REQ-001", "REQ-002"]
    assert db_session.query(Requirement).filter(Requirement.req_number == "REQ-001").count() == 1

    again = client.post("/api/project/requirements/import")
    assert again.json()["created"] == []
    assert again.json()["skipped"] == ["REQ-001", "REQ-002"]


def test_requirement_import_needs_a_catalog(client, monkeypatch):
    monkeypatch.setattr(config_mod, "_active_project", ProjectConfig(name="Empty"))
    assert client.post("/api/project/requirements/import").status_code == 404


def test_removing_a_tier_that_parts_use_is_refused(client, db_session):
    from opal.db.models import Part

    assert client.post("/api/project/config", json=payload()).status_code == 200
    db_session.add(Part(internal_pn="BP-G-0001", name="Bracket", tier=2))
    db_session.commit()

    only_flight = payload(tiers=[{"level": 1, "name": "Flight", "code": "F"}])
    response = client.put("/api/project/config", json=only_flight)
    assert response.status_code == 409
    assert "Ground" in response.json()["detail"]
    # Nothing was applied.
    assert len(client.get("/api/project/config").json()["tiers"]) == 2


def test_removing_an_unused_tier_keeps_the_other_levels(client):
    assert client.post("/api/project/config", json=payload()).status_code == 200
    only_ground = payload(tiers=[{"level": 2, "name": "Ground", "code": "G"}])
    response = client.put("/api/project/config", json=only_ground)
    assert response.status_code == 200
    assert [t["level"] for t in response.json()["tiers"]] == [2]
