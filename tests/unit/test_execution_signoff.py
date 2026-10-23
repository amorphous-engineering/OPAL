"""Sign-off slots: a step (or OP) carries an ordered list of sign-offs and is
complete when every slot is signed. Slot 0 carries the old COMPLETE gate; the
last signature makes the step COMPLETED. /complete and /signoff are wrappers."""

import pytest
from fastapi.testclient import TestClient
from sqlalchemy.exc import IntegrityError

from opal.core import execution_flow as flow
from opal.core.signoffs import effective_signoffs
from opal.db.models.execution import ProcedureInstance, StepExecution, StepSignoff
from opal.db.models.procedure import ProcedureVersion
from tests.conftest import grant_client_roles


@pytest.fixture(autouse=True)
def _template_roles(client, db_session):
    """Template roles must exist; the client holds the ones used here."""
    grant_client_roles(db_session, "QE", "Technician", "Engineer", "Lead", "Tech", "QA")


# ============ effective_signoffs (the one definition) ============


def test_effective_signoffs_defaults():
    # Leaf, nothing stored: the primary buyoff carries the role.
    assert effective_signoffs({"required_role": "QE"}, False) == [
        {"label": "Primary buyoff", "role": "QE"}
    ]
    # Leaf with the legacy flag: a second slot.
    assert effective_signoffs({"requires_signoff": True, "required_role": "QE"}, False) == [
        {"label": "Primary buyoff", "role": "QE"},
        {"label": "Secondary buyoff", "role": None},
    ]
    # OP with sub-steps: one slot only when flagged.
    assert effective_signoffs({"required_role": "QE"}, True) == []
    assert effective_signoffs({"requires_signoff": True, "required_role": "QE"}, True) == [
        {"label": "Sign-off", "role": "QE"}
    ]


def test_effective_signoffs_explicit_lists():
    explicit = [{"label": "Tech", "role": "Technician"}, {"label": "QA", "role": None}]
    assert effective_signoffs({"signoffs": explicit, "requires_signoff": False}, False) == explicit
    assert effective_signoffs({"signoffs": explicit}, True) == explicit
    # A leaf always has a slot; an OP with sub-steps may have none.
    assert effective_signoffs({"signoffs": [], "required_role": "QE"}, False) == [
        {"label": "Primary buyoff", "role": "QE"}
    ]
    assert effective_signoffs({"signoffs": [], "requires_signoff": True}, True) == []


# ============ builders ============


def _publish(client: TestClient, proc_id: int) -> None:
    assert client.post(f"/api/procedures/{proc_id}/publish").status_code == 201


def _cut(client: TestClient, instance_steps: dict[str, dict] | None = None):
    """One OP (1) with sub-steps 1.1 and 1.2. ``instance_steps`` maps "op", "1.1",
    "1.2" to extra StepCreate fields."""
    extra = instance_steps or {}
    proc_id = client.post("/api/procedures", json={"name": "Sign-off test"}).json()["id"]
    op = client.post(
        f"/api/procedures/{proc_id}/steps", json={"title": "Pressure test", **extra.get("op", {})}
    ).json()
    for key, title in (("1.1", "Hold 1.5x MEOP"), ("1.2", "Record leak rate")):
        r = client.post(
            f"/api/procedures/{proc_id}/steps",
            json={"title": title, "parent_step_id": op["id"], **extra.get(key, {})},
        )
        assert r.status_code == 201, r.text
    _publish(client, proc_id)
    inst = client.post("/api/procedure-instances", json={"procedure_id": proc_id}).json()
    numbers = {s["step_number_str"]: s["step_number"] for s in inst["step_executions"]}
    return inst["id"], numbers


def _status(client, iid: int, number: int) -> str:
    inst = client.get(f"/api/procedure-instances/{iid}").json()
    return next(s["status"] for s in inst["step_executions"] if s["step_number"] == number)


def _instance_status(client, iid: int) -> str:
    return client.get(f"/api/procedure-instances/{iid}").json()["status"]


def _sign(client, iid: int, number: int, slot: int, body: dict | None = None):
    return client.post(
        f"/api/procedure-instances/{iid}/steps/{number}/signoffs/{slot}", json=body or {}
    )


def _complete(client, iid: int, number: int):
    return client.post(f"/api/procedure-instances/{iid}/steps/{number}/complete", json={})


def _signoff(client, iid: int, number: int):
    return client.post(f"/api/procedure-instances/{iid}/steps/{number}/signoff")


