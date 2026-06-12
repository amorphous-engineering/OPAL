"""Smoke tests: containment holds render as absent controls + blocker lines
(§10 exit criteria, template level)."""

from fastapi.testclient import TestClient


def _build_instance_with_sub_steps(client: TestClient) -> tuple[int, dict[str, int]]:
    """Procedure with OP 1 (two sub-steps); returns (instance_id, order-by-label)."""
    proc_id = client.post("/api/procedures", json={"name": "Hold Render Proc"}).json()["id"]
    op = client.post(f"/api/procedures/{proc_id}/steps", json={"title": "Assemble manifold"}).json()
    client.post(
        f"/api/procedures/{proc_id}/steps",
        json={"title": "Torque fasteners", "parent_step_id": op["id"]},
    )
    client.post(
        f"/api/procedures/{proc_id}/steps",
        json={"title": "Inspect torque stripe", "parent_step_id": op["id"]},
    )
    client.post(f"/api/procedures/{proc_id}/publish")
    inst = client.post("/api/procedure-instances", json={"procedure_id": proc_id}).json()
    by_label = {s["step_number_str"]: s["step_number"] for s in inst["step_executions"]}
    return inst["id"], by_label


def _raise_nc(client: TestClient, instance_id: int, step_number: int, **extra) -> dict:
    client.post(f"/api/procedure-instances/{instance_id}/steps/{step_number}/start")
    resp = client.post(
        f"/api/procedure-instances/{instance_id}/steps/{step_number}/nc",
        json={"title": "Torque out of spec", "priority": "high", **extra},
    )
    assert resp.status_code == 201, resp.text
    return resp.json()


def test_held_step_renders_blocker_line_not_complete_button(web_client):
    """(§10.2) Step and OP COMPLETE controls are absent, replaced by blocker
    lines naming the issue; the hold chip appears on the row."""
    instance_id, by_label = _build_instance_with_sub_steps(web_client)
    nc = _raise_nc(web_client, instance_id, by_label["1.1"])

    page = web_client.get(f"/executions/{instance_id}?tab=operations&op={by_label['1']}")
    assert page.status_code == 200
    # Blocker lines name the issue (step actions + OP header).
    assert page.text.count(nc["issue_number"]) >= 2
    assert "COMPLETE — held by" in page.text
    # The hold chip is the capture confirmation.
    assert "HELD — " + nc["issue_number"] in page.text
    # The held step's COMPLETE control is absent.
    assert f"completeStep({by_label['1.1']})" not in page.text
    # The OP header COMPLETE control is absent too.
    assert f"completeStep({by_label['1']})" not in page.text
    # The capture surface is the anomaly flow, not an alert.
    assert "ANOMALY" in page.text
    assert "alert(`NC logged" not in page.text


def test_signed_disposition_restores_controls(web_client):
    """(§10.3) Signing releases the containment; the controls return."""
    instance_id, by_label = _build_instance_with_sub_steps(web_client)
    nc = _raise_nc(web_client, instance_id, by_label["1.1"])

    resp = web_client.post(
        f"/api/issues/{nc['id']}/disposition",
        json={"disposition_type": "use_as_is", "disposition_rationale": "within margin"},
    )
    assert resp.status_code == 200

    page = web_client.get(f"/executions/{instance_id}?tab=operations&op={by_label['1']}")
    assert page.status_code == 200
    assert "COMPLETE — held by" not in page.text
    assert f"completeStep({by_label['1.1']})" in page.text


def test_issue_page_holding_readout(web_client):
    """(§10.6) The HOLDING section states the issue's consequences in one
    glance; an advisory issue states the dash."""
    instance_id, by_label = _build_instance_with_sub_steps(web_client)
    nc = _raise_nc(web_client, instance_id, by_label["1.1"])

    page = web_client.get(f"/issues/{nc['id']}")
    assert page.status_code == 200
    assert "HOLDING" in page.text
    assert "1.1 COMPLETE" in page.text
    assert "OP 1 COMPLETE" in page.text
    assert "⛔ UNDISPOSITIONED" in page.text
    assert "SIGN DISPOSITION" in page.text

    advisory = web_client.post("/api/issues", json={"title": "Note only"}).json()
    page = web_client.get(f"/issues/{advisory['id']}")
    assert page.status_code == 200
    assert "— (advisory)" in page.text


def test_issues_list_disp_state_and_holding(web_client):
    """(§6) Disp-state and holding count render; undispositioned-with-
    containment sorts first."""
    instance_id, by_label = _build_instance_with_sub_steps(web_client)
    nc = _raise_nc(web_client, instance_id, by_label["1.1"])
    web_client.post("/api/issues", json={"title": "Plain task"})

    rows = web_client.get("/issues/table")
    assert rows.status_code == 200
    assert "⛔ UNDISPOSITIONED" in rows.text
    # The blocking issue leads the table.
    assert rows.text.find(nc["issue_number"]) < rows.text.find("Plain task")

    page = web_client.get("/issues")
    assert page.status_code == 200
    assert "DISP-STATE" in page.text
    assert "HOLDING" in page.text


def test_execution_issues_tab_disp_state(web_client):
    """(§9.4) The execution ISSUES section shows disp-state, holds first."""
    instance_id, by_label = _build_instance_with_sub_steps(web_client)
    _raise_nc(web_client, instance_id, by_label["1.1"])

    page = web_client.get(f"/executions/{instance_id}?tab=issues")
    assert page.status_code == 200
    assert "DISP-STATE" in page.text
    assert "⛔ UNDISPOSITIONED" in page.text


def test_new_issue_page_renders(web_client):
    page = web_client.get("/issues/new?procedure_instance_id=1")
    assert page.status_code == 200
    assert "CONTAINMENT" in page.text
