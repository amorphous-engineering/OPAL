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
    assert data["instance"]["status"] == "pending"
    assert data["instance"]["procedure_name"] == "Test Procedure"
    assert data["instance"]["progress"] == {"done": 0, "total": 3}
    assert [s["order"] for s in data["steps"]] == [1, 2, 3]
    assert all(s["status"] == "pending" for s in data["steps"])
    assert all(s["claim"] is None for s in data["steps"])
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

    # A joined user with no claim appears in the roster as observer.
    state = _call(server._get_execution_state, db_session, {"execution_id": instance_id})
    assert len(state["roster"]) == 1
    assert state["roster"][0]["user_id"] == test_user.id
    assert state["roster"][0]["observer"] is True


# ============ claim_step ============


def test_claim_step_requires_user_id(client, db_session):
    instance_id, _ = _create_instance(client)

    data = _call(server._claim_step, db_session, {"execution_id": instance_id, "step_number": 1})
    assert "error" in data
    assert "user_id" in data["error"]


def test_claim_step_happy(client, db_session, test_user):
    instance_id, _ = _create_instance(client)

    data = _call(
        server._claim_step,
        db_session,
        {"execution_id": instance_id, "step_number": 1, "user_id": test_user.id},
    )
    assert data["success"] is True
    assert "claimed step" in data["message"]
    assert test_user.name in data["message"]
    assert data["status"] == "in_progress"
    assert data["instance_started"] is True  # first claim starts a pending instance

    state = _call(server._get_execution_state, db_session, {"execution_id": instance_id})
    step1 = next(s for s in state["steps"] if s["order"] == 1)
    assert step1["status"] == "in_progress"
    assert step1["claim"]["user_id"] == test_user.id
    assert state["instance"]["status"] == "in_progress"


def test_claim_step_conflict_second_user(client, db_session, test_user, admin_user):
    instance_id, _ = _create_instance(client)
    # The conflict path calls db.rollback(), which under the pysqlite test
    # harness unwinds the whole outer transaction — capture plain values
    # first and make the conflicting claim the last DB action of the test.
    holder_name = test_user.name
    admin_id = admin_user.id

    data = _call(
        server._claim_step,
        db_session,
        {"execution_id": instance_id, "step_number": 1, "user_id": test_user.id},
    )
    assert data["success"] is True

    data = _call(
        server._claim_step,
        db_session,
        {"execution_id": instance_id, "step_number": 1, "user_id": admin_id},
    )
    assert "error" in data
    assert "claimed by" in data["error"]
    assert holder_name in data["error"]


def test_claim_step_supersedes_own_previous_claim(client, db_session, test_user):
    """One active step per user: claiming step 2 returns step 1 to pending."""
    instance_id, _ = _create_instance(client)
    args = {"execution_id": instance_id, "user_id": test_user.id}

    assert _call(server._claim_step, db_session, {**args, "step_number": 1})["success"] is True
    assert _call(server._claim_step, db_session, {**args, "step_number": 2})["success"] is True

    state = _call(server._get_execution_state, db_session, {"execution_id": instance_id})
    step1 = next(s for s in state["steps"] if s["order"] == 1)
    step2 = next(s for s in state["steps"] if s["order"] == 2)
    assert step1["status"] == "pending"
    assert step1["claim"] is None
    assert step2["status"] == "in_progress"
    assert step2["claim"]["user_id"] == test_user.id


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


def test_complete_step_releases_claim(client, db_session, test_user):
    instance_id, _ = _create_instance(client)
    args = {"execution_id": instance_id, "user_id": test_user.id}

    assert _call(server._claim_step, db_session, {**args, "step_number": 1})["success"] is True
    data = _call(server._complete_step, db_session, {**args, "step_number": 1})
    assert data["success"] is True

    state = _call(server._get_execution_state, db_session, {"execution_id": instance_id})
    step1 = next(s for s in state["steps"] if s["order"] == 1)
    assert step1["status"] == "completed"
    assert step1["claim"] is None


# ============ release_step ============