def _row(client, iid: int, order: int) -> dict:
    doc = client.get(f"/api/procedure-instances/{iid}/document").json()
    for op in doc["ops"]:
        if op["step"]["order"] == order:
            return op["step"]
        for s in op["steps"]:
            if s["order"] == order:
                return s
    raise AssertionError(order)


TWO = {"requires_signoff": True}
THREE = {
    "signoffs": [
        {"label": "Technician", "role": "Technician"},
        {"label": "Engineer", "role": "Engineer"},
        {"label": "Quality", "role": None},
    ]
}


# ============ template API ============


def test_signoffs_write_derives_legacy_fields(client):
    proc_id = client.post("/api/procedures", json={"name": "T"}).json()["id"]
    step = client.post(f"/api/procedures/{proc_id}/steps", json={"title": "Leaf", **THREE}).json()
    assert [s["label"] for s in step["signoffs"]] == ["Technician", "Engineer", "Quality"]
    assert step["requires_signoff"] is True  # more than one slot
    assert step["required_role"] == "Technician"  # slot 0 role

    one = client.patch(
        f"/api/procedures/{proc_id}/steps/{step['id']}",
        json={"signoffs": [{"label": "Solo", "role": None}]},
    ).json()
    assert one["requires_signoff"] is False
    assert one["required_role"] is None

    # An empty list on a leaf falls back to the default primary slot.
    empty = client.patch(
        f"/api/procedures/{proc_id}/steps/{step['id']}", json={"signoffs": []}
    ).json()
    assert [s["label"] for s in empty["signoffs"]] == ["Primary buyoff"]


def test_legacy_writes_still_work_and_carry_into_explicit_list(client):
    proc_id = client.post("/api/procedures", json={"name": "T"}).json()["id"]
    step = client.post(
        f"/api/procedures/{proc_id}/steps", json={"title": "Leaf", "required_role": "QE"}
    ).json()
    assert step["signoffs"] == [{"label": "Primary buyoff", "role": "QE"}]

    two = client.patch(
        f"/api/procedures/{proc_id}/steps/{step['id']}", json={"requires_signoff": True}
    ).json()
    assert [s["label"] for s in two["signoffs"]] == ["Primary buyoff", "Secondary buyoff"]

    # With a custom list stored, a legacy role write lands on slot 0.
    client.patch(
        f"/api/procedures/{proc_id}/steps/{step['id']}",
        json={"signoffs": [{"label": "A", "role": None}, {"label": "B", "role": None}]},
    )
    after = client.patch(
        f"/api/procedures/{proc_id}/steps/{step['id']}", json={"required_role": "Lead"}
    ).json()
    assert after["signoffs"][0] == {"label": "A", "role": "Lead"}
    assert after["signoffs"][1]["label"] == "B"
    off = client.patch(
        f"/api/procedures/{proc_id}/steps/{step['id']}", json={"requires_signoff": False}
    ).json()
    assert [s["label"] for s in off["signoffs"]] == ["A"]


def test_blank_signoff_label_is_rejected(client):
    proc_id = client.post("/api/procedures", json={"name": "T"}).json()["id"]
    r = client.post(
        f"/api/procedures/{proc_id}/steps",
        json={"title": "Leaf", "signoffs": [{"label": "   ", "role": None}]},
    )
    assert r.status_code == 422


def test_draft_publish_clone_and_diff_carry_signoffs(client):
    proc_id = client.post("/api/procedures", json={"name": "T"}).json()["id"]
    client.post(f"/api/procedures/{proc_id}/steps", json={"title": "Leaf", **THREE})
    draft = client.get(f"/api/procedures/{proc_id}/draft").json()
    assert [s["label"] for s in draft["steps"][0]["signoffs"]] == [
        "Technician",
        "Engineer",
        "Quality",
    ]

    v1 = client.post(f"/api/procedures/{proc_id}/publish").json()
    version = client.get(f"/api/procedures/versions/{v1['id']}").json()
    snap = version["content"]["steps"][0]
    assert [s["label"] for s in snap["signoffs"]] == ["Technician", "Engineer", "Quality"]

    # Clone keeps the list.
    step_id = draft["steps"][0]["id"]
    dup = client.post(f"/api/procedures/{proc_id}/steps/{step_id}/duplicate").json()
    assert [s["label"] for s in dup["signoffs"]] == ["Technician", "Engineer", "Quality"]

    # Editing the list is a change between versions.
    client.patch(
        f"/api/procedures/{proc_id}/steps/{step_id}",
        json={"signoffs": [{"label": "Technician", "role": "Technician"}]},
    )
    v2 = client.post(f"/api/procedures/{proc_id}/publish").json()
    diff = client.get(f"/api/procedures/{proc_id}/versions/{v1['id']}/diff/{v2['id']}").json()
    changed = next(s for s in diff["steps"] if s["step_number"] == "1")["changed_fields"]
    assert "signoffs" in changed


