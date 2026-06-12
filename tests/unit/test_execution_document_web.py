"""Web tests for the execution DOCUMENT page and its partials.

Identity note: API auth resolves the session cookie BEFORE the bearer header
(see opal.api.deps.get_current_user), so API mutations issued through
``web_client`` are attributed to ``test_user`` — the same identity the web
page renders as ``current_user``. The dockbar cursor test verifies this
explicitly via /state.
"""

from datetime import UTC, datetime

from fastapi.testclient import TestClient
from sqlalchemy.orm import Session

from opal.db.models.execution import InstanceStatus, ProcedureInstance

# ============ builders (API-call patterns from tests/unit/test_execution.py) ============


def _create_procedure_with_steps(client: TestClient) -> tuple[int, int]:
    """Create a procedure with 3 top-level steps and publish it."""
    proc_response = client.post(
        "/api/procedures",
        json={"name": "Doc Web Procedure"},
    )
    proc_id = proc_response.json()["id"]

    client.post(f"/api/procedures/{proc_id}/steps", json={"title": "Step 1"})
    client.post(f"/api/procedures/{proc_id}/steps", json={"title": "Step 2"})
    client.post(f"/api/procedures/{proc_id}/steps", json={"title": "Step 3"})

    version_response = client.post(f"/api/procedures/{proc_id}/publish")
    version_id = version_response.json()["id"]

    return proc_id, version_id


def _create_instance(client: TestClient) -> int:
    """Create a procedure + instance, return instance_id."""
    proc_id, _ = _create_procedure_with_steps(client)
    resp = client.post(
        "/api/procedure-instances",
        json={"procedure_id": proc_id},
    )
    assert resp.status_code == 201, resp.text
    return resp.json()["id"]


def _create_schema_instance(client: TestClient) -> int:
    """Instance whose step 1 carries a required_data_schema (number field)."""
    proc_id = client.post("/api/procedures", json={"name": "Schema Doc Proc"}).json()["id"]
    client.post(
        f"/api/procedures/{proc_id}/steps",
        json={
            "title": "Torque bolts",
            "required_data_schema": {
                "fields": [
                    {
                        "name": "torque",
                        "label": "TORQUE",
                        "type": "number",
                        "required": True,
                        "unit": "Nm",
                    }
                ]
            },
        },
    )
    client.post(f"/api/procedures/{proc_id}/steps", json={"title": "Verify"})
    client.post(f"/api/procedures/{proc_id}/publish")
    resp = client.post("/api/procedure-instances", json={"procedure_id": proc_id})
    assert resp.status_code == 201, resp.text
    return resp.json()["id"]


def _se_id(client: TestClient, instance_id: int, order: int) -> int:
    """Step execution id for the snapshot order."""
    inst = client.get(f"/api/procedure-instances/{instance_id}").json()
    return next(se["id"] for se in inst["step_executions"] if se["step_number"] == order)


def _upload_capture(client: TestClient, se_id: int, note: str) -> dict:
    resp = client.post(
        "/api/attachments/upload",
        files={"file": ("evidence.png", b"\x89PNG\r\n\x1a\nfake", "image/png")},
        data={"step_execution_id": str(se_id), "kind": "capture", "note": note},
    )
    assert resp.status_code == 201, resp.text
    return resp.json()


def _op_section_class_attr(html: str, order: int) -> str:
    """The <section ...> opening text immediately preceding id="op-{order}"."""
    head = html.split(f'id="op-{order}"')[0]
    return head.rsplit("<section", 1)[1]


def _op_section_body(html: str, order: int) -> str:
    """Markup between id="op-{order}" and its closing </section>."""
    return html.split(f'id="op-{order}"')[1].split("</section>")[0]


def _doc_column(html: str) -> str:
    """Markup between id="exec-doc" and the right rail's <aside>."""
    return html.split('id="exec-doc"')[1].split("<aside")[0]


# ============ 1. document page renders ============


