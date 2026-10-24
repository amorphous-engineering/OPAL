"""UX-3: baseline queue, atomic batch commit, baseline events."""

import json

from opal.core.designators import generate_requirement_number
from opal.db.models import BaselineEvent, BaselineEventItem, Requirement
from opal.se.readiness import ready_requirement_ids
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


# ============ Batch commit ============


def test_batch_baselines_all_and_writes_one_event(client, db_session, test_user):
    a = _make_req(db_session, level=0)
    b = _make_req(db_session, level=1)
    db_session.commit()

    resp = client.post(
        "/api/requirements/baseline-batch",
        json={"ids": [a.id, b.id], "label": "l0-freeze", "note": "mini design freeze"},
        headers=user_headers(test_user),
    )
    assert resp.status_code == 200, resp.text
    body = resp.json()
    assert {x["id"] for x in body["baselined"]} == {a.id, b.id}

    db_session.expire_all()
    assert a.lifecycle_state == "baselined"
    assert b.lifecycle_state == "baselined"

    event = db_session.get(BaselineEvent, body["event_id"])
    assert event.label == "l0-freeze"
    assert event.signed_by_id == test_user.id
    assert {item.requirement_id for item in event.items} == {a.id, b.id}


def test_batch_atomicity_one_offender_aborts_all(client, db_session, test_user):
    clean = _make_req(db_session)
    dirty = _make_req(db_session, rationale=None)
    db_session.commit()

    resp = client.post(
        "/api/requirements/baseline-batch",
        json={"ids": [clean.id, dirty.id]},
        headers=user_headers(test_user),
    )
    assert resp.status_code == 409
    offenders = resp.json()["detail"]["offenders"]
    assert [o["id"] for o in offenders] == [dirty.id]
    assert "rationale_present" in offenders[0]["failing_checks"]

    db_session.expire_all()
    assert clean.lifecycle_state == "draft"  # nothing half-committed
    assert dirty.lifecycle_state == "draft"
    assert db_session.query(BaselineEvent).count() == 0


def test_single_dossier_baseline_writes_event_with_null_label(client, db_session, test_user):
    req = _make_req(db_session)
    db_session.commit()

    resp = client.post(f"/api/requirements/{req.id}/baseline", headers=user_headers(test_user))
    assert resp.status_code == 200

    (event,) = db_session.query(BaselineEvent).all()
    assert event.label is None
    assert [item.requirement_id for item in event.items] == [req.id]


def test_queue_endpoint_equals_ready_set(client, db_session):
    ready = _make_req(db_session)
    _make_req(db_session, tbd=True)  # blocked
    db_session.commit()

    resp = client.get("/api/requirements/queue")
    assert resp.status_code == 200
    body = resp.json()
    assert (body["count"], body["ids"]) == (1, [ready.id])
    assert body["ids"] == ready_requirement_ids(db_session)
    (item,) = body["items"]
    assert item["req_number"] == ready.req_number
    assert item["change"] is None  # first revision: nothing to compare


# ============ Queue and event views ============


def test_queue_items_carry_review_context(client, db_session, test_user):
    parent = _make_req(db_session, level=0, title="Mission root")
    child = _make_req(db_session, level=1, title="Derived", parent_id=parent.id)
    db_session.commit()

    queue = client.get("/api/requirements/queue").json()
    assert queue["count"] == 2
    by_number = {i["req_number"]: i for i in queue["items"]}
    assert by_number[child.req_number]["chain"][0]["req_number"] == parent.req_number
    assert by_number[parent.req_number]["children_count"] == 1
    # lowest level first: the review walks the flow-down top to bottom
    assert queue["items"][0]["id"] == parent.id


def test_baseline_events_list_and_detail(client, db_session, test_user):
    parent = _make_req(db_session, level=0, title="Mission root")
    child = _make_req(db_session, level=1, title="Derived", parent_id=parent.id)
    db_session.commit()
    assert client.get("/api/requirements/baselines").json() == []

    resp = client.post(
        "/api/requirements/baseline-batch",
        json={"ids": [parent.id, child.id], "label": "l0-freeze"},
        headers=user_headers(test_user),
    )
    event_id = resp.json()["event_id"]

    (listed,) = client.get("/api/requirements/baselines").json()
    assert listed["label"] == "l0-freeze"
    assert listed["locked"] == 2
    assert listed["signed_by"] == test_user.name

    detail = client.get(f"/api/requirements/baselines/{event_id}").json()
    assert {i["req_number"] for i in detail["items"]} == {parent.req_number, child.req_number}
    assert all(i["previous_revision"] is None for i in detail["items"])
    assert client.get("/api/requirements/baselines/99999").status_code == 404


