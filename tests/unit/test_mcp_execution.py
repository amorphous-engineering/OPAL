"""Tests for the OPAL MCP execution document tools.

The MCP handlers are sync-style coroutines that take ``(db, args)`` and return
a list of ``TextContent``. We import them directly and exercise them against
the in-memory test DB session, parsing the JSON payload they emit. Handlers
call ``db.commit()`` — the conftest connection-bound session turns that into a
savepoint release, rolled back per-test (same pattern as test_mcp_tools.py).
"""

import asyncio
import json
from typing import Any

from opal.config import get_active_settings
from opal.db.models import Attachment, Issue, ProcedureStep
from opal.mcp import server
from tests.conftest import user_headers


def _call(handler, db, args: dict) -> dict[str, Any]:
    """Run a handler coroutine and return the parsed JSON payload."""
    result = asyncio.run(handler(db, args))
    assert len(result) == 1
    return json.loads(result[0].text)


def _create_procedure_with_steps(client) -> int:
    """Create a procedure with 3 steps and publish it (mirrors test_execution.py)."""
    proc_response = client.post("/api/procedures", json={"name": "Test Procedure"})
    proc_id = proc_response.json()["id"]

    client.post(f"/api/procedures/{proc_id}/steps", json={"title": "Step 1"})
    client.post(f"/api/procedures/{proc_id}/steps", json={"title": "Step 2"})
    client.post(f"/api/procedures/{proc_id}/steps", json={"title": "Step 3"})

    client.post(f"/api/procedures/{proc_id}/publish")
    return proc_id


def _create_instance(client) -> tuple[int, str]:
    """Create a published procedure + instance; returns (instance_id, work_order)."""
    proc_id = _create_procedure_with_steps(client)
    resp = client.post("/api/procedure-instances", json={"procedure_id": proc_id})
    body = resp.json()
    return body["id"], body["work_order_number"]


# ============ get_execution_state ============


def test_get_execution_state_by_execution_id(client, db_session):
    instance_id, work_order = _create_instance(client)

    data = _call(server._get_execution_state, db_session, {"execution_id": instance_id})
    assert data["instance"]["id"] == instance_id
    assert data["instance"]["work_order"] == work_order
    assert data["instance"]["status"] == "cut"
    assert data["instance"]["procedure_name"] == "Test Procedure"
    assert data["instance"]["progress"] == {"done": 0, "total": 3}
    assert [s["order"] for s in data["steps"]] == [1, 2, 3]
    assert all(s["status"] == "pending" for s in data["steps"])
    assert all(s["cursors"] == [] for s in data["steps"])
    assert data["roster"] == []
    assert data["holds"] == []
    assert data["generated_at"]  # ISO timestamp present


def test_get_execution_state_by_work_order(client, db_session):
    instance_id, work_order = _create_instance(client)

    data = _call(server._get_execution_state, db_session, {"work_order": work_order})
    assert data["instance"]["id"] == instance_id
    assert data["instance"]["work_order"] == work_order


def test_get_execution_state_unknown(db_session):
    data = _call(server._get_execution_state, db_session, {"execution_id": 999999})
    assert "error" in data

    data = _call(server._get_execution_state, db_session, {"work_order": "WO-NOPE"})
    assert "error" in data

    data = _call(server._get_execution_state, db_session, {})
    assert "error" in data


# ============ join_execution ============


def test_join_execution_requires_user_and_registers_observer(client, db_session, test_user):
    instance_id, _ = _create_instance(client)

    data = _call(server._join_execution, db_session, {"execution_id": instance_id})
    assert "error" in data
    assert "user_id" in data["error"]

    data = _call(
        server._join_execution,
        db_session,
        {"execution_id": instance_id, "user_id": test_user.id},
    )
    assert data["success"] is True
    assert test_user.name in data["message"]
    assert [p["user_id"] for p in data["participants"]] == [test_user.id]

    # Idempotent re-join: same participant, refreshed, never duplicated.
    data = _call(
        server._join_execution,
        db_session,
        {"execution_id": instance_id, "user_id": test_user.id},
    )
    assert data["success"] is True
    assert len(data["participants"]) == 1

    # A joined user with no cursor appears in the roster, step_order None.
    state = _call(server._get_execution_state, db_session, {"execution_id": instance_id})
    assert len(state["roster"]) == 1
    assert state["roster"][0]["user_id"] == test_user.id
    assert state["roster"][0]["step_order"] is None
    assert state["roster"][0]["focused_at"] is None


# ============ focus_step ============


