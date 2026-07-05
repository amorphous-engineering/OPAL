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