def test_document_page_renders(web_client: TestClient):
    instance_id = _create_instance(web_client)

    resp = web_client.get(f"/executions/{instance_id}")
    assert resp.status_code == 200
    body = resp.text
    assert "DOCUMENT" in body
    assert "exec-head" in body
    assert "op-card" in body
    assert "execdoc.js" in body
    assert "execdoc.css" in body
    # Exit criteria: every control lives in the docked bar — the multi-step
    # document column renders zero <button> elements.
    assert 'id="dockbar"' in body
    assert "<button" not in _doc_column(body)


# ============ 2. legacy tab aliases ============


def test_legacy_tab_aliases_land_on_document(web_client: TestClient):
    instance_id = _create_instance(web_client)

    for legacy in ("meta", "operations"):
        resp = web_client.get(f"/executions/{instance_id}?tab={legacy}")
        assert resp.status_code == 200, legacy
        assert "exec-doc-layout" in resp.text, legacy


# ============ 3. expansion policy ============


def test_completed_op_collapses_pending_op_does_not(web_client: TestClient):
    instance_id = _create_instance(web_client)

    # Complete step 1 (a flat top-level step = its own OP card).
    resp = web_client.post(
        f"/api/procedure-instances/{instance_id}/steps/1/complete",
        json={},
    )
    assert resp.status_code == 200, resp.text

    page = web_client.get(f"/executions/{instance_id}")
    assert page.status_code == 200
    html = page.text

    # Completed OP: collapsed, body hidden.
    assert "is-collapsed" in _op_section_class_attr(html, 1)
    assert '<div class="op-card-body" hidden>' in _op_section_body(html, 1)

    # Pending OP: expanded, body visible.
    assert "is-collapsed" not in _op_section_class_attr(html, 2)
    assert '<div class="op-card-body" hidden>' not in _op_section_body(html, 2)


# ============ 4. role chip + caution ============


def test_role_chip_and_caution_render(web_client: TestClient):
    proc_id = web_client.post("/api/procedures", json={"name": "Role Caution Proc"}).json()["id"]
    web_client.post(
        f"/api/procedures/{proc_id}/steps",
        json={"title": "Crimp leads", "required_role": "TC", "caution": "HOT SURFACE"},
    )
    web_client.post(f"/api/procedures/{proc_id}/publish")
    instance_id = web_client.post(
        "/api/procedure-instances", json={"procedure_id": proc_id}
    ).json()["id"]

    resp = web_client.get(f"/executions/{instance_id}")
    assert resp.status_code == 200
    assert '<span class="role-chip mono">TC</span>' in resp.text
    assert "CAUTION: HOT SURFACE" in resp.text


# ============ 5. holds render in the document and the rail ============


def test_bound_hold_renders_in_document_and_rail(web_client: TestClient, auth_headers: dict):
    instance_id = _create_instance(web_client)

    # Raise a step-contained NC on step 1 that also blocks step 3's COMPLETE.
    nc = web_client.post(
        f"/api/procedure-instances/{instance_id}/steps/1/nc",
        json={
            "title": "Bent pin found",
            "containment": "step",
            "blocks_step_numbers": [3],
        },
        headers=auth_headers,
    )
    assert nc.status_code == 201, nc.text
    issue_number = nc.json()["issue_number"]

    page = web_client.get(f"/executions/{instance_id}")
    assert page.status_code == 200
    assert "HOLD" in page.text
    assert issue_number in page.text

    rail = web_client.get(f"/executions/{instance_id}/rail")
    assert rail.status_code == 200
    assert "ISSUES / HOLDS" in rail.text
    assert issue_number in rail.text
    assert "blocks" in rail.text


# ============ 6. dockbar partial ============


def test_dockbar_serves_requested_step(web_client: TestClient):
    instance_id = _create_instance(web_client)

    resp = web_client.get(f"/executions/{instance_id}/dockbar?step=2")
    assert resp.status_code == 200
    body = resp.text
    assert 'data-bar-order="2"' in body
    assert 'dockbar-num">2</span>' in body
    # The bar is the only control surface of an actionable step.
    assert "ATTACH" in body
    assert "ISSUE" in body
    assert "COMPLETE" in body