def test_focus_step_requires_user_id(client, db_session):
    instance_id, _ = _create_instance(client)

    data = _call(server._focus_step, db_session, {"execution_id": instance_id, "step_number": 1})
    assert "error" in data
    assert "user_id" in data["error"]


def test_focus_step_happy(client, db_session, test_user):
    instance_id, _ = _create_instance(client)

    data = _call(
        server._focus_step,
        db_session,
        {"execution_id": instance_id, "step_number": 1, "user_id": test_user.id},
    )
    assert data["success"] is True
    assert test_user.name in data["message"]
    assert data["step_number"] == 1
    assert data["focused_at"]

    state = _call(server._get_execution_state, db_session, {"execution_id": instance_id})
    step1 = next(s for s in state["steps"] if s["order"] == 1)
    assert [c["user_id"] for c in step1["cursors"]] == [test_user.id]
    # Focus is presence only: no status change, the WO stays cut.
    assert step1["status"] == "pending"
    assert state["instance"]["status"] == "cut"
    # Cursor holders lead the roster with their step.
    assert state["roster"][0]["user_id"] == test_user.id
    assert state["roster"][0]["step_order"] == 1


def test_focus_step_shared_by_two_users(client, db_session, test_user, admin_user):
    """Several users may sit on the same step — both cursors render."""
    instance_id, _ = _create_instance(client)

    for uid in (test_user.id, admin_user.id):
        data = _call(
            server._focus_step,
            db_session,
            {"execution_id": instance_id, "step_number": 1, "user_id": uid},
        )
        assert data["success"] is True

    state = _call(server._get_execution_state, db_session, {"execution_id": instance_id})
    step1 = next(s for s in state["steps"] if s["order"] == 1)
    assert {c["user_id"] for c in step1["cursors"]} == {test_user.id, admin_user.id}


def test_focus_step_moves_own_cursor(client, db_session, test_user):
    """One cursor per (instance, user): focusing step 2 leaves step 1."""
    instance_id, _ = _create_instance(client)
    args = {"execution_id": instance_id, "user_id": test_user.id}

    assert _call(server._focus_step, db_session, {**args, "step_number": 1})["success"] is True
    assert _call(server._focus_step, db_session, {**args, "step_number": 2})["success"] is True

    state = _call(server._get_execution_state, db_session, {"execution_id": instance_id})
    step1 = next(s for s in state["steps"] if s["order"] == 1)
    step2 = next(s for s in state["steps"] if s["order"] == 2)
    assert step1["cursors"] == []
    assert [c["user_id"] for c in step2["cursors"]] == [test_user.id]
    assert step1["status"] == "pending"
    assert step2["status"] == "pending"


# ============ complete_step ============


def test_complete_step_requires_user_id(client, db_session):
    instance_id, _ = _create_instance(client)

    data = _call(server._complete_step, db_session, {"execution_id": instance_id, "step_number": 1})
    assert "error" in data
    assert "user_id" in data["error"]


def test_complete_step_reports_instance_completed_on_last_step(client, db_session, test_user):
    instance_id, _ = _create_instance(client)
    args = {"execution_id": instance_id, "user_id": test_user.id}

    data = _call(server._complete_step, db_session, {**args, "step_number": 1})
    assert data["success"] is True
    assert f"completed by {test_user.name}" in data["message"]
    assert data["instance_completed"] is False

    data = _call(server._complete_step, db_session, {**args, "step_number": 2})
    assert data["instance_completed"] is False

    data = _call(server._complete_step, db_session, {**args, "step_number": 3})
    assert data["success"] is True
    assert data["instance_completed"] is True

    state = _call(server._get_execution_state, db_session, {"execution_id": instance_id})
    assert state["instance"]["status"] == "completed"
    assert state["instance"]["progress"] == {"done": 3, "total": 3}
    step1 = next(s for s in state["steps"] if s["order"] == 1)
    assert step1["completed"]["by"] == test_user.name


def test_complete_step_records_completion(client, db_session, test_user):
    instance_id, _ = _create_instance(client)
    args = {"execution_id": instance_id, "user_id": test_user.id}

    assert _call(server._focus_step, db_session, {**args, "step_number": 1})["success"] is True
    data = _call(server._complete_step, db_session, {**args, "step_number": 1})
    assert data["success"] is True

    state = _call(server._get_execution_state, db_session, {"execution_id": instance_id})
    step1 = next(s for s in state["steps"] if s["order"] == 1)
    assert step1["status"] == "completed"
    assert step1["completed"]["by"] == test_user.name
    assert step1["completed"]["initials"] == "TU"
    # Completing releases nothing — the cursor stays where the user is.
    assert [c["user_id"] for c in step1["cursors"]] == [test_user.id]


