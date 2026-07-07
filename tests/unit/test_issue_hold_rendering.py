"""Smoke tests: containment holds render as inert controls + reason lines
(§10 exit criteria, template level) — the gated button is disabled with the
blockers named beside it, never absent."""

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
    resp = client.post(
        f"/api/procedure-instances/{instance_id}/steps/{step_number}/nc",
        json={"title": "Torque out of spec", "priority": "high", **extra},
    )
    assert resp.status_code == 201, resp.text
    return resp.json()


def test_held_step_renders_inert_complete_with_reason(web_client):
    """(§10.2, amended) Step and OP COMPLETE controls render disabled with a
    reason line naming the issue beside them; the hold chip appears on the
    row."""
    instance_id, by_label = _build_instance_with_sub_steps(web_client)
    nc = _raise_nc(web_client, instance_id, by_label["1.1"])

    page = web_client.get(f"/executions/{instance_id}?tab=operations&op={by_label['1']}")
    assert page.status_code == 200
    # Reason lines name the issue (step actions + OP header).
    assert page.text.count(nc["issue_number"]) >= 2
    assert "disabled>COMPLETE</button>" in page.text
    assert "held by" in page.text
    # SKIP is gated by the same hold: inert + reason, still in the actions.
    assert "disabled>SKIP</button>" in page.text
    # The hold chip is the capture confirmation.
    assert "HELD — " + nc["issue_number"] in page.text
    # The held step's COMPLETE control is inert — no active handler.
    assert f"completeStep({by_label['1.1']}," not in page.text
    # The OP header COMPLETE control is inert too.
    assert f"completeStep({by_label['1']}," not in page.text
    # The capture surface is the anomaly flow, not an alert.
    assert "ANOMALY" in page.text
    assert "alert(`NC logged" not in page.text


def test_bound_hold_row_renders_inert_complete(web_client):
    """F4: a 'resolve by' boundary (start_blocked) — which the server refuses
    to COMPLETE — must not render an active COMPLETE button; the control is
    inert (disabled) with the reason line beside it. Previously the row
    derived 'held' from raised NCs only and showed a button the server then
    400'd."""
    proc_id = web_client.post("/api/procedures", json={"name": "Bound gate"}).json()["id"]
    for title in ("S1", "S2", "S3"):
        web_client.post(f"/api/procedures/{proc_id}/steps", json={"title": title})
    web_client.post(f"/api/procedures/{proc_id}/publish")
    instance_id = web_client.post(
        "/api/procedure-instances", json={"procedure_id": proc_id}
    ).json()["id"]
    inst = web_client.get(f"/api/procedure-instances/{instance_id}").json()
    se_by_num = {s["step_number"]: s["id"] for s in inst["step_executions"]}

    # Raise on step 1, bind the boundary to step 3 (start_blocked on step 3).
    nc = web_client.post(
        f"/api/procedure-instances/{instance_id}/steps/1/nc", json={"title": "Bound NC"}
    ).json()
    web_client.post(
        f"/api/issues/{nc['id']}/containment",
        json={"containment": "step", "containment_step_id": se_by_num[3]},
    )

    page = web_client.get(f"/executions/{instance_id}")
    assert page.status_code == 200
    # Step 3's COMPLETE control is inert — the server would 400 the bound hold.
    assert "completeStep(3, this)" not in page.text
    assert "disabled>COMPLETE</button>" in page.text
    # The reason line names the issue beside the disabled button.
    assert nc["issue_number"] in page.text


def test_dockbar_gated_step_renders_inert_controls(web_client):
    """The docked bar mirrors the row register: a held step's COMPLETE and
    SKIP render disabled with the reason attached, never absent."""
    instance_id, by_label = _build_instance_with_sub_steps(web_client)
    nc = _raise_nc(web_client, instance_id, by_label["1.1"])

    bar = web_client.get(f"/executions/{instance_id}/dockbar?step={by_label['1.1']}")
    assert bar.status_code == 200
    assert "disabled>COMPLETE</button>" in bar.text
    assert "disabled>SKIP</button>" in bar.text
    assert nc["issue_number"] in bar.text
    assert f"completeStep({by_label['1.1']}," not in bar.text


