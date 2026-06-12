"""Part number generation and identity lifecycle tests.

No project config is loaded under test (the variant tests activate one
explicitly), so numbers use the fallback format PN-{tier}-{seq:04d}.
Counters never roll back: soft-deleted and abandoned numbers stay
consumed forever.
"""

from datetime import UTC, datetime

import pytest

import opal.config as config_mod
from opal.core.numbering import (
    PartNumberError,
    format_has_variant,
    next_part_number,
    next_variant_part_number,
    part_number_regex,
    peek_next_part_number,
    pn_exists,
    validate_part_number,
)
from opal.db.models import Part
from opal.project import PartNumberingConfig, ProjectConfig, TierConfig


def _create(client, name: str, tier: int = 1, **extra) -> dict:
    response = client.post("/api/parts", json={"name": name, "tier": tier, **extra})
    assert response.status_code == 201, response.text
    return response.json()


def test_soft_delete_never_recycles_part_numbers(client):
    """THE recycling regression: a deleted part's number is consumed forever."""
    part_a = _create(client, "Part A")
    assert part_a["internal_pn"] == "PN-1-0001"

    part_b = _create(client, "Part B")
    assert part_b["internal_pn"] == "PN-1-0002"

    delete = client.delete(f"/api/parts/{part_b['id']}")
    assert delete.status_code == 204

    part_c = _create(client, "Part C")
    assert part_c["internal_pn"] == "PN-1-0003"  # not 0002, no 409/500

    preview = client.get("/api/parts/next-pn?tier=1")
    assert preview.status_code == 200
    assert preview.json()["part_number"] == "PN-1-0004"


def test_next_pn_preview_is_non_consuming(client):
    first = client.get("/api/parts/next-pn?tier=1").json()
    second = client.get("/api/parts/next-pn?tier=1").json()
    assert first == second

    part = _create(client, "Consumer")
    assert part["internal_pn"] == first["part_number"]

    after = client.get("/api/parts/next-pn?tier=1").json()
    assert after["sequence"] == first["sequence"] + 1
    assert after["part_number"] != first["part_number"]


def test_core_next_peek_and_pn_exists(db_session):
    peeked_pn, peeked_seq = peek_next_part_number(db_session, 1)
    assert (peeked_pn, peeked_seq) == ("PN-1-0001", 1)
    # Peek does not consume: same answer twice, and next consumes that number.
    assert peek_next_part_number(db_session, 1) == (peeked_pn, peeked_seq)
    assert next_part_number(db_session, 1) == peeked_pn

    # pn_exists spans soft-deleted rows.
    part = Part(name="Ghost", internal_pn="PN-1-0002", tier=1)
    db_session.add(part)
    db_session.flush()
    assert pn_exists(db_session, "PN-1-0002")
    part.deleted_at = datetime.now(UTC)
    db_session.flush()
    assert pn_exists(db_session, "PN-1-0002")
    assert not pn_exists(db_session, "PN-1-9999")


def test_override_accepted_and_bumps_counter(client):
    override = _create(client, "Overridden", internal_pn="PN-1-0500")
    assert override["internal_pn"] == "PN-1-0500"

    auto = _create(client, "After Override")
    assert auto["internal_pn"] == "PN-1-0501"


def test_override_malformed_rejected_with_format_example(client):
    response = client.post(
        "/api/parts", json={"name": "Bad PN", "tier": 1, "internal_pn": "WIDGET-XYZ"}
    )
    assert response.status_code == 422
    detail = response.json()["detail"]
    assert "WIDGET-XYZ" in detail
    assert "PN-1-" in detail  # names the expected format by example


def test_override_duplicate_of_soft_deleted_pn_conflicts(client):
    victim = _create(client, "Victim")
    taken_pn = victim["internal_pn"]
    assert client.delete(f"/api/parts/{victim['id']}").status_code == 204

    response = client.post(
        "/api/parts", json={"name": "Squatter", "tier": 1, "internal_pn": taken_pn}
    )
    assert response.status_code == 409


def test_reserve_block_creates_contiguous_drafts(client):
    response = client.post("/api/parts/reserve", json={"tier": 2, "count": 5})
    assert response.status_code == 201
    data = response.json()

    parts = data["parts"]
    assert len(parts) == 5
    assert [p["internal_pn"] for p in parts] == [f"PN-2-{i:04d}" for i in range(1, 6)]
    assert all(p["name"].startswith("RESERVED-") for p in parts)
    assert data["first_pn"] == "PN-2-0001"
    assert data["last_pn"] == "PN-2-0005"

    after = _create(client, "After Block", tier=2)
    assert after["internal_pn"] == "PN-2-0006"