# ============ attach_to_step ============


def test_attach_to_step_with_content(client, db_session, test_user, tmp_path, monkeypatch):
    monkeypatch.setattr(get_active_settings(), "upload_dir", tmp_path)
    instance_id, _ = _create_instance(client)

    data = _call(
        server._attach_to_step,
        db_session,
        {
            "execution_id": instance_id,
            "step_number": 1,
            "content": "torque reading: 4.2 Nm",
            "filename": "evidence.txt",
            "note": "measured with TW-3",
            "user_id": test_user.id,
        },
    )
    assert data["success"] is True
    assert "evidence.txt" in data["message"]

    row = db_session.get(Attachment, data["attachment_id"])
    assert row is not None
    assert row.kind == "capture"
    assert row.note == "measured with TW-3"
    assert row.uploaded_by_id == test_user.id
    assert row.original_filename == "evidence.txt"
    assert row.mime_type == "text/plain"
    assert row.procedure_instance_id == instance_id
    assert row.step_execution_id is not None
    assert (tmp_path / row.stored_filename).read_bytes() == b"torque reading: 4.2 Nm"

    # The state document counts the evidence on the step.
    state = _call(server._get_execution_state, db_session, {"execution_id": instance_id})
    step1 = next(s for s in state["steps"] if s["order"] == 1)
    assert step1["attachments"] == 1


def test_attach_to_step_missing_file(client, db_session, tmp_path, monkeypatch):
    monkeypatch.setattr(get_active_settings(), "upload_dir", tmp_path)
    instance_id, _ = _create_instance(client)

    data = _call(
        server._attach_to_step,
        db_session,
        {
            "execution_id": instance_id,
            "step_number": 1,
            "file_path": str(tmp_path / "does-not-exist.png"),
        },
    )
    assert "error" in data
    assert "not found" in data["error"].lower()

    # Neither file_path nor content given.
    data = _call(
        server._attach_to_step,
        db_session,
        {"execution_id": instance_id, "step_number": 1},
    )
    assert "error" in data
    assert "file_path or content" in data["error"]


# ============ add_step_note ============


def test_add_step_note_appends(client, db_session, test_user):
    from datetime import datetime

    instance_id, _ = _create_instance(client)
    args = {"execution_id": instance_id, "step_number": 2}

    data = _call(server._add_step_note, db_session, {**args, "note": "first line"})
    assert data["success"] is True
    assert data["note"]["body"] == "first line"
    assert data["note"]["author"] is None  # no user_id given: unattributed
    datetime.fromisoformat(data["note"]["created_at"])  # ISO 8601 or raises

    data = _call(
        server._add_step_note,
        db_session,
        {**args, "note": "second line", "user_id": test_user.id},
    )
    assert data["success"] is True
    assert data["note"]["author"] == test_user.name

    data = _call(server._add_step_note, db_session, {**args, "note": "   "})
    assert "error" in data

    state = _call(server._get_execution_state, db_session, {"execution_id": instance_id})
    step2 = next(s for s in state["steps"] if s["order"] == 2)
    assert [n["body"] for n in step2["notes"]] == ["first line", "second line"]
    assert step2["notes"][1]["author"] == test_user.name
    datetime.fromisoformat(step2["notes"][0]["created_at"])


# ============ bind_issue_hold ============