def test_published_version_is_immutable_to_later_signoff_edits(client):
    proc_id = client.post("/api/procedures", json={"name": "T"}).json()["id"]
    step = client.post(f"/api/procedures/{proc_id}/steps", json={"title": "Leaf", **THREE}).json()
    v1 = client.post(f"/api/procedures/{proc_id}/publish").json()
    client.patch(
        f"/api/procedures/{proc_id}/steps/{step['id']}",
        json={"signoffs": [{"label": "Only", "role": None}]},
    )
    version = client.get(f"/api/procedures/versions/{v1['id']}").json()
    assert len(version["content"]["steps"][0]["signoffs"]) == 3


# ============ two-slot step ============


def test_two_slot_step_completes_only_after_slot_one(client):
    iid, n = _cut(client, {"1.1": TWO})
    s = n["1.1"]

    r = _sign(client, iid, s, 0)
    assert r.status_code == 200, r.text
    body = r.json()
    assert body["status"] == "awaiting_signoff"
    assert [x["slot"] for x in body["signoffs"]] == [0, 1]
    assert body["signoffs"][0]["signed_by"]["name"]
    assert body["signoffs"][1]["signed_by"] is None

    # The other sub-step finishing does not close the OP or the work order.
    assert _sign(client, iid, n["1.2"], 0).status_code == 200
    assert _status(client, iid, n["1"]) != "completed"
    assert _instance_status(client, iid) != "completed"

    r = _sign(client, iid, s, 1)
    assert r.status_code == 200, r.text
    assert r.json()["status"] == "completed"
    assert _status(client, iid, n["1"]) == "completed"
    assert _instance_status(client, iid) == "completed"


def test_document_signoffs_with_can_sign_and_blockers(client):
    iid, n = _cut(client, {"1.1": TWO})
    row = _row(client, iid, n["1.1"])
    assert [(s["slot"], s["label"]) for s in row["signoffs"]] == [
        (0, "Primary buyoff"),
        (1, "Secondary buyoff"),
    ]
    s0, s1 = row["signoffs"]
    assert s0["can_sign"] is True and s0["blockers"] == []
    # Slot 1 cannot be signed before slot 0, and says why.
    assert s1["can_sign"] is False
    assert s1["blockers"][0]["message"] == "Waiting on Primary buyoff"
    assert s0["signed_by"] is None and s0["signed_at"] is None

    _sign(client, iid, n["1.1"], 0)
    row = _row(client, iid, n["1.1"])
    s0, s1 = row["signoffs"]
    assert s0["signed_by"]["name"] and s0["signed_at"]
    assert s0["can_sign"] is False
    assert s1["can_sign"] is True and s1["blockers"] == []
    # The old gates stay.
    assert row["complete_blockers"] == []


# ============ slot 0 gating ============


def test_slot_zero_validates_data_and_stores_it(client):
    schema = {
        "required_data_schema": {
            "fields": [{"name": "psi", "label": "Pressure", "type": "number", "required": True}]
        }
    }
    iid, n = _cut(client, {"1.1": schema})
    r = _sign(client, iid, n["1.1"], 0, {"data_captured": {}})
    assert r.status_code == 422
    assert "Pressure is required" in r.json()["detail"]
    assert _status(client, iid, n["1.1"]) == "pending"

    r = _sign(client, iid, n["1.1"], 0, {"data_captured": {"psi": 100}})
    assert r.status_code == 200, r.text
    assert r.json()["data_captured"] == {"psi": 100}
    assert r.json()["status"] == "completed"