def test_redline_control_renders_in_step_actions(web_client):
    """(rehearsal) + REDLINE is discoverable: once an op carries an open NC,
    the op's step action rows render + REDLINE next to ATTACH/ISSUE — not
    only the dockbar overflow, which keeps its entry. No open NC, no
    control."""
    instance_id, by_label = _build_instance_with_sub_steps(web_client)

    page = web_client.get(f"/executions/{instance_id}")
    assert page.status_code == 200
    assert "showRedlineModal(" not in page.text

    nc = _raise_nc(web_client, instance_id, by_label["1.1"])
    page = web_client.get(f"/executions/{instance_id}")
    assert "+ REDLINE" in page.text
    # The document column carries it (step action rows), not just the bar.
    assert f"showRedlineModal({by_label['1']}," in page.text
    assert nc["issue_number"] in page.text

    # The dockbar overflow keeps its entry — same predicate, same entry point.
    bar = web_client.get(f"/executions/{instance_id}/dockbar?step={by_label['1.1']}")
    assert bar.status_code == 200
    assert "+ REDLINE" in bar.text
    assert f"showRedlineModal({by_label['1']}," in bar.text


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
    assert "disabled>COMPLETE</button>" not in page.text
    assert "disabled>SKIP</button>" not in page.text
    assert f"completeStep({by_label['1.1']}," in page.text


def test_issue_page_holding_readout(web_client):
    """(§10.6) The holds line states the issue's consequences in one glance;
    an advisory issue gets the one-line empty state and no disposition panel."""
    instance_id, by_label = _build_instance_with_sub_steps(web_client)
    nc = _raise_nc(web_client, instance_id, by_label["1.1"])

    page = web_client.get(f"/issues/{nc['id']}")
    assert page.status_code == 200
    assert ">HOLDS</div>" in page.text
    assert "1.1 COMPLETE" in page.text
    assert "OP 1 COMPLETE" in page.text
    assert "UNDISPOSITIONED" in page.text
    assert "⛔" not in page.text
    # View mode shows the disposition draft as facts; the form is an edit.
    assert "DISPOSITION" in page.text
    assert 'id="disposition-btn"' not in page.text

    # Edit mode carries the form with no readiness ceremony: one gated button.
    page = web_client.get(f"/issues/{nc['id']}?edit=1")
    assert 'id="disposition-btn"' in page.text
    assert "DISPOSITION READINESS" not in page.text
    assert "SIGN DISPOSITION" not in page.text

    advisory = web_client.post("/api/issues", json={"title": "Note only"}).json()
    page = web_client.get(f"/issues/{advisory['id']}")
    assert page.status_code == 200
    # The empty-line macro wraps the label in a span (Amendment 6 grammar)
    assert 'Holds</span> — none' in page.text
    # No disposition gate above advisory: no panel, no state badge, CLOSE free.
    assert 'id="disposition-btn"' not in page.text
    assert "UNDISPOSITIONED" not in page.text
    assert "closeIssue()" in page.text
    assert 'id="disposition-btn"' not in web_client.get(f"/issues/{advisory['id']}?edit=1").text


def test_disposition_confirm_is_one_line(web_client):
    """The disposition confirm is the slim signature register (risk-accept
    parity): one consequence sentence — what signing releases — with
    CONFIRM/ABORT inline; no box-in-box, no restatement of the type and
    rationale sitting in the form right above."""
    instance_id, by_label = _build_instance_with_sub_steps(web_client)
    nc = _raise_nc(web_client, instance_id, by_label["1.1"])

    page = web_client.get(f"/issues/{nc['id']}?edit=1")
    assert page.status_code == 200
    assert 'id="disposition-confirm"' in page.text
    assert "sign-confirm" in page.text
    assert "releases" in page.text
    # De-ceremonied: no boxed signature block, no restated type, no client
    # timestamp (the server stamps the signature).
    assert "baseline-confirm" not in page.text
    assert "baseline-signature" not in page.text
    assert 'id="disposition-type-label"' not in page.text
    assert 'id="disposition-time"' not in page.text