def test_bind_issue_hold_blocks_complete_and_is_idempotent(client, db_session, test_user):
    """bind_issue_hold sets containment boundary on the issue (R2 semantics).
    Re-binding to the same step is idempotent. COMPLETE on the bound step
    refuses while undispositioned."""
    instance_id, _ = _create_instance(client)

    issue_data = _call(
        server._raise_issue,
        db_session,
        {
            "title": "Cracked bracket found in stores",
            "issue_type": "non_conformance",
            "containment": "step",
            "procedure_instance_id": instance_id,
        },
    )
    assert issue_data["success"] is True
    issue_id = issue_data["issue"]["id"]
    issue_number = db_session.get(Issue, issue_id).issue_number
    assert issue_number

    data = _call(
        server._bind_issue_hold,
        db_session,
        {
            "execution_id": instance_id,
            "step_number": 2,
            "issue_id": issue_id,
            "user_id": test_user.id,
        },
    )
    assert data["success"] is True
    assert data["issue"]["containment"] == "step"

    # Idempotent re-bind to the same step — returns success with "already holds" message.
    data = _call(
        server._bind_issue_hold,
        db_session,
        {
            "execution_id": instance_id,
            "step_number": 2,
            "issue_id": issue_id,
            "user_id": test_user.id,
        },
    )
    assert data["success"] is True
    assert "already holds" in data["message"]

    # The state document surfaces the hold on the step and in the rail.
    # bind_issue_hold sets containment_step_id with no raised_step_id, so the
    # issue appears in complete_blocked → kind="raised" in the step's holds list.
    state = _call(server._get_execution_state, db_session, {"execution_id": instance_id})
    step2 = next(s for s in state["steps"] if s["order"] == 2)
    assert len(step2["holds"]) == 1
    h = step2["holds"][0]
    assert h["issue_id"] == issue_id
    assert h["issue_number"] == issue_number
    assert h["disposition_state"] == "undispositioned"
    assert len(state["holds"]) == 1
    assert state["holds"][0]["issue_number"] == issue_number
    assert "2" in state["holds"][0]["blocks"]

    # Focus is ungated — a cursor may sit on the bound step.
    data = _call(
        server._focus_step,
        db_session,
        {"execution_id": instance_id, "step_number": 2, "user_id": test_user.id},
    )
    assert data["success"] is True

    # The bound step's COMPLETE refuses while undispositioned. This is the
    # FlowError → db.rollback() path, which unwinds the outer test
    # transaction under pysqlite — keep it as the last DB action.
    data = _call(
        server._complete_step,
        db_session,
        {"execution_id": instance_id, "step_number": 2, "user_id": test_user.id},
    )
    assert "error" in data
    assert data["error"].startswith("Cannot complete:")
    assert issue_number in data["error"]


def test_bind_issue_hold_lifted_by_disposition(client, db_session, test_user, admin_user):
    """Signing a disposition via the API releases the bound hold; the step
    becomes completable."""
    instance_id, _ = _create_instance(client)

    issue_data = _call(
        server._raise_issue,
        db_session,
        {
            "title": "Scratch on housing",
            "issue_type": "non_conformance",
            "containment": "step",
            "procedure_instance_id": instance_id,
        },
    )
    issue_id = issue_data["issue"]["id"]

    data = _call(
        server._bind_issue_hold,
        db_session,
        {
            "execution_id": instance_id,
            "step_number": 1,
            "issue_id": issue_id,
            "user_id": test_user.id,
        },
    )
    assert data["success"] is True

    # Disposition the issue via the API (R2: POST /disposition).
    resp = client.post(
        f"/api/issues/{issue_id}/disposition",
        json={"disposition_type": "use_as_is", "disposition_rationale": "acceptable"},
        headers=user_headers(admin_user),
    )
    assert resp.status_code == 200

    data = _call(
        server._complete_step,
        db_session,
        {"execution_id": instance_id, "step_number": 1, "user_id": test_user.id},
    )
    assert data["success"] is True
    assert f"completed by {test_user.name}" in data["message"]


def test_set_containment_rejects_foreign_step(client, db_session, test_user):
    """F8 (MCP mirror): a boundary step from another WO is rejected."""
    instance_a, _ = _create_instance(client)
    instance_b, _ = _create_instance(client)
    foreign_step = (
        db_session.query(server.StepExecution)
        .filter(server.StepExecution.instance_id == instance_b)
        .first()
    )

    issue_data = _call(
        server._raise_issue,
        db_session,
        {
            "title": "NC on A",
            "issue_type": "non_conformance",
            "containment": "step",
            "procedure_instance_id": instance_a,
        },
    )
    issue_id = issue_data["issue"]["id"]

    data = _call(
        server._set_containment,
        db_session,
        {
            "issue_id": issue_id,
            "containment": "step",
            "containment_step_id": foreign_step.id,
            "user_id": test_user.id,
        },
    )
    assert data["success"] is False
    assert "different work order" in data["error"]


def test_bind_issue_hold_rejects_foreign_work_order(client, db_session, test_user):
    """F3: an issue that names work order A cannot be bound into B's step —
    the cross-WO bind would report success and block nothing."""
    instance_a, _ = _create_instance(client)
    instance_b, _ = _create_instance(client)

    issue_data = _call(
        server._raise_issue,
        db_session,
        {
            "title": "Cross-WO NC",
            "issue_type": "non_conformance",
            "containment": "step",
            "procedure_instance_id": instance_a,
        },
    )
    issue_id = issue_data["issue"]["id"]

    data = _call(
        server._bind_issue_hold,
        db_session,
        {
            "execution_id": instance_b,
            "step_number": 1,
            "issue_id": issue_id,
            "user_id": test_user.id,
        },
    )
    assert "error" in data
    assert str(instance_a) in data["error"]