def test_open_issue_blocks_slot_zero_and_later_slots(client):
    iid, n = _cut(client, {"1.1": TWO})
    s = n["1.1"]
    nc = client.post(
        f"/api/procedure-instances/{iid}/steps/{s}/nc",
        json={"title": "Leak rate over limit", "priority": "high"},
    )
    assert nc.status_code == 201, nc.text

    row = _row(client, iid, s)
    assert row["signoffs"][0]["can_sign"] is False
    assert row["signoffs"][0]["blockers"][0]["kind"] == "nc"
    r = _sign(client, iid, s, 0)
    assert r.status_code == 400
    assert nc.json()["issue_number"] in r.json()["detail"]

    # A hold raised after slot 0 was signed blocks the later slots too.
    iid2, n2 = _cut(client, {"1.1": TWO})
    _sign(client, iid2, n2["1.1"], 0)
    client.post(
        f"/api/procedure-instances/{iid2}/steps/{n2['1.1']}/nc",
        json={"title": "Late finding", "priority": "high"},
    )
    assert _sign(client, iid2, n2["1.1"], 1).status_code == 400
    assert _status(client, iid2, n2["1.1"]) == "awaiting_signoff"
    assert _row(client, iid2, n2["1.1"])["signoffs"][1]["blockers"][0]["kind"] == "nc"


def test_slot_one_before_slot_zero_is_refused(client):
    iid, n = _cut(client, {"1.1": TWO})
    r = _sign(client, iid, n["1.1"], 1)
    assert r.status_code == 400
    assert "Primary buyoff" in r.json()["detail"]
    assert _status(client, iid, n["1.1"]) == "pending"


def test_unknown_slot_is_404_and_inactive_instance_refused(client):
    iid, n = _cut(client)
    assert _sign(client, iid, n["1.1"], 5).status_code == 404
    client.patch(f"/api/procedure-instances/{iid}", json={"status": "aborted"})
    assert _sign(client, iid, n["1.1"], 0).status_code == 400


def test_later_slots_sign_in_any_order(client):
    iid, n = _cut(client, {"1.1": THREE})
    s = n["1.1"]
    assert _sign(client, iid, s, 0).json()["status"] == "awaiting_signoff"
    assert _sign(client, iid, s, 2).json()["status"] == "awaiting_signoff"
    last = _sign(client, iid, s, 1)
    assert last.status_code == 200
    assert last.json()["status"] == "completed"
    assert [x["slot"] for x in last.json()["signoffs"] if x["signed_by"]] == [0, 1, 2]


# ============ OP slots ============


def test_op_slots_open_after_children(client):
    iid, n = _cut(
        client,
        {
            "op": {
                "signoffs": [
                    {"label": "OP lead", "role": "Lead"},
                    {"label": "OP quality", "role": None},
                ]
            }
        },
    )
    op = n["1"]
    row = _row(client, iid, op)
    assert all(not s["can_sign"] for s in row["signoffs"])
    assert "sub-steps" in row["signoffs"][0]["blockers"][0]["message"]
    assert _sign(client, iid, op, 0).status_code == 400

    _sign(client, iid, n["1.1"], 0)
    _sign(client, iid, n["1.2"], 0)
    assert _status(client, iid, op) == "awaiting_signoff"
    assert _instance_status(client, iid) != "completed"
    row = _row(client, iid, op)
    assert row["signoffs"][0]["can_sign"] is True
    assert row["signoffs"][1]["can_sign"] is False

    r = _sign(client, iid, op, 0)
    assert r.status_code == 200, r.text
    assert r.json()["status"] == "awaiting_signoff"
    assert _instance_status(client, iid) != "completed"
    r = _sign(client, iid, op, 1)
    assert r.json()["status"] == "completed"
    assert _instance_status(client, iid) == "completed"


def test_op_without_signoffs_completes_itself(client):
    iid, n = _cut(client)
    _sign(client, iid, n["1.1"], 0)
    _sign(client, iid, n["1.2"], 0)
    assert _status(client, iid, n["1"]) == "completed"
    assert _instance_status(client, iid) == "completed"
    assert _row(client, iid, n["1"])["signoffs"] == []


# ============ concurrency ============


def test_double_sign_is_refused(client):
    iid, n = _cut(client, {"1.1": TWO})
    assert _sign(client, iid, n["1.1"], 0).status_code == 200
    r = _sign(client, iid, n["1.1"], 0)
    assert r.status_code == 400
    assert "awaiting sign-off" in r.json()["detail"]
    assert _sign(client, iid, n["1.1"], 1).status_code == 200
    r = _sign(client, iid, n["1.1"], 1)
    assert r.status_code == 400