def test_dockbar_follows_cursor_with_data_fields(web_client: TestClient, test_user):
    instance_id = _create_schema_instance(web_client)

    # Without a cursor the bar falls back to the first actionable step,
    # whose schema renders as editable capture fields.
    resp = web_client.get(f"/executions/{instance_id}/dockbar")
    assert resp.status_code == 200
    assert 'data-bar-order="1"' in resp.text
    assert 'data-capture-field="torque"' in resp.text

    # web_client carries test_user's session cookie; the cookie wins over the
    # bearer header in API auth, so this cursor belongs to test_user.
    focus = web_client.post(
        f"/api/procedure-instances/{instance_id}/focus", json={"step_number": 2}
    )
    assert focus.status_code == 200, focus.text

    state = web_client.get(f"/api/procedure-instances/{instance_id}/state").json()
    step2 = next(s for s in state["steps"] if s["order"] == 2)
    assert [c["user_id"] for c in step2["cursors"]] == [test_user.id]
    assert step2["status"] == "pending"  # focus is presence, not a start

    bar = web_client.get(f"/executions/{instance_id}/dockbar")
    assert bar.status_code == 200
    assert 'data-bar-order="2"' in bar.text

    # The document renders the session user's cursor chip server-side.
    page = web_client.get(f"/executions/{instance_id}")
    assert '<span class="cursor-chip mono is-self"' in page.text


# ============ 7. rail partial: attachments + reference docs ============


def test_rail_shows_capture_note_and_reference_docs_section(web_client: TestClient):
    instance_id = _create_instance(web_client)
    se_id = _se_id(web_client, instance_id, 1)

    uploaded = _upload_capture(web_client, se_id, "evidence note")
    assert uploaded["note"] == "evidence note"
    assert uploaded["step_execution_id"] == se_id

    rail = web_client.get(f"/executions/{instance_id}/rail")
    assert rail.status_code == 200
    body = rail.text
    assert "evidence note" in body
    assert "rail-attach-group" in body
    assert 'data-step-order="1"' in body
    assert "REFERENCE DOCS" in body


# ============ 8. step-row partial ============


def test_step_row_partial_returns_row_or_404(web_client: TestClient):
    instance_id = _create_instance(web_client)

    resp = web_client.get(f"/executions/{instance_id}/step-row/1")
    assert resp.status_code == 200
    assert 'id="step-1"' in resp.text

    missing = web_client.get(f"/executions/{instance_id}/step-row/999")
    assert missing.status_code == 404


# ============ 9. meta facts, ABORT, REPORT visibility ============


def test_meta_facts_abort_and_report_visibility(web_client: TestClient, db_session: Session):
    instance_id = _create_instance(web_client)

    # Flip the instance cut -> in_work by completing a step.
    complete = web_client.post(f"/api/procedure-instances/{instance_id}/steps/1/complete", json={})
    assert complete.status_code == 200, complete.text

    page = web_client.get(f"/executions/{instance_id}")
    assert page.status_code == 200
    body = page.text
    assert "STARTED BY" in body
    assert "VERSION AUTHOR" in body
    assert "abortExecution()" in body
    assert f"/executions/{instance_id}/report" not in body

    # Force-complete via ORM (same pattern as test_executions_report).
    instance = db_session.query(ProcedureInstance).filter(ProcedureInstance.id == instance_id).one()
    instance.status = InstanceStatus.COMPLETED
    instance.completed_at = datetime.now(UTC)
    db_session.commit()

    done = web_client.get(f"/executions/{instance_id}")
    assert done.status_code == 200
    assert f"/executions/{instance_id}/report" in done.text
    assert "abortExecution()" not in done.text


# ============ 10. attachment indicator on the step row ============


def test_attachment_indicator_on_step_row(web_client: TestClient):
    instance_id = _create_instance(web_client)
    se_id = _se_id(web_client, instance_id, 1)
    _upload_capture(web_client, se_id, "indicator check")

    page = web_client.get(f"/executions/{instance_id}")
    assert page.status_code == 200
    assert "1 ATT" in page.text
