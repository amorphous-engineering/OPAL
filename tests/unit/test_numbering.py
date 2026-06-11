"""Part number generation and identity lifecycle tests.

No project config is loaded under test, so numbers use the fallback
format PN-{tier}-{seq:04d}. Counters never roll back: soft-deleted and
abandoned numbers stay consumed forever.
"""

from datetime import UTC, datetime

from opal.core.numbering import next_part_number, peek_next_part_number, pn_exists
from opal.db.models import Part


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