def test_issue_page_view_mode_default(web_client):
    """The issue page opens read-only: facts, an EDIT control, no field
    editors. ?edit=1 renders the in-place editors and a DONE control."""
    instance_id, by_label = _build_instance_with_sub_steps(web_client)
    nc = _raise_nc(web_client, instance_id, by_label["1.1"])

    page = web_client.get(f"/issues/{nc['id']}")
    assert page.status_code == 200
    assert "?edit=1" in page.text
    assert 'id="type-select"' not in page.text
    assert 'id="title-input"' not in page.text
    assert 'id="execution-select"' not in page.text
    assert 'id="disposition-type-select"' not in page.text

    page = web_client.get(f"/issues/{nc['id']}?edit=1")
    assert page.status_code == 200
    assert ">DONE<" in page.text
    assert 'id="type-select"' in page.text
    assert 'id="title-input"' in page.text
    assert 'id="disposition-type-select"' in page.text


def test_issue_page_links_work_order_and_boundary(web_client):
    """The LINKS panel attaches a work order and a containment boundary step
    from the issue side."""
    instance_id, by_label = _build_instance_with_sub_steps(web_client)

    issue = web_client.post("/api/issues", json={"title": "Manual", "containment": "step"}).json()
    page = web_client.get(f"/issues/{issue['id']}?edit=1")
    assert 'id="execution-select"' in page.text
    assert 'id="boundary-step-select"' not in page.text  # no WO linked yet

    # Link the WO; the boundary select appears with the WO's steps.
    r = web_client.patch(
        f"/api/issues/{issue['id']}", json={"procedure_instance_id": instance_id}
    )
    assert r.status_code == 200
    page = web_client.get(f"/issues/{issue['id']}?edit=1")
    assert 'id="boundary-step-select"' in page.text
    assert "OP 1 —" in page.text

    # Set the boundary; containment becomes anchored and renders in view mode.
    step_id = None
    import re

    m = re.search(r'value="(\d+)" >1\.1 —', page.text.replace("\n", " "))
    if m:
        step_id = int(m.group(1))
    if step_id is None:
        # fall back: any option value inside the boundary select
        seg = page.text.split('id="boundary-step-select"', 1)[1].split("</select>", 1)[0]
        step_id = int(re.search(r'value="(\d+)"', seg).group(1))
    r = web_client.post(
        f"/api/issues/{issue['id']}/containment",
        json={"containment": "step", "containment_step_id": step_id},
    )
    assert r.status_code == 200
    page = web_client.get(f"/issues/{issue['id']}")
    assert "BOUNDARY" in page.text


def test_anomaly_modal_states_raised_step_and_boundary_consequence(web_client):
    """(rehearsal) Raise at 5.3, block 6.2: the modal states the raised step
    as a labeled fact (RAISED AT) and RESOLVE BY carries its consequence —
    both ends are expressible (raised_step_id + containment_step_id), the
    labels now say so."""
    instance_id, _ = _build_instance_with_sub_steps(web_client)

    page = web_client.get(f"/executions/{instance_id}")
    assert page.status_code == 200
    assert "RAISED AT" in page.text
    assert "RESOLVE BY" in page.text
    assert "Blocks that step's COMPLETE until disposition" in page.text
    # The default boundary is the raised step, consequence named.
    assert "this step — holds its COMPLETE" in page.text


def test_issue_boundary_select_carries_consequence(web_client):
    """The issue page's BOUNDARY select mirrors the anomaly modal's
    RESOLVE BY consequence labeling."""
    instance_id, _ = _build_instance_with_sub_steps(web_client)
    issue = web_client.post("/api/issues", json={"title": "Manual", "containment": "step"}).json()
    r = web_client.patch(f"/api/issues/{issue['id']}", json={"procedure_instance_id": instance_id})
    assert r.status_code == 200

    page = web_client.get(f"/issues/{issue['id']}?edit=1")
    assert 'id="boundary-step-select"' in page.text
    assert "Blocks that step's COMPLETE until disposition" in page.text