def test_concurrent_signers_one_wins_at_the_unique_key(client, db_session, monkeypatch):
    """Two signers read the same unsigned state; the (step, slot) key refuses the
    loser even though its pre-check saw nothing."""
    iid, n = _cut(client, {"1.1": TWO})
    instance = db_session.get(ProcedureInstance, iid)
    step_exec = next(se for se in instance.step_executions if se.step_number == n["1.1"])
    user_id = instance.started_by_id

    flow.sign_step_flow(db_session, instance, step_exec, 0, user_id)
    db_session.commit()

    # The second signer's stale read: slot 0 looks unsigned.
    monkeypatch.setattr(flow, "signed_slots", lambda db, se: {})
    with pytest.raises(flow.FlowError, match="Already signed"):
        flow.sign_step_flow(db_session, instance, step_exec, 0, user_id)


def test_signoff_table_enforces_unique_slot(db_session, client):
    iid, n = _cut(client)
    se = db_session.query(StepExecution).filter(StepExecution.instance_id == iid).first()
    from datetime import UTC, datetime

    now = datetime.now(UTC)
    db_session.add(StepSignoff(step_execution_id=se.id, slot=0, label="A", signed_at=now))
    db_session.flush()
    with pytest.raises(IntegrityError), db_session.begin_nested():
        db_session.add(StepSignoff(step_execution_id=se.id, slot=0, label="B", signed_at=now))
        db_session.flush()


# ============ wrappers ============


def test_complete_and_signoff_wrap_the_slot_endpoint(client):
    iid, n = _cut(client, {"1.1": TWO})
    s = n["1.1"]

    assert _signoff(client, iid, s).status_code == 400  # nothing completed yet
    r = _complete(client, iid, s)
    assert r.status_code == 200, r.text
    assert r.json()["status"] == "awaiting_signoff"
    assert r.json()["signoffs"][0]["signed_by"] is not None

    # Completing again is refused; it is waiting on a person, not on work.
    r = _complete(client, iid, s)
    assert r.status_code == 400
    assert "awaiting sign-off" in r.json()["detail"]

    r = _signoff(client, iid, s)
    assert r.status_code == 200, r.text
    assert r.json()["status"] == "completed"
    assert r.json()["signed_off_at"] is not None  # legacy column still readable
    assert _signoff(client, iid, s).status_code == 400


def test_signoff_wrapper_takes_the_next_unsigned_slot(client):
    iid, n = _cut(client, {"1.1": THREE})
    s = n["1.1"]
    _complete(client, iid, s)
    r = _signoff(client, iid, s)
    assert [x["slot"] for x in r.json()["signoffs"] if x["signed_by"]] == [0, 1]
    assert r.json()["status"] == "awaiting_signoff"
    r = _signoff(client, iid, s)
    assert r.json()["status"] == "completed"


def test_open_nc_blocks_signoff_wrapper(client):
    iid, n = _cut(client, {"1.1": TWO})
    assert _complete(client, iid, n["1.1"]).status_code == 200
    nc = client.post(
        f"/api/procedure-instances/{iid}/steps/{n['1.1']}/nc",
        json={"title": "Leak rate over limit", "priority": "high"},
    )
    assert nc.status_code == 201, nc.text
    assert _signoff(client, iid, n["1.1"]).status_code == 400
    assert _status(client, iid, n["1.1"]) == "awaiting_signoff"


# ============ legacy rows ============


def test_legacy_snapshot_without_signoffs_gets_two_slots(client, db_session):
    """A version published before sign-off lists existed (requires_signoff, no list)
    reads as Primary + Secondary buyoff."""
    iid, n = _cut(client, {"1.1": TWO})
    instance = db_session.get(ProcedureInstance, iid)
    version = db_session.get(ProcedureVersion, instance.version_id)
    content = dict(version.content)
    content["steps"] = [{k: v for k, v in s.items() if k != "signoffs"} for s in content["steps"]]
    version.content = content
    db_session.commit()

    row = _row(client, iid, n["1.1"])
    assert [s["label"] for s in row["signoffs"]] == ["Primary buyoff", "Secondary buyoff"]
    # A step that did not require sign-off has the one primary slot.
    assert [s["label"] for s in _row(client, iid, n["1.2"])["signoffs"]] == ["Primary buyoff"]
    assert _complete(client, iid, n["1.1"]).json()["status"] == "awaiting_signoff"
    assert _signoff(client, iid, n["1.1"]).json()["status"] == "completed"


