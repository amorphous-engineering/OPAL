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


def _buttons_outside_step_bodies(doc_html: str) -> int:
    """Count <button> elements in the document column that are NOT inside a
    .doc-step-body (the expanded-step control surface)."""
    from html.parser import HTMLParser

    class Counter(HTMLParser):
        def __init__(self) -> None:
            super().__init__()
            self.body_depth = 0
            self.div_is_body: list[bool] = []
            self.outside = 0

        def handle_starttag(self, tag: str, attrs: list) -> None:
            if tag == "div":
                cls = dict(attrs).get("class") or ""
                is_body = "doc-step-body" in cls
                self.div_is_body.append(is_body)
                if is_body:
                    self.body_depth += 1
            elif tag == "button" and self.body_depth == 0:
                self.outside += 1

        def handle_endtag(self, tag: str) -> None:
            if tag == "div" and self.div_is_body and self.div_is_body.pop():
                self.body_depth -= 1

    counter = Counter()
    counter.feed(doc_html)
    return counter.outside


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
    # Exit criteria (amended): collapsed rows carry zero controls — every
    # <button> in the document column lives inside an expandable step body.
    assert 'id="dockbar"' in body
    doc = _doc_column(body)
    assert _buttons_outside_step_bodies(doc) == 0
    assert "<button" in doc  # the control surface exists, inside step bodies


def test_hostile_step_title_does_not_inject_attribute(web_client: TestClient):
    """A step title with a double quote must not break out of the SKIP
    onclick attribute. Regression for the tojson-in-double-quoted-attribute
    XSS: | tojson does not escape ", so the handlers must be single-quoted."""
    from html.parser import HTMLParser

    proc_id = web_client.post("/api/procedures", json={"name": "XSS Doc Proc"}).json()["id"]
    hostile = 'Torque "final" x" onmouseover="alert(document.cookie)'
    web_client.post(f"/api/procedures/{proc_id}/steps", json={"title": hostile})
    web_client.post(f"/api/procedures/{proc_id}/publish")
    instance_id = web_client.post(
        "/api/procedure-instances", json={"procedure_id": proc_id}
    ).json()["id"]

    page = web_client.get(f"/executions/{instance_id}")
    assert page.status_code == 200

    class _AttrHunt(HTMLParser):
        injected = False

        def handle_starttag(self, tag: str, attrs: list) -> None:
            if any(k == "onmouseover" for k, _ in attrs):
                _AttrHunt.injected = True

    parser = _AttrHunt()
    parser.feed(page.text)
    # onmouseover appears only as literal text inside the single-quoted
    # onclick JS string — never as a parsed HTML attribute.
    assert not _AttrHunt.injected, "hostile step title injected an onmouseover handler"
    assert "showSkipModal(" in page.text


def test_bom_kitting_tabs_absent_without_kit(web_client: TestClient):
    """A procedure with no kit declares no BOM/KITTING expectation — the tabs
    are absent, not empty (empty-state rule). A kitted procedure shows them."""
    instance_id = _create_instance(web_client)  # 3 bare steps, no kit
    page = web_client.get(f"/executions/{instance_id}")
    assert page.status_code == 200
    assert "tab=kitting" not in page.text
    assert "tab=bom" not in page.text
    assert "tab=document" in page.text


def test_output_only_procedure_shows_kitting_tab(web_client: TestClient):
    """KITTING is also home to PRODUCTIONS + FINALIZE PRODUCTION: an
    output-only procedure (ProcedureOutput, no kit) must show it or WIP
    productions are stranded with FINALIZE unreachable (F7). BOM stays
    absent — reconciliation is meaningless without a kit side."""
    part = web_client.post(
        "/api/parts",
        json={"name": "Widget Output", "tracking_type": "bulk", "category": "Assemblies"},
    ).json()
    web_client.post(f"/api/parts/{part['id']}/activate", json={"cause": "test setup"})

    proc_id = web_client.post("/api/procedures", json={"name": "Output only"}).json()["id"]
    web_client.post(f"/api/procedures/{proc_id}/steps", json={"title": "Assemble"})
    out = web_client.post(
        f"/api/procedures/{proc_id}/outputs",
        json={"part_id": part["id"], "quantity_produced": 1},
    )
    assert out.status_code == 201, out.text
    web_client.post(f"/api/procedures/{proc_id}/publish")
    instance_id = web_client.post(
        "/api/procedure-instances", json={"procedure_id": proc_id}
    ).json()["id"]

    page = web_client.get(f"/executions/{instance_id}")
    assert page.status_code == 200
    assert "tab=kitting" in page.text
    assert "tab=bom" not in page.text


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