def test_issue_boundary_dash_option_sends_explicit_null(web_client):
    """The '—' option must clear the boundary, not silently no-op: the page
    JS sends an explicit containment_step_id null (the API distinguishes
    omitted from null — F9). Tripwire on the inline handler; the API-side
    clear is covered by test_set_containment_clears_boundary_with_explicit_null."""
    instance_id, _ = _build_instance_with_sub_steps(web_client)
    issue = web_client.post("/api/issues", json={"title": "Bound", "containment": "step"}).json()
    r = web_client.patch(f"/api/issues/{issue['id']}", json={"procedure_instance_id": instance_id})
    assert r.status_code == 200

    page = web_client.get(f"/issues/{issue['id']}?edit=1")
    assert 'onchange="linkBoundaryStep(this.value)"' in page.text
    assert '<option value="">—</option>' in page.text
    assert "containment_step_id: value ? parseInt(value) : null" in page.text
    # The silent no-op guard is gone.
    assert "if (!value) return;" not in page.text.split("linkBoundaryStep")[1].split("}")[0]


def test_issues_list_state_column(web_client):
    """(§6) The STATE column renders; undispositioned-with-containment sorts
    first; the HOLDS column is gone."""
    instance_id, by_label = _build_instance_with_sub_steps(web_client)
    nc = _raise_nc(web_client, instance_id, by_label["1.1"])
    web_client.post("/api/issues", json={"title": "Plain task"})

    rows = web_client.get("/issues/table")
    assert rows.status_code == 200
    assert "UNDISP" in rows.text
    assert "⛔" not in rows.text
    # The blocking issue leads the table.
    assert rows.text.find(nc["issue_number"]) < rows.text.find("Plain task")

    page = web_client.get("/issues")
    assert page.status_code == 200
    assert "STATE" in page.text
    assert "DISP-STATE" not in page.text
    assert "HOLDING" not in page.text


def test_issues_list_mixed_register(web_client):
    """(exit 7) In a mixed register only the bearing-undispositioned row
    carries warning weight: one error badge, the TASK row calm plain text,
    titles one-line."""
    instance_id, by_label = _build_instance_with_sub_steps(web_client)
    _raise_nc(web_client, instance_id, by_label["1.1"])
    web_client.post("/api/issues", json={"title": "Plain task"})

    rows = web_client.get("/issues/table")
    assert rows.status_code == 200
    # Exactly one warning-weight badge: the bearing-undispositioned row.
    assert rows.text.count("status-error") == 1
    assert ">UNDISP<" in rows.text
    # The advisory TASK row is calm: plain text state, plain unboxed type.
    assert ">open<" in rows.text
    assert ">TASK<" in rows.text
    # One-line rows: title cells clip.
    assert rows.text.count("cell-clip") == 2


def test_issues_list_state_filter_deep_link(web_client):
    """?state= preselects the STATE filter and the tbody includes it on load."""
    page = web_client.get("/issues?state=undispositioned")
    assert page.status_code == 200
    assert 'value="undispositioned" selected' in page.text

    rows = web_client.get("/issues/table?state=open")
    assert rows.status_code == 200


def test_execution_issues_tab_state(web_client):
    """(§9.4) The execution ISSUES section shows the STATE column, holds
    first, same register as the issues list."""
    instance_id, by_label = _build_instance_with_sub_steps(web_client)
    _raise_nc(web_client, instance_id, by_label["1.1"])

    page = web_client.get(f"/executions/{instance_id}?tab=issues")
    assert page.status_code == 200
    assert "DISP-STATE" not in page.text
    assert "UNDISP" in page.text
    assert "⛔" not in page.text


def test_new_issue_page_renders(web_client):
    page = web_client.get("/issues/new?procedure_instance_id=1")
    assert page.status_code == 200
    assert "CONTAINMENT" in page.text


def test_new_issue_form_links_execution(web_client):
    """/issues/new offers the work-order link — same select as the issue
    page's LINKS panel; ?execution= (and the older ?procedure_instance_id=)
    pre-selects it (context pre-fill)."""
    instance_id, _ = _build_instance_with_sub_steps(web_client)

    page = web_client.get("/issues/new")
    assert page.status_code == 200
    assert 'id="execution-select"' in page.text
    assert f'value="{instance_id}" selected' not in page.text

    for param in ("execution", "procedure_instance_id"):
        page = web_client.get(f"/issues/new?{param}={instance_id}")
        assert page.status_code == 200
        assert f'value="{instance_id}" selected' in page.text
    # The form posts the selected work order to the create API.
    assert 'name="procedure_instance_id"' in page.text