def test_legacy_signed_off_status_stays_terminal(client, db_session):
    iid, n = _cut(client)
    for s in ("1.1", "1.2"):
        se = (
            db_session.query(StepExecution)
            .filter(StepExecution.instance_id == iid, StepExecution.step_number == n[s])
            .one()
        )
        se.status = "signed_off"
    db_session.commit()
    flow.check_instance_completion(db_session, db_session.get(ProcedureInstance, iid))
    db_session.commit()
    assert _status(client, iid, n["1"]) == "completed"
    assert _sign(client, iid, n["1.1"], 0).status_code == 400


# ============ note attachments ============


def _note(client, iid: int, order: int, body: str = "observed") -> dict:
    r = client.post(f"/api/procedure-instances/{iid}/steps/{order}/notes", json={"body": body})
    assert r.status_code == 201, r.text
    return r.json()


def test_note_files_appear_in_document_notes(client):
    iid, n = _cut(client)
    s = n["1.1"]
    note = _note(client, iid, s)
    img = client.post(
        "/api/attachments/upload",
        files={"file": ("leak.png", b"\x89PNG\r\n\x1a\nfake", "image/png")},
        data={"step_note_id": str(note["id"])},
    )
    assert img.status_code == 201, img.text
    assert img.json()["step_note_id"] == note["id"]
    assert img.json()["step_execution_id"] == _exec_id(client, iid, s)
    assert img.json()["procedure_instance_id"] == iid
    pdf = client.post(
        "/api/attachments/upload",
        files={"file": ("proc.pdf", b"%PDF-fake", "application/pdf")},
        data={"step_note_id": str(note["id"]), "procedure_instance_id": str(iid)},
    )
    assert pdf.status_code == 201, pdf.text
    # A legacy step attachment (no note) stays out of the notes.
    legacy = client.post(
        "/api/attachments/upload",
        files={"file": ("old.png", b"\x89PNG\r\n\x1a\nfake", "image/png")},
        data={
            "procedure_instance_id": str(iid),
            "step_execution_id": str(_exec_id(client, iid, s)),
        },
    )
    assert legacy.status_code == 201, legacy.text

    row = _row(client, iid, s)
    [doc_note] = row["notes"]
    assert doc_note["id"] == note["id"]
    assert doc_note["author"]["name"]
    assert doc_note["created_at"]
    assert doc_note["body"] == "observed"
    by_name = {a["filename"]: a for a in doc_note["attachments"]}
    assert set(by_name) == {"leak.png", "proc.pdf"}
    png = by_name["leak.png"]
    assert png["is_image"] is True and by_name["proc.pdf"]["is_image"] is False
    assert png["url"] == f"/api/attachments/{png['id']}/download"
    assert png["mime_type"] == "image/png" and png["size_bytes"] == 12
    # The legacy attachment is still on the step, the note files are not.
    assert [a["filename"] for a in row["attachments"]] == ["old.png"]


def _exec_id(client, iid: int, order: int) -> int:
    inst = client.get(f"/api/procedure-instances/{iid}").json()
    return next(s["id"] for s in inst["step_executions"] if s["step_number"] == order)


def test_note_upload_validates_the_instance(client):
    iid, n = _cut(client)
    note = _note(client, iid, n["1.1"])
    other_iid, _ = _cut(client)

    r = client.post(
        "/api/attachments/upload",
        files={"file": ("x.png", b"\x89PNG\r\n\x1a\nfake", "image/png")},
        data={"step_note_id": str(note["id"]), "procedure_instance_id": str(other_iid)},
    )
    assert r.status_code == 400
    r = client.post(
        "/api/attachments/upload",
        files={"file": ("x.png", b"\x89PNG\r\n\x1a\nfake", "image/png")},
        data={"step_note_id": "99999"},
    )
    assert r.status_code == 404
    # A note on another step of the same instance is not this step's note.
    r = client.post(
        "/api/attachments/upload",
        files={"file": ("x.png", b"\x89PNG\r\n\x1a\nfake", "image/png")},
        data={
            "step_note_id": str(note["id"]),
            "step_execution_id": str(_exec_id(client, iid, n["1.2"])),
        },
    )
    assert r.status_code == 400
    r = client.get(f"/api/attachments?step_note_id={note['id']}")
    assert r.json() == []


def test_note_on_completed_step_still_takes_files(client):
    iid, n = _cut(client)
    _sign(client, iid, n["1.1"], 0)
    note = _note(client, iid, n["1.1"], "post-mortem")
    r = client.post(
        "/api/attachments/upload",
        files={"file": ("x.png", b"\x89PNG\r\n\x1a\nfake", "image/png")},
        data={"step_note_id": str(note["id"])},
    )
    assert r.status_code == 201
