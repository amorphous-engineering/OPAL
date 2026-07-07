"""Tests for the TUI's OpalAPIClient against the live app.

The R2 execution rewrite replaced the step-start model with a focus/cursor
document model: POST /{id}/steps/{n}/start was deleted. These tests drive the
TUI client's execution methods through the real FastAPI app to prove they speak
the new API (focus/complete/skip) and that the dead start_step method is gone.

The client's httpx.Client is swapped for the authenticated TestClient, whose
default admin Bearer header is used whenever the TUI client sends no token.
"""

import httpx
import pytest

from opal.tui.api_client import OpalAPIClient


def _tui_client(test_client) -> OpalAPIClient:
    """Wrap the authenticated TestClient as the TUI client's transport."""
    api = OpalAPIClient(base_url=str(test_client.base_url))
    api.client = test_client
    return api


def _create_instance(test_client) -> int:
    """Publish a 3-step procedure and cut a work order; return the instance id."""
    proc_id = test_client.post("/api/procedures", json={"name": "TUI Proc"}).json()["id"]
    for title in ("Step 1", "Step 2", "Step 3"):
        test_client.post(f"/api/procedures/{proc_id}/steps", json={"title": title})
    test_client.post(f"/api/procedures/{proc_id}/publish")
    resp = test_client.post("/api/procedure-instances", json={"procedure_id": proc_id})
    return resp.json()["id"]


def test_start_step_method_removed() -> None:
    """The deleted /start endpoint has no client method (T1 regression guard)."""
    assert not hasattr(OpalAPIClient, "start_step")
    assert hasattr(OpalAPIClient, "focus_step")


def test_focus_step_moves_cursor(client) -> None:
    """focus_step posts to /focus and returns the cursor position (T1)."""
    api = _tui_client(client)
    instance_id = _create_instance(client)

    result = api.focus_step(instance_id, 1)

    assert result["step_number"] == 1
    assert "focused_at" in result


def test_complete_step_commits_without_start(client) -> None:
    """A pending step completes directly — no start moment (T1/T2)."""
    api = _tui_client(client)
    instance_id = _create_instance(client)

    result = api.complete_step(instance_id, 1)

    assert result["status"] == "completed"

    # The instance leaves CUT on first committed work.
    assert client.get(f"/api/procedure-instances/{instance_id}").json()["status"] == "in_work"


def test_skip_step_commits(client) -> None:
    """skip_step marks a step skipped (and sends a valid body)."""
    api = _tui_client(client)
    instance_id = _create_instance(client)

    result = api.skip_step(instance_id, 2, reason="not applicable")

    assert result["status"] == "skipped"


def test_no_step_is_ever_in_progress(client) -> None:
    """After completing a step, no step carries the phantom in_progress status
    the old TUI 'Complete' filtered for (T2)."""
    api = _tui_client(client)
    instance_id = _create_instance(client)
    api.complete_step(instance_id, 1)

    steps = client.get(f"/api/procedure-instances/{instance_id}").json()["step_executions"]
    assert all(s["status"] != "in_progress" for s in steps)
    assert {s["step_number"]: s["status"] for s in steps}[1] == "completed"


def test_advisory_issue_disposition_dead_ends(client) -> None:
    """Rationale for the T3 guard: an advisory issue 400s on disposition but
    closes cleanly via update_issue — the paths the TUI now routes between."""
    api = _tui_client(client)
    issue = api.create_issue({"title": "Advisory note", "containment": "advisory"})
    assert issue["containment"] == "advisory"

    with pytest.raises(httpx.HTTPStatusError) as exc:
        api.sign_disposition(
            issue["id"],
            {"disposition_type": "use_as_is", "disposition_rationale": "n/a"},
        )
    assert exc.value.response.status_code == 400

    closed = api.update_issue(issue["id"], {"status": "closed"})
    assert closed["status"] == "closed"


# ============ Screen logic: actionable-leaf selection (F2) ============


def _create_sub_stepped_instance(test_client) -> int:
    """OP 1 with sub-steps 1.1/1.2, then a childless OP 2; return instance id."""
    proc_id = test_client.post("/api/procedures", json={"name": "TUI Sub Proc"}).json()["id"]
    op = test_client.post(f"/api/procedures/{proc_id}/steps", json={"title": "Parent OP"}).json()
    for title in ("Sub 1", "Sub 2"):
        test_client.post(
            f"/api/procedures/{proc_id}/steps",
            json={"title": title, "parent_step_id": op["id"]},
        )
    test_client.post(f"/api/procedures/{proc_id}/steps", json={"title": "Leaf OP"})
    test_client.post(f"/api/procedures/{proc_id}/publish")
    return test_client.post("/api/procedure-instances", json={"procedure_id": proc_id}).json()["id"]