def test_baseline_event_reports_what_a_revision_changed(client, db_session, test_user):
    req = _make_req(db_session)
    db_session.commit()
    headers = user_headers(test_user)
    client.post(f"/api/requirements/{req.id}/baseline", headers=headers)
    rev2_id = client.post(f"/api/requirements/{req.id}/revise", headers=headers).json()["id"]
    client.patch(
        f"/api/requirements/{rev2_id}",
        json={"statement": "The engine shall sustain a chamber pressure of 25 bar ± 1 bar."},
        headers=headers,
    )
    client.post(f"/api/requirements/{rev2_id}/baseline", headers=headers)

    events = client.get("/api/requirements/baselines").json()
    newest = max(events, key=lambda e: e["id"])
    assert newest["revised"] == 1
    detail = client.get(f"/api/requirements/baselines/{newest['id']}").json()
    (item,) = detail["items"]
    assert item["previous_revision"] == 1 and item["revision"] == 2
    assert item["changed"] == ["statement"]
    inserted = "".join(s["text"] for s in item["diff"]["statement"] if s["op"] == "insert")
    assert "25" in inserted


def test_tree_reports_queue_count_and_lint(client, db_session):
    assert client.get("/api/requirements/tree").json()["queue_count"] == 0
    _make_req(db_session)
    vague = _make_req(db_session, statement="The engine shall vent as appropriate.")
    db_session.commit()
    tree = client.get("/api/requirements/tree").json()
    assert tree["queue_count"] == 1
    row = next(i for i in tree["items"] if i["id"] == vague.id)
    assert any(f["severity"] == "block_baseline" and "span" in f for f in row["lint"])


# ============ MCP parity ============


async def _run(handler, db, args):
    result = await handler(db, args)
    return json.loads(result[0].text)


async def test_mcp_batch_requires_human_user(db_session):
    from opal.mcp import server as mcp

    req = _make_req(db_session)
    db_session.commit()

    no_user = await _run(mcp._baseline_batch, db_session, {"ids": [req.id]})
    assert "error" in no_user
    assert "human user" in no_user["error"]

    db_session.expire_all()
    assert req.lifecycle_state == "draft"


async def test_mcp_queue_batch_and_events_round_trip(db_session, test_user):
    from opal.mcp import server as mcp

    req = _make_req(db_session)
    db_session.commit()

    queue = await _run(mcp._get_baseline_queue, db_session, {})
    assert queue["count"] == 1
    assert queue["queue"][0]["id"] == req.id

    batch = await _run(
        mcp._baseline_batch,
        db_session,
        {"ids": [req.id], "user_id": test_user.id, "label": "mcp-freeze"},
    )
    assert batch["success"]

    events = await _run(mcp._get_baseline_events, db_session, {})
    assert events["count"] == 1
    assert events["events"][0]["label"] == "mcp-freeze"
    assert events["events"][0]["locked"][0]["req_number"] == req.req_number

    one = await _run(mcp._get_baseline_events, db_session, {"event_id": batch["event_id"]})
    assert one["event"]["signed_by"] == test_user.name


def test_event_items_point_at_exact_revision_rows(client, db_session, test_user):
    req = _make_req(db_session)
    db_session.commit()
    client.post(f"/api/requirements/{req.id}/baseline", headers=user_headers(test_user))

    # Revise and baseline rev 2: its event must reference the new row, not rev 1.
    rev2_id = client.post(
        f"/api/requirements/{req.id}/revise", headers=user_headers(test_user)
    ).json()["id"]
    client.post(f"/api/requirements/{rev2_id}/baseline", headers=user_headers(test_user))

    items = db_session.query(BaselineEventItem).order_by(BaselineEventItem.id).all()
    assert [i.requirement_id for i in items] == [req.id, rev2_id]
