"""UX-2: part-page requirements embedding + red-only traceability widget."""

from datetime import UTC, datetime, timedelta

from opal.core.designators import generate_requirement_number
from opal.db.models import Requirement
from opal.se.dashboard import old_block_lint_drafts, overdue_tbrs
from tests.conftest import user_headers

GOOD = "The engine shall sustain a chamber pressure of 20 bar ± 1 bar."


def _make_req(db, **overrides) -> Requirement:
    values = {
        "req_number": generate_requirement_number(db),
        "title": "Chamber pressure",
        "statement": GOOD,
        "rationale": "Sized from the mission delta-v budget.",
        "verification_method": "test",
    }
    values.update(overrides)
    req = Requirement(**values)
    db.add(req)
    db.flush()
    return req


# ============ Dashboard queries ============


def test_overdue_tbrs_only_past_due_live_rows(db_session, test_user):
    overdue = _make_req(
        db_session,
        tbr=True,
        tbr_owner_id=test_user.id,
        tbr_due=datetime.now(UTC) - timedelta(days=5),
    )
    _make_req(db_session, tbr=True, tbr_due=datetime.now(UTC) + timedelta(days=5))  # future
    _make_req(db_session)  # no TBR

    result = overdue_tbrs(db_session)
    assert [item["req"].id for item in result] == [overdue.id]
    assert result[0]["owner_name"] == test_user.name
    assert result[0]["days_over"] == 5


def test_overdue_tbr_without_owner_is_named(db_session):
    _make_req(db_session, tbr=True, tbr_due=datetime.now(UTC) - timedelta(days=2))
    (item,) = overdue_tbrs(db_session)
    assert item["owner_name"] == "(no owner)"


def test_old_block_lint_drafts_window_and_severity(db_session, test_user):
    old = datetime.now(UTC) - timedelta(days=10)
    stuck = _make_req(db_session, statement="The tank shall be sufficient.")
    stuck.created_at = old
    fresh_dirty = _make_req(db_session, statement="The pump shall be adequate.")  # too new
    clean_old = _make_req(db_session)
    clean_old.created_at = old
    baselined_old = _make_req(db_session, statement="The line shall be easy.")
    baselined_old.created_at = old
    baselined_old.lifecycle_state = "cancelled"
    db_session.flush()

    result = old_block_lint_drafts(db_session)
    assert [r.id for r in result] == [stuck.id]
    assert fresh_dirty.id not in [r.id for r in result]


# ============ API surfaces ============


def test_summary_rolls_up_coverage_and_red_items(client, db_session, test_user):
    root = _make_req(db_session, level=0)
    leaf = _make_req(db_session, level=1, parent_id=root.id)
    _make_req(db_session, tbr=True, tbr_due=datetime.now(UTC) - timedelta(days=3))
    db_session.commit()
    part = client.post("/api/parts", json={"name": "Feed Manifold"}).json()
    client.post(
        f"/api/requirements/parts/{part['id']}",
        json={"requirement_id": leaf.req_number},
        headers=user_headers(test_user),
    )

    summary = client.get("/api/requirements/summary").json()
    assert summary["total"] == 3
    assert summary["by_state"] == {"draft": 3}
    # root has a child, so the leaves are the leaf and the TBR row
    assert summary["coverage"]["leaves"] == 2
    assert summary["coverage"]["leaves_allocated"] == 1
    assert summary["verification"]["open"] == 1
    assert summary["verification"]["unallocated"] == 2
    assert len(summary["overdue_tbrs"]) == 1
    assert summary["overdue_tbrs"][0]["owner"] == "(no owner)"


def test_allocation_shows_in_dossier_and_tree_with_verification(client, db_session, test_user):
    part = client.post("/api/parts", json={"name": "Feed Manifold"}).json()
    req = _make_req(db_session, title="Feed pressure")
    db_session.commit()

    assign = client.post(
        f"/api/requirements/parts/{part['id']}",
        json={"requirement_id": req.req_number},
        headers=user_headers(test_user),
    )
    assert assign.status_code == 201, assign.text

    dossier = client.get(f"/api/requirements/{req.id}/dossier").json()
    (alloc,) = dossier["allocations"]
    assert alloc["part_name"] == "Feed Manifold"
    assert dossier["verification"] == "open"
    assert dossier["can_delete"] is False  # allocated: cancel instead

    row = next(i for i in client.get("/api/requirements/tree").json()["items"] if i["id"] == req.id)
    assert [p["name"] for p in row["parts"]] == ["Feed Manifold"]

    client.post(f"/api/requirements/allocations/{alloc['id']}/verify", json={})
    dossier = client.get(f"/api/requirements/{req.id}/dossier").json()
    assert dossier["verification"] == "verified"
    assert dossier["allocations"][0]["verified_by"] is not None


def test_allocations_follow_the_revision_chain(client, db_session, test_user):
    part = client.post("/api/parts", json={"name": "Bracket"}).json()
    req = _make_req(db_session)
    db_session.commit()
    headers = user_headers(test_user)
    client.post(
        f"/api/requirements/parts/{part['id']}",
        json={"requirement_id": req.req_number},
        headers=headers,
    )
    dossier = client.get(f"/api/requirements/{req.id}/dossier").json()
    client.post(f"/api/requirements/allocations/{dossier['allocations'][0]['id']}/verify", json={})
    client.post(f"/api/requirements/{req.id}/baseline", headers=headers)
    assert client.get(f"/api/requirements/{req.id}/dossier").json()["verification"] == "verified"
    rev2 = client.post(f"/api/requirements/{req.id}/revise", headers=headers).json()

    dossier = client.get(f"/api/requirements/{rev2['id']}/dossier").json()
    (alloc,) = dossier["allocations"]
    assert alloc["against_revision"] == 1  # allocated to rev 1, still listed on rev 2
    # A verification closed against rev 1 does not verify rev 2.
    assert alloc["status"] == "verified" and alloc["outdated"] is True
    assert dossier["verification"] == "open"
    row = next(
        i for i in client.get("/api/requirements/tree").json()["items"] if i["id"] == rev2["id"]
    )
    assert row["verification"] == "open"


def test_dossier_flowdown_and_delete_rules(client, db_session):
    root = _make_req(db_session, level=0)
    mid = _make_req(db_session, level=1, parent_id=root.id)
    leaf = _make_req(db_session, level=2, parent_id=mid.id)
    db_session.commit()

    dossier = client.get(f"/api/requirements/{leaf.id}/dossier").json()
    assert [p["req_number"] for p in dossier["parent_chain"]] == [
        root.req_number,
        mid.req_number,
    ]
    assert dossier["can_delete"] is True
    assert dossier["readiness"]["ready"] is True

    top = client.get(f"/api/requirements/{root.id}/dossier").json()
    assert [c["req_number"] for c in top["children"]] == [mid.req_number]
    assert top["can_delete"] is False

    client.post(f"/api/requirements/{leaf.id}/baseline")
    done = client.get(f"/api/requirements/{leaf.id}/dossier").json()
    assert done["readiness"] is None
    assert done["can_delete"] is False
    assert done["baseline_events"][0]["revision"] == 1


def test_assignees_lists_active_users_for_non_admins(client, auth_headers, test_user):
    resp = client.get("/api/requirements/assignees", headers=auth_headers)
    assert resp.status_code == 200
    assert test_user.name in [u["name"] for u in resp.json()]