def test_bound_hold_on_child_renders_in_op_header_at_ssr(
    web_client: TestClient, auth_headers: dict
):
    """A bound "resolve by" hold on a child gates that child's COMPLETE and
    holds its OP's completion, so it renders in the op-card HELD BY blockline
    at SSR time — one derivation with the client poll (F4), no flicker."""
    proc_id = web_client.post("/api/procedures", json={"name": "Bound op header"}).json()["id"]
    op1 = web_client.post(f"/api/procedures/{proc_id}/steps", json={"title": "OP One"}).json()
    web_client.post(
        f"/api/procedures/{proc_id}/steps", json={"title": "Sub 1.1", "parent_step_id": op1["id"]}
    )
    op2 = web_client.post(f"/api/procedures/{proc_id}/steps", json={"title": "OP Two"}).json()
    web_client.post(
        f"/api/procedures/{proc_id}/steps", json={"title": "Sub 2.1", "parent_step_id": op2["id"]}
    )
    web_client.post(f"/api/procedures/{proc_id}/publish")
    instance_id = web_client.post(
        "/api/procedure-instances", json={"procedure_id": proc_id}
    ).json()["id"]

    # Orders: OP1=1, 1.1=2, OP2=3, 2.1=4. NC raised at 1.1, resolve by 2.1:
    # the hold anchors on the boundary (start_blocked), not the raised step.
    nc = web_client.post(
        f"/api/procedure-instances/{instance_id}/steps/2/nc",
        json={"title": "Resolve downstream", "containment": "step", "containment_step_number": 4},
        headers=auth_headers,
    )
    assert nc.status_code == 201, nc.text
    issue_number = nc.json()["issue_number"]

    page = web_client.get(f"/executions/{instance_id}")
    assert page.status_code == 200
    op2_body = _op_section_body(page.text, 3)
    assert "HELD BY" in op2_body
    assert issue_number in op2_body
    # The raised op's own scope is not held — the hold moved to the boundary.
    op1_body = _op_section_body(page.text, 1)
    assert "HELD BY" not in op1_body


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


def test_dockbar_op_row_renders_inert_complete_with_children_reason(web_client: TestClient):
    """An OP row over open children shows the standard gated control — an
    inert COMPLETE with the children reason beside it — never an absent
    control (F11: inert + reason, the pre-amendment hide pattern is banned)."""
    proc_id = web_client.post("/api/procedures", json={"name": "Dockbar OP gate"}).json()["id"]
    op = web_client.post(f"/api/procedures/{proc_id}/steps", json={"title": "Parent OP"}).json()
    web_client.post(
        f"/api/procedures/{proc_id}/steps", json={"title": "Sub 1", "parent_step_id": op["id"]}
    )
    web_client.post(
        f"/api/procedures/{proc_id}/steps", json={"title": "Sub 2", "parent_step_id": op["id"]}
    )
    web_client.post(f"/api/procedures/{proc_id}/publish")
    instance_id = web_client.post(
        "/api/procedure-instances", json={"procedure_id": proc_id}
    ).json()["id"]

    resp = web_client.get(f"/executions/{instance_id}/dockbar?step=1")
    assert resp.status_code == 200
    body = resp.text
    assert 'data-bar-order="1"' in body
    # Inert control + reason, display numbers (F1).
    assert '<button class="btn btn-sm btn-primary" disabled>COMPLETE</button>' in body
    assert "Waiting on sub-steps 1.1, 1.2" in body


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


# ============ 11. step notes: readout + append affordance ============