def test_release_step_wrong_user_then_owner(client, db_session, test_user, admin_user):
    instance_id, _ = _create_instance(client)

    data = _call(
        server._claim_step,
        db_session,
        {"execution_id": instance_id, "step_number": 1, "user_id": test_user.id},
    )
    assert data["success"] is True

    # Another (active, human) user cannot release someone else's claim.
    data = _call(
        server._release_step,
        db_session,
        {"execution_id": instance_id, "step_number": 1, "user_id": admin_user.id},
    )
    assert "error" in data
    assert "No active claim" in data["error"]

    # The claim holder releases: step returns to pending.
    data = _call(
        server._release_step,
        db_session,
        {"execution_id": instance_id, "step_number": 1, "user_id": test_user.id},
    )
    assert data["success"] is True
    assert data["status"] == "pending"

    state = _call(server._get_execution_state, db_session, {"execution_id": instance_id})
    step1 = next(s for s in state["steps"] if s["order"] == 1)
    assert step1["status"] == "pending"
    assert step1["claim"] is None


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


def test_add_step_note_appends(client, db_session):
    instance_id, _ = _create_instance(client)
    args = {"execution_id": instance_id, "step_number": 2}

    data = _call(server._add_step_note, db_session, {**args, "note": "first line"})
    assert data["success"] is True
    assert data["notes"] == "first line"

    data = _call(server._add_step_note, db_session, {**args, "note": "second line"})
    assert data["success"] is True
    assert "first line" in data["notes"]
    assert "second line" in data["notes"]

    data = _call(server._add_step_note, db_session, {**args, "note": "   "})
    assert "error" in data

    state = _call(server._get_execution_state, db_session, {"execution_id": instance_id})
    step2 = next(s for s in state["steps"] if s["order"] == 2)
    assert step2["has_notes"] is True


# ============ bind_issue_hold ============


def test_bind_issue_hold_blocks_claim_and_is_idempotent(client, db_session, test_user):
    instance_id, _ = _create_instance(client)

    issue_data = _call(
        server._create_issue,
        db_session,
        {"title": "Cracked bracket found in stores", "issue_type": "non_conformance"},
    )
    assert issue_data["success"] is True
    issue_id = issue_data["issue"]["id"]
    issue_number = db_session.get(Issue, issue_id).issue_number
    assert issue_number

    data = _call(
        server._bind_issue_hold,
        db_session,
        {"execution_id": instance_id, "step_number": 2, "issue_id": issue_id},
    )
    assert data["success"] is True
    assert issue_number in data["message"]
    assert "until disposition" in data["message"]
    block_id = data["block_id"]

    # Idempotent re-bind returns the same block.
    data = _call(
        server._bind_issue_hold,
        db_session,
        {"execution_id": instance_id, "step_number": 2, "issue_id": issue_id},
    )
    assert data["success"] is True
    assert data["block_id"] == block_id
    assert "already blocks" in data["message"]

    # The state document surfaces the hold on the step and in the rail.
    state = _call(server._get_execution_state, db_session, {"execution_id": instance_id})
    step2 = next(s for s in state["steps"] if s["order"] == 2)
    assert step2["holds"] == [
        {
            "issue_id": issue_id,
            "issue_number": issue_number,
            "kind": "bound",
            "disposition_state": "undispositioned",
        }
    ]
    assert len(state["holds"]) == 1
    assert state["holds"][0]["issue_number"] == issue_number
    assert "2" in state["holds"][0]["blocks"]

    # The bound step's START (claim) refuses while undispositioned. This is
    # the FlowError → db.rollback() path, which unwinds the outer test
    # transaction under pysqlite — keep it as the last DB action.
    data = _call(
        server._claim_step,
        db_session,
        {"execution_id": instance_id, "step_number": 2, "user_id": test_user.id},
    )
    assert "error" in data
    assert f"Blocked by {issue_number}" in data["error"]


def test_bind_issue_hold_lifted_by_disposition(client, db_session, test_user, admin_user):
    instance_id, _ = _create_instance(client)

    issue_data = _call(
        server._create_issue,
        db_session,
        {"title": "Scratch on housing", "issue_type": "non_conformance"},
    )
    issue_id = issue_data["issue"]["id"]

    data = _call(
        server._bind_issue_hold,
        db_session,
        {"execution_id": instance_id, "step_number": 1, "issue_id": issue_id},
    )
    assert data["success"] is True

    # Disposition the issue via the API; the bound step becomes claimable again.
    resp = client.patch(
        f"/api/issues/{issue_id}",
        json={"status": "disposition_approved", "disposition_type": "use_as_is"},
        headers=user_headers(admin_user),
    )
    assert resp.status_code == 200

    data = _call(
        server._claim_step,
        db_session,
        {"execution_id": instance_id, "step_number": 1, "user_id": test_user.id},
    )
    assert data["success"] is True
    assert data["status"] == "in_progress"


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
