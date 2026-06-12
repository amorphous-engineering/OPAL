"""PN-canonical part URLs and the variant-mode form deep link.

/parts/{pn} is the canonical detail URL; id URLs still resolve but 302 to
the PN form. Parts whose PN can't live in a path segment keep id URLs.
"""

import pytest

import opal.config as config_mod
from opal.db.models import Part
from opal.project import PartNumberingConfig, ProjectConfig, TierConfig


@pytest.fixture
def variant_project(monkeypatch) -> ProjectConfig:
    project = ProjectConfig(
        name="Variant Project",
        tiers=[TierConfig(level=1, name="Flight", code="F")],
        part_numbering=PartNumberingConfig(
            prefix="RV",
            format="{prefix}{sep}{tier_code}{sep}{sequence}{sep}{variant}",
        ),
    )
    monkeypatch.setattr(config_mod, "_active_project", project)
    return project


def test_pn_url_renders_detail_directly(web_client):
    part = web_client.post("/api/parts", json={"name": "Canonical", "tier": 1}).json()
    pn = part["internal_pn"]

    page = web_client.get(f"/parts/{pn}", follow_redirects=False)
    assert page.status_code == 200
    assert pn in page.text
    assert "Canonical" in page.text


def test_id_url_redirects_to_pn(web_client):
    part = web_client.post("/api/parts", json={"name": "Redirected", "tier": 1}).json()

    response = web_client.get(f"/parts/{part['id']}", follow_redirects=False)
    assert response.status_code == 302
    assert response.headers["location"] == f"/parts/{part['internal_pn']}"

    edit = web_client.get(f"/parts/{part['id']}/edit", follow_redirects=False)
    assert edit.status_code == 302
    assert edit.headers["location"] == f"/parts/{part['internal_pn']}/edit"


def test_id_variant_url_redirects_with_suffix(web_client, variant_project):
    part = web_client.post("/api/parts", json={"name": "Sibling", "tier": 1}).json()

    response = web_client.get(f"/parts/{part['id']}/variant", follow_redirects=False)
    assert response.status_code == 302
    assert response.headers["location"] == f"/parts/{part['internal_pn']}/variant"


def test_pn_with_slash_stays_id_addressed(web_client, db_session):
    part = Part(name="Legacy Slash", internal_pn="PO/1-001", tier=1)
    db_session.add(part)
    db_session.commit()

    page = web_client.get(f"/parts/{part.id}", follow_redirects=False)
    assert page.status_code == 200
    assert "PO/1-001" in page.text


def test_unknown_refs_404(web_client):
    assert web_client.get("/parts/NOPE-999", follow_redirects=False).status_code == 404
    assert web_client.get("/parts/424242", follow_redirects=False).status_code == 404


def test_variant_deep_link_renders_variant_form(web_client, variant_project):
    source = web_client.post(
        "/api/parts", json={"name": "Bracket Assembly", "tier": 1, "category": "Structures"}
    ).json()
    assert source["internal_pn"] == "RV-F-0001-001"

    page = web_client.get(f"/parts/{source['internal_pn']}/variant", follow_redirects=False)
    assert page.status_code == 200
    # Form open in variant mode: next code as a locked fact, no identity inputs
    assert "VARIANT RV-F-0001-002" in page.text
    assert "CREATE VARIANT" in page.text
    assert 'value="Bracket Assembly"' in page.text
    assert 'id="pf-tier-segments"' not in page.text
    assert 'id="pf-pn"' not in page.text


def test_variant_deep_link_without_variant_format_bounces(web_client):
    # Fallback numbering has no {variant}: the deep link degrades to the page
    part = web_client.post("/api/parts", json={"name": "Plain", "tier": 1}).json()
    pn = part["internal_pn"]

    response = web_client.get(f"/parts/{pn}/variant", follow_redirects=False)
    assert response.status_code == 302
    assert response.headers["location"] == f"/parts/{pn}"