def test_step_notes_render_with_timestamp_tooltip(web_client: TestClient):
    """A note renders in the step body: HH:MM short form with the full
    ISO-8601 in the title tooltip, author initials, body — and the row
    indicator counts notes."""
    instance_id = _create_instance(web_client)

    resp = web_client.post(
        f"/api/procedure-instances/{instance_id}/steps/1/notes",
        json={"body": "coolant pressure drifting"},
    )
    assert resp.status_code == 201, resp.text
    created = resp.json()["created_at"]

    page = web_client.get(f"/executions/{instance_id}")
    assert page.status_code == 200
    html = page.text

    assert "coolant pressure drifting" in html
    assert "1 NOTE" in html
    # Dense-row timestamp rule: short HH:MM shown, full ISO-8601 in the tooltip.
    assert f'title="{created[:19]}Z"' in html

    web_client.post(
        f"/api/procedure-instances/{instance_id}/steps/1/notes",
        json={"body": "second observation"},
    )
    html = web_client.get(f"/executions/{instance_id}").text
    assert "2 NOTES" in html
    assert html.index("coolant pressure drifting") < html.index("second observation")


def test_step_note_input_is_separate_block_and_survives_closeout(
    web_client: TestClient, db_session: Session
):
    """The append input is its own labeled NOTES block (never inside the
    capture-field stack) and stays available on a closed work order."""
    instance_id = _create_schema_instance(web_client)

    html = web_client.get(f"/executions/{instance_id}").text
    # The notes log is its own labeled block: the append input sits after the
    # block's NOTES label, never among the capture fields.
    assert 'class="step-notes-block"' in html
    first_block = html.split('class="step-notes-block"', 1)[1]
    assert "NOTES" in first_block.split("step-note-add", 1)[0]

    # Close the WO out-of-band; the note affordance must survive (post-mortem).
    instance = db_session.query(ProcedureInstance).filter(ProcedureInstance.id == instance_id).one()
    instance.status = InstanceStatus.COMPLETED
    instance.completed_at = datetime.now(UTC)
    db_session.commit()

    closed = web_client.get(f"/executions/{instance_id}").text
    assert "step-note-add" in closed
    assert "addStepNote(" in closed


# ============ 12. kitting tab: consumption provenance ============


def _create_kitted_instance(client: TestClient) -> tuple[int, dict, dict]:
    """Kitted procedure + instance + stock. Returns (instance_id, part, inv_item)."""
    part = client.post(
        "/api/parts",
        json={"name": "Kit Resistor", "tracking_type": "bulk", "category": "Electronics"},
    ).json()
    client.post(f"/api/parts/{part['id']}/activate", json={"cause": "test setup"})
    inv = client.post(
        "/api/inventory",
        json={"part_id": part["id"], "quantity": 100, "location": "STORE-A2"},
    ).json()["items"][0]

    proc_id = client.post("/api/procedures", json={"name": "Kitted Web Proc"}).json()["id"]
    client.post(
        f"/api/procedures/{proc_id}/kit",
        json={"part_id": part["id"], "quantity_required": 5},
    )
    client.post(f"/api/procedures/{proc_id}/steps", json={"title": "Install parts"})
    client.post(f"/api/procedures/{proc_id}/publish")
    instance_id = client.post(
        "/api/procedure-instances", json={"procedure_id": proc_id}
    ).json()["id"]
    return instance_id, part, inv


def test_kitting_consumed_rows_carry_provenance(web_client: TestClient):
    """A consumed row traces to the exact physical item: internal PN linked
    to the part, OPAL # linked to the inventory item."""
    instance_id, part, inv = _create_kitted_instance(web_client)
    resp = web_client.post(
        f"/api/procedure-instances/{instance_id}/consume",
        json={"items": [{"inventory_record_id": inv["id"], "quantity": 5}]},
    )
    assert resp.status_code == 200, resp.text

    page = web_client.get(f"/executions/{instance_id}?tab=kitting")
    assert page.status_code == 200
    body = page.text

    assert "OPAL #" in body
    assert part["internal_pn"] in body
    assert f'href="/parts/{part["id"]}"' in body
    assert inv["opal_number"] in body
    assert f'href="/inventory/opal/{inv["opal_number"]}"' in body


def test_kitting_in_work_table_names_the_part_number(web_client: TestClient):
    """Before consumption the kit table identifies parts by internal PN, and
    the BOM tab does the same."""
    instance_id, part, _ = _create_kitted_instance(web_client)

    kitting = web_client.get(f"/executions/{instance_id}?tab=kitting").text
    assert part["internal_pn"] in kitting

    bom = web_client.get(f"/executions/{instance_id}?tab=bom").text
    assert part["internal_pn"] in bom