def test_reserve_count_zero_rejected(client):
    response = client.post("/api/parts/reserve", json={"tier": 2, "count": 0})
    assert response.status_code == 400


# ============ Variants ============


def _variant_project(**numbering_overrides) -> ProjectConfig:
    numbering = {
        "prefix": "RV",
        "separator": "-",
        "sequence_digits": 4,
        "variant_digits": 3,
        "format": "{prefix}{sep}{tier_code}{sep}{sequence}{sep}{variant}",
    } | numbering_overrides
    return ProjectConfig(
        name="Variant Project",
        tiers=[TierConfig(level=1, name="Flight", code="F")],
        part_numbering=PartNumberingConfig(**numbering),
    )


@pytest.fixture
def variant_project(monkeypatch) -> ProjectConfig:
    project = _variant_project()
    monkeypatch.setattr(config_mod, "_active_project", project)
    return project


def test_format_has_variant():
    assert not format_has_variant(None)
    no_variant = _variant_project(format="{prefix}{sep}{tier_code}{sep}{sequence}")
    assert not format_has_variant(no_variant)
    assert format_has_variant(_variant_project())


def test_variant_generation_and_regex_round_trip(variant_project):
    assert variant_project.generate_part_number(1, 7) == "RV-F-0007-001"
    assert variant_project.generate_part_number(1, 7, 12) == "RV-F-0007-012"

    match = part_number_regex(variant_project, 1).match("RV-F-0007-012")
    assert match
    assert match.group("sequence") == "0007"
    assert match.group("variant") == "012"
    assert validate_part_number(variant_project, 1, "RV-F-0007-012") == 7


def test_new_parts_get_variant_001(db_session, variant_project):
    assert next_part_number(db_session, 1) == "RV-F-0001-001"
    assert next_part_number(db_session, 1) == "RV-F-0002-001"


def test_next_variant_increments_and_never_recycles(db_session, variant_project):
    db_session.add(Part(name="Base", internal_pn="RV-F-0001-001", tier=1))
    db_session.flush()
    assert next_variant_part_number(db_session, 1, "RV-F-0001-001") == "RV-F-0001-002"

    # Soft-deleted variants keep their codes consumed
    db_session.add(
        Part(name="Dead", internal_pn="RV-F-0001-002", tier=1, deleted_at=datetime.now(UTC))
    )
    db_session.flush()
    assert next_variant_part_number(db_session, 1, "RV-F-0001-001") == "RV-F-0001-003"

    # Next code is max+1, and any family member is a valid source
    db_session.add(Part(name="Five", internal_pn="RV-F-0001-005", tier=1))
    db_session.flush()
    assert next_variant_part_number(db_session, 1, "RV-F-0001-005") == "RV-F-0001-006"


def test_variant_creation_never_advances_sequence_counter(db_session, variant_project):
    base_pn = next_part_number(db_session, 1)
    db_session.add(Part(name="Base", internal_pn=base_pn, tier=1))
    db_session.flush()

    next_variant_part_number(db_session, 1, base_pn)
    assert peek_next_part_number(db_session, 1) == ("RV-F-0002-001", 2)


def test_next_variant_requires_variant_format(db_session, monkeypatch):
    monkeypatch.setattr(
        config_mod,
        "_active_project",
        _variant_project(format="{prefix}{sep}{tier_code}{sep}{sequence}"),
    )
    with pytest.raises(PartNumberError):
        next_variant_part_number(db_session, 1, "RV-F-0001")


def test_next_variant_rejects_pn_from_older_format(db_session, variant_project):
    # Numbered before {variant} entered the format: family underivable
    with pytest.raises(PartNumberError):
        next_variant_part_number(db_session, 1, "RV-F-0001")


def test_variant_override_bumps_sequence_counter(client, variant_project):
    override = _create(client, "Overridden", internal_pn="RV-F-0500-004")
    assert override["internal_pn"] == "RV-F-0500-004"

    auto = _create(client, "After Override")
    assert auto["internal_pn"] == "RV-F-0501-001"


def test_draft_tier_change_regenerates_pn_and_abandons_old(client):
    draft = _create(client, "Mover")
    abandoned_pn = draft["internal_pn"]
    assert abandoned_pn == "PN-1-0001"

    patched = client.patch(f"/api/parts/{draft['id']}", json={"tier": 2})
    assert patched.status_code == 200
    data = patched.json()
    assert data["tier"] == 2
    assert data["internal_pn"].startswith("PN-2-")

    # The abandoned tier-1 number stays consumed: the counter never rolls back.
    next_tier1 = _create(client, "Next Tier 1")
    assert next_tier1["internal_pn"] != abandoned_pn
    assert next_tier1["internal_pn"] == "PN-1-0002"
