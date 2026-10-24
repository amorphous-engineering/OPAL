"""Ticket state: pending → in work → in review → done.

The state is derived (Issue.ticket_state); hold semantics stay about the
disposition and are asserted unchanged here.
"""

import asyncio
import json

import pytest

from opal.mcp import server


def _issue(client, **kw):
    resp = client.post("/api/issues", json={"title": "T", **kw})
    assert resp.status_code == 201, resp.text
    return resp.json()


def _post(client, issue_id, path, **kw):
    return client.post(f"/api/issues/{issue_id}/{path}", **kw)


def _sign(client, issue_id):
    resp = client.post(
        f"/api/issues/{issue_id}/disposition",
        json={"disposition_type": "use_as_is", "disposition_rationale": "ok"},
    )
    assert resp.status_code == 200, resp.text
    return resp.json()


def _get(client, issue_id):
    return client.get(f"/api/issues/{issue_id}").json()


# ---- derivation ----


def test_advisory_derivation(client):
    issue = _issue(client)
    assert issue["ticket_state"] == "pending"
    assert issue["work_started_at"] is None

    started = _post(client, issue["id"], "start").json()
    assert started["ticket_state"] == "in_work"
    assert started["work_started_at"] and started["work_started_by_id"]
    assert started["work_started_by_name"]

    reviewed = _post(client, issue["id"], "review").json()
    assert reviewed["ticket_state"] == "in_review"
    assert reviewed["review_requested_at"] and reviewed["review_requested_by_name"]

    done = _post(client, issue["id"], "signoff").json()
    assert done["ticket_state"] == "done"
    assert done["status"] == "closed"
    assert done["closed_at"] and done["closed_by_name"]


def test_containment_bearing_derivation_and_hold_unchanged(client):
    issue = _issue(client, containment="wo")
    assert issue["ticket_state"] == "pending"
    assert issue["disp_state"] == "undispositioned"

    signed = _sign(client, issue["id"])
    assert signed["ticket_state"] == "in_work"
    assert signed["disp_state"] == "dispositioned"
    assert signed["work_started_at"] is None

    assert _post(client, issue["id"], "review").json()["ticket_state"] == "in_review"
    assert _post(client, issue["id"], "signoff").json()["ticket_state"] == "done"


def test_containment_bearing_cannot_start(client):
    issue = _issue(client, containment="wo")
    resp = _post(client, issue["id"], "start")
    assert resp.status_code == 400
    assert "disposition" in resp.json()["detail"]


# ---- refusals from the wrong state ----


@pytest.mark.parametrize("path", ["review", "signoff"])
def test_pending_refuses_review_and_signoff(client, path):
    issue = _issue(client)
    resp = _post(client, issue["id"], path)
    assert resp.status_code == 400
    assert "pending" in resp.json()["detail"]


def test_return_from_wrong_state(client):
    issue = _issue(client)
    resp = _post(client, issue["id"], "review/return", json={"comment": "x"})
    assert resp.status_code == 400


def test_start_twice_refused(client):
    issue = _issue(client)
    _post(client, issue["id"], "start")
    assert _post(client, issue["id"], "start").status_code == 400


def test_signoff_from_in_work_refused(client):
    issue = _issue(client)
    _post(client, issue["id"], "start")
    resp = _post(client, issue["id"], "signoff")
    assert resp.status_code == 400
    assert "in work" in resp.json()["detail"]
    assert _get(client, issue["id"])["status"] == "open"


def test_done_refuses_every_transition(client):
    iid = _issue(client)["id"]
    for path in ("start", "review", "signoff"):
        _post(client, iid, path)
    for path in ("start", "review", "signoff"):
        assert _post(client, iid, path).status_code == 400
    assert _post(client, iid, "review/return", json={"comment": "x"}).status_code == 400


def test_unknown_issue_404(client):
    assert _post(client, 99999, "start").status_code == 404


# ---- return ----


def test_return_requires_comment(client):
    iid = _issue(client)["id"]
    _post(client, iid, "start")
    _post(client, iid, "review")
    assert _post(client, iid, "review/return", json={}).status_code == 422
    assert _post(client, iid, "review/return", json={"comment": "   "}).status_code == 400
    assert _get(client, iid)["ticket_state"] == "in_review"


def test_return_clears_review_and_stores_comment(client):
    iid = _issue(client)["id"]
    _post(client, iid, "start")
    _post(client, iid, "review")
    resp = _post(client, iid, "review/return", json={"comment": "torque value missing"})
    assert resp.status_code == 200
    body = resp.json()
    assert body["ticket_state"] == "in_work"
    assert body["review_requested_at"] is None
    assert body["review_requested_by_id"] is None
    assert body["work_started_at"] is not None
    comments = client.get(f"/api/issues/{iid}/comments").json()
    assert any("torque value missing" in c["body"] for c in comments)
    assert _post(client, iid, "review").json()["ticket_state"] == "in_review"


# ---- sign-off close rules ----


def test_signoff_nc_needs_corrective_action(client):
    iid = _issue(client, issue_type="non_conformance")["id"]
    _post(client, iid, "start")
    _post(client, iid, "review")
    resp = _post(client, iid, "signoff")
    assert resp.status_code == 400
    assert "corrective action" in resp.json()["detail"]
    assert _get(client, iid)["ticket_state"] == "in_review"

    client.patch(f"/api/issues/{iid}", json={"corrective_action": "re-torqued"})
    assert _post(client, iid, "signoff").json()["ticket_state"] == "done"