def _detail_with(test_client, instance_id: int):
    """An ExecutionDetail carrying the live instance payload (screen logic
    only — the widget is never mounted)."""
    from opal.tui.screens.executions import ExecutionDetail

    detail = ExecutionDetail()
    detail.instance_data = test_client.get(f"/api/procedure-instances/{instance_id}").json()
    return detail


def test_current_step_targets_actionable_leaf_not_op_header(client) -> None:
    """The current-step target is the first actionable LEAF (F2): with the
    children gate, targeting the OP header made COMPLETE 400 always and SKIP
    commit the whole OP. The selected leaf must actually complete."""
    api = _tui_client(client)
    instance_id = _create_sub_stepped_instance(client)

    detail = _detail_with(client, instance_id)
    step = detail.get_current_step_data()
    assert step is not None
    assert step["step_number_str"] == "1.1"
    assert step["level"] > 0

    # The selection is committable — the OP header would 400 here.
    assert api.complete_step(instance_id, step["step_number"])["status"] == "completed"

    detail = _detail_with(client, instance_id)
    assert detail.get_current_step_data()["step_number_str"] == "1.2"
    api.complete_step(instance_id, detail.get_current_step())

    # Children done -> OP 1 auto-completed; the next leaf is childless OP 2.
    detail = _detail_with(client, instance_id)
    step = detail.get_current_step_data()
    assert step["step_number_str"] == "2"
    assert api.complete_step(instance_id, step["step_number"])["status"] == "completed"

    detail = _detail_with(client, instance_id)
    assert detail.get_current_step_data() is None  # document complete


def test_current_step_flat_procedure_unchanged(client) -> None:
    """Childless ops are leaves — flat procedures keep the old selection."""
    api = _tui_client(client)
    instance_id = _create_instance(client)
    detail = _detail_with(client, instance_id)
    assert detail.get_current_step() == 1
    api.complete_step(instance_id, 1)
    detail = _detail_with(client, instance_id)
    assert detail.get_current_step() == 2


# ============ Kit availability row labels (F6) ============


def test_kit_row_label_reads_api_field_names(client) -> None:
    """_kit_row_label consumes the API's KitAvailabilityItem spellings
    (quantity_required/quantity_available) and surfaces the OPAL number —
    the old required_quantity/available_quantity read nothing (F6)."""
    from opal.tui.screens.executions import _kit_row_label

    api = _tui_client(client)
    part = client.post(
        "/api/parts", json={"name": "TUI Kit Part", "tracking_type": "bulk", "category": "Misc"}
    ).json()
    client.post(f"/api/parts/{part['id']}/activate", json={"cause": "test setup"})
    inv = client.post(
        "/api/inventory",
        json={"part_id": part["id"], "quantity": 7, "location": "BIN-9", "lot_number": "L1"},
    ).json()["items"][0]

    proc_id = client.post("/api/procedures", json={"name": "TUI Kit Proc"}).json()["id"]
    client.post(
        f"/api/procedures/{proc_id}/kit", json={"part_id": part["id"], "quantity_required": 5}
    )
    client.post(f"/api/procedures/{proc_id}/steps", json={"title": "Install"})
    client.post(f"/api/procedures/{proc_id}/publish")
    instance_id = client.post("/api/procedure-instances", json={"procedure_id": proc_id}).json()[
        "id"
    ]

    kit = api.get_kit_availability(instance_id)
    item = kit["items"][0]
    label = _kit_row_label(item)
    assert "need 5, have 7" in label
    assert "[OK]" in label
    assert inv["opal_number"] in label

    # Absent quantities render '?' — never a fabricated 0.
    assert "have ?" in _kit_row_label({"part_name": "X", "quantity_required": 1})


# ============ Interface copy: no raw database ids (F12) ============


def test_execution_label_leads_with_work_order() -> None:
    from opal.tui.screens.executions import _execution_label

    assert _execution_label({"id": 7, "work_order_number": "WO-0042"}) == "WO-0042"
    assert (
        _execution_label(
            {"id": 7, "procedure_name": "Bond panels", "created_at": "2026-07-05T10:00:00Z"}
        )
        == "Bond panels (cut 2026-07-05)"
    )
    assert "7" not in _execution_label({"id": 7, "procedure_name": "Bond panels"})