def test_bind_issue_hold_adopts_work_order_when_unset(client, db_session, test_user):
    """F3: binding a WO-less draft adopts the target work order so the hold
    actually blocks the bound step."""
    instance_id, _ = _create_instance(client)

    issue_data = _call(
        server._raise_issue,
        db_session,
        {"title": "Draft NC", "issue_type": "non_conformance", "containment": "step"},
    )
    issue_id = issue_data["issue"]["id"]
    assert db_session.get(Issue, issue_id).procedure_instance_id is None

    data = _call(
        server._bind_issue_hold,
        db_session,
        {
            "execution_id": instance_id,
            "step_number": 2,
            "issue_id": issue_id,
            "user_id": test_user.id,
        },
    )
    assert data["success"] is True
    assert db_session.get(Issue, issue_id).procedure_instance_id == instance_id

    state = _call(server._get_execution_state, db_session, {"execution_id": instance_id})
    step2 = next(s for s in state["steps"] if s["order"] == 2)
    assert len(step2["holds"]) == 1


def test_bind_issue_hold_rebind_persists_adoption_past_session_close(
    client, db_session, test_user
):
    """F3 (re-bind path): the "already holds COMPLETE of step X" early return
    must commit the WO adoption. call_tool's cleanup closes (rolls back) the
    session after the handler, so a flush-only adoption would be silently
    lost — the seam the adoption exists for."""
    from opal.db.models.execution import StepExecution
    from opal.db.models.issue import Containment

    instance_id, _ = _create_instance(client)
    step_exec = (
        db_session.query(StepExecution)
        .filter(StepExecution.instance_id == instance_id, StepExecution.step_number == 2)
        .one()
    )

    # An orphaned issue already step-contained at that boundary but naming no
    # work order (e.g. its WO link was cleared after a bind).
    issue_data = _call(
        server._raise_issue,
        db_session,
        {"title": "Orphaned bound NC", "issue_type": "non_conformance", "containment": "step"},
    )
    issue = db_session.get(Issue, issue_data["issue"]["id"])
    issue.containment = Containment.STEP
    issue.containment_step_id = step_exec.id
    issue.procedure_instance_id = None
    db_session.flush()

    data = _call(
        server._bind_issue_hold,
        db_session,
        {
            "execution_id": instance_id,
            "step_number": 2,
            "issue_id": issue.id,
            "user_id": test_user.id,
        },
    )
    assert data["success"] is True
    assert "already holds" in data["message"]

    # The adoption was COMMITTED: the handler must leave no open transaction
    # for call_tool's finally db.close() to roll back. A flush-only adoption
    # leaves in_transaction() True and is silently discarded. (The per-test
    # outer rollback makes commit-vs-flush unobservable via data, so the
    # transaction state is the assertion; checked BEFORE any read, which
    # would autobegin a fresh transaction.)
    assert not db_session.in_transaction()
    assert db_session.get(Issue, issue.id).procedure_instance_id == instance_id


def test_bind_issue_hold_unknown_issue(client, db_session):
    instance_id, _ = _create_instance(client)

    data = _call(
        server._bind_issue_hold,
        db_session,
        {"execution_id": instance_id, "step_number": 1, "issue_id": 999999},
    )
    assert "error" in data


# ============ strict_sequence passthrough ============


def test_add_procedure_step_strict_sequence_passthrough(db_session):
    proc_data = _call(server._create_procedure, db_session, {"name": "Strict OP"})
    proc_id = proc_data["procedure"]["id"]

    data = _call(
        server._add_procedure_step,
        db_session,
        {"procedure_id": proc_id, "title": "Torque sequence", "strict_sequence": True},
    )
    assert data["success"] is True
    step_id = data["step"]["id"]

    # The MCP step serializers do not currently expose strict_sequence; the
    # authoritative check is the persisted column. If a payload ever carries
    # it, it must agree with the database.
    row = db_session.get(ProcedureStep, step_id)
    assert row.strict_sequence is True
    if "strict_sequence" in data["step"]:
        assert data["step"]["strict_sequence"] is True

    proc = _call(server._get_procedure, db_session, {"procedure_id": proc_id})
    step_payload = proc["steps"][0]
    assert step_payload["id"] == step_id
    if "strict_sequence" in step_payload:
        assert step_payload["strict_sequence"] is True

    # Default remains False when not requested.
    data = _call(
        server._add_procedure_step,
        db_session,
        {"procedure_id": proc_id, "title": "Free-order step"},
    )
    assert db_session.get(ProcedureStep, data["step"]["id"]).strict_sequence is False