# ---- PATCH compatibility and reopen ----


def test_patch_close_sets_stamps_and_state(client):
    iid = _issue(client)["id"]
    body = client.patch(f"/api/issues/{iid}", json={"status": "closed"}).json()
    assert body["ticket_state"] == "done"
    assert body["closed_at"] and body["closed_by_id"]


def test_reopen_clears_stamps_and_rederives(client):
    iid = _issue(client)["id"]
    _post(client, iid, "start")
    _post(client, iid, "review")
    _post(client, iid, "signoff")
    body = client.patch(f"/api/issues/{iid}", json={"status": "open"}).json()
    assert body["closed_at"] is None and body["closed_by_id"] is None
    assert body["review_requested_at"] is None
    assert body["ticket_state"] == "in_work"  # work start is kept


def test_reopen_pending_issue_closed_directly(client):
    iid = _issue(client)["id"]
    client.patch(f"/api/issues/{iid}", json={"status": "closed"})
    body = client.patch(f"/api/issues/{iid}", json={"status": "open"}).json()
    assert body["ticket_state"] == "pending"


def test_reopen_containment_bearing_rederives_in_work(client):
    iid = _issue(client, containment="wo")["id"]
    _sign(client, iid)
    _post(client, iid, "review")
    _post(client, iid, "signoff")
    body = client.patch(f"/api/issues/{iid}", json={"status": "open"}).json()
    assert body["ticket_state"] == "in_work"


# ---- list filter ----


def test_list_filter_by_state(client):
    pending = _issue(client, title="p")["id"]
    in_work = _issue(client, title="w")["id"]
    in_review = _issue(client, title="r")["id"]
    done = _issue(client, title="d")["id"]
    held = _issue(client, title="h", containment="wo")["id"]
    bearing_work = _issue(client, title="bw", containment="wo")["id"]
    _post(client, in_work, "start")
    for iid in (in_review, done):
        _post(client, iid, "start")
        _post(client, iid, "review")
    _post(client, done, "signoff")
    _sign(client, bearing_work)

    def ids(query: str) -> set[int]:
        resp = client.get(f"/api/issues?{query}&page_size=100")
        assert resp.status_code == 200, resp.text
        return {i["id"] for i in resp.json()["items"]}

    assert ids("state=pending") == {pending, held}
    assert ids("state=in_work") == {in_work, bearing_work}
    assert ids("state=in_review") == {in_review}
    assert ids("state=done") == {done}
    assert ids("state=pending&state=in_review") == {pending, held, in_review}
    assert ids("state=pending,done") == {pending, held, done}
    # the existing filters keep working
    assert done in ids("status=closed") and pending not in ids("status=closed")
    assert ids("disp_state=undispositioned") == {held}
    assert client.get("/api/issues?state=bogus").status_code == 400


def test_undispositioned_cannot_enter_review(client):
    iid = _issue(client, containment="wo")["id"]
    assert _post(client, iid, "review").status_code == 400
    assert _get(client, iid)["disp_state"] == "undispositioned"


# ---- execution document ----


def test_document_issue_entries_carry_ticket_state(client):
    proc_id = client.post("/api/procedures", json={"name": "Doc Proc"}).json()["id"]
    client.post(f"/api/procedures/{proc_id}/steps", json={"title": "S1"})
    client.post(f"/api/procedures/{proc_id}/publish")
    created = client.post("/api/procedure-instances", json={"procedure_id": proc_id})
    instance_id = created.json()["id"]
    nc = client.post(
        f"/api/procedure-instances/{instance_id}/steps/1/nc",
        json={"title": "NC", "priority": "medium"},
    ).json()

    def doc():
        return client.get(f"/api/procedure-instances/{instance_id}/document").json()

    entry = doc()["issues"][0]
    assert entry["ticket_state"] == "pending"
    assert entry["is_blocking"] is True
    assert doc()["holds"][0]["ticket_state"] == "pending"

    _sign(client, nc["id"])
    entry = doc()["issues"][0]
    assert entry["ticket_state"] == "in_work"
    assert entry["is_blocking"] is False
    _post(client, nc["id"], "review")
    assert doc()["issues"][0]["ticket_state"] == "in_review"


# ---- MCP ----


def _mcp(handler, db, args):
    result = asyncio.run(handler(db, args))
    return json.loads(result[0].text)


def test_mcp_advance_issue_and_list(client, db_session, test_user):
    iid = _issue(client)["id"]
    uid = test_user.id

    def advance(action, **extra):
        return _mcp(
            server._advance_issue,
            db_session,
            {"issue_id": iid, "action": action, "user_id": uid, **extra},
        )

    assert advance("start")["ticket_state"] == "in_work"
    assert advance("review")["ticket_state"] == "in_review"
    assert advance("return")["success"] is False
    assert advance("return", comment="redo")["ticket_state"] == "in_work"
    assert advance("review")["ticket_state"] == "in_review"
    assert advance("signoff")["success"] is False

    listed = _mcp(server._list_issues, db_session, {"state": "in_review"})
    assert [i["ticket_state"] for i in listed["issues"]] == ["in_review"]
    assert _mcp(server._list_issues, db_session, {"state": "nope"})["success"] is False
