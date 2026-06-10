"""UX-4: staleness (set on supersede, cleared on edit/re-affirm) + redlines."""

import json

from opal.core.designators import generate_requirement_number
from opal.db.models import AuditLog, Requirement
from opal.se.redline import redline_html, redline_segments

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


def _baseline_revise_baseline(client, db, test_user):
    """Parent rev 1 baselined with a child; rev 2 baselined → rev 1 supersedes."""
    headers = {"X-User-Id": str(test_user.id)}
    parent = _make_req(db, level=0)
    child = _make_req(db, level=1, parent_id=parent.id)
    db.commit()
    assert client.post(f"/api/requirements/{parent.id}/baseline", headers=headers).status_code == 200
    rev2_id = client.post(f"/api/requirements/{parent.id}/revise", headers=headers).json()["id"]
    client.patch(
        f"/api/requirements/{rev2_id}",
        json={"statement": "The engine shall sustain a chamber pressure of 25 bar ± 1 bar."},
        headers=headers,
    )
    assert client.post(f"/api/requirements/{rev2_id}/baseline", headers=headers).status_code == 200
    db.expire_all()
    return parent, child, rev2_id


# ============ Staleness lifecycle ============


def test_children_go_stale_when_parent_revision_supersedes(client, db_session, test_user):
    parent, child, _ = _baseline_revise_baseline(client, db_session, test_user)
    assert parent.lifecycle_state == "superseded"
    assert child.stale is True


def test_baselining_without_supersede_marks_nothing(client, db_session, test_user):
    parent = _make_req(db_session, level=0)
    child = _make_req(db_session, level=1, parent_id=parent.id)
    db_session.commit()
    client.post(f"/api/requirements/{parent.id}/baseline", headers={"X-User-Id": str(test_user.id)})
    db_session.expire_all()
    assert child.stale is False


def test_edit_clears_stale(client, db_session, test_user):
    _, child, _ = _baseline_revise_baseline(client, db_session, test_user)
    assert child.stale
    resp = client.patch(
        f"/api/requirements/{child.id}",
        json={"rationale": "Re-derived against parent rev 2."},
        headers={"X-User-Id": str(test_user.id)},
    )
    assert resp.status_code == 200
    assert resp.json()["stale"] is False


def test_reaffirm_clears_stale_and_audit_logs(client, db_session, test_user):
    _, child, _ = _baseline_revise_baseline(client, db_session, test_user)
    headers = {"X-User-Id": str(test_user.id)}

    resp = client.post(f"/api/requirements/{child.id}/reaffirm", headers=headers)
    assert resp.status_code == 200
    assert resp.json()["stale"] is False

    audit = (
        db_session.query(AuditLog)
        .filter(AuditLog.table_name == "requirement", AuditLog.record_id == child.id)
        .order_by(AuditLog.id.desc())
        .first()
    )
    assert audit is not None
    assert audit.user_id == test_user.id
    assert "stale" in (audit.new_values or {})

    # Idempotence guard: re-affirming a non-stale row is a 409.
    assert client.post(f"/api/requirements/{child.id}/reaffirm", headers=headers).status_code == 409


def test_new_revision_starts_fresh_not_stale(client, db_session, test_user):
    _, child, _ = _baseline_revise_baseline(client, db_session, test_user)
    headers = {"X-User-Id": str(test_user.id)}
    # Baseline the stale child (stale never blocks), then revise it.
    assert client.post(f"/api/requirements/{child.id}/baseline", headers=headers).status_code == 200
    rev2 = client.post(f"/api/requirements/{child.id}/revise", headers=headers).json()
    assert rev2["stale"] is False


# ============ Redlines ============


def test_redline_segments_word_diff():
    old = "The engine shall sustain 20 bar."
    new = "The engine shall sustain 25 bar continuously."
    segments = redline_segments(old, new)
    deleted = "".join(s["text"] for s in segments if s["op"] == "delete")
    inserted = "".join(s["text"] for s in segments if s["op"] == "insert")
    assert "20" in deleted and "25" in inserted
    assert "continuously" in inserted
    assert "engine" not in deleted and "engine" not in inserted  # unchanged words stay equal


def test_redline_html_escapes_and_marks():
    html = str(redline_html("keep <old> word", "keep <new> word"))
    assert "&lt;old&gt;" in html and "&lt;new&gt;" in html
    assert '<del class="redline-del">' in html
    assert '<ins class="redline-ins">' in html


def test_redline_partial_defaults_to_superseded_revision(client, db_session, test_user):
    client.cookies.set("opal_user_id", str(test_user.id))
    parent, _, rev2_id = _baseline_revise_baseline(client, db_session, test_user)
    resp = client.get(f"/requirements/{rev2_id}/redline")
    assert resp.status_code == 200
    assert "rev 1 → rev 2" in resp.text
    assert "redline-del" in resp.text and "redline-ins" in resp.text

    explicit = client.get(f"/requirements/{rev2_id}/redline?rev_a=1&rev_b=2")
    assert explicit.status_code == 200
    missing = client.get(f"/requirements/{rev2_id}/redline?rev_a=9")
    assert missing.status_code == 404


# ============ MCP parity ============


async def _run(handler, db, args):
    result = await handler(db, args)
    return json.loads(result[0].text)


async def test_mcp_reaffirm_human_gate_and_clear(client, db_session, test_user):
    from opal.mcp import server as mcp

    _, child, _ = _baseline_revise_baseline(client, db_session, test_user)

    gated = await _run(mcp._reaffirm_requirement, db_session, {"requirement_id": child.id})
    assert "error" in gated and "human user" in gated["error"]

    ok = await _run(
        mcp._reaffirm_requirement,
        db_session,
        {"requirement_id": child.id, "user_id": test_user.id},
    )
    assert ok["success"]
    assert ok["requirement"]["stale"] is False


async def test_mcp_requirement_diff_defaults(client, db_session, test_user):
    from opal.mcp import server as mcp

    _, _, rev2_id = _baseline_revise_baseline(client, db_session, test_user)
    diff = await _run(mcp._get_requirement_diff, db_session, {"requirement_id": rev2_id})
    assert diff["rev_a"] == 1 and diff["rev_b"] == 2
    inserted = "".join(s["text"] for s in diff["statement_diff"] if s["op"] == "insert")
    assert "25" in inserted
