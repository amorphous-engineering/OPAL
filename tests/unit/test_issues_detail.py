"""Issue detail, list and link behaviour that the SPA relies on."""


def _sign(client, issue_id, dtype="use_as_is", rationale="acceptable as built"):
    return client.post(
        f"/api/issues/{issue_id}/disposition",
        json={"disposition_type": dtype, "disposition_rationale": rationale},
    )


def _wo(client, wo="WO-ISS-1"):
    proc_id = client.post("/api/procedures", json={"name": "Link Proc"}).json()["id"]
    client.post(f"/api/procedures/{proc_id}/steps", json={"title": "Step 1"})
    client.post(f"/api/procedures/{proc_id}/publish")
    resp = client.post(
        "/api/procedure-instances", json={"procedure_id": proc_id, "work_order_number": wo}
    )
    assert resp.status_code == 201
    return proc_id, resp.json()["id"]


def test_detail_carries_names_and_signature(client):
    proc_id, wo_id = _wo(client)
    created = client.post(
        "/api/issues",
        json={
            "title": "Linked",
            "containment": "wo",
            "procedure_id": proc_id,
            "procedure_instance_id": wo_id,
        },
    ).json()
    detail = client.get(f"/api/issues/{created['id']}").json()
    assert detail["work_order_number"] == "WO-ISS-1"
    assert detail["procedure_name"] == "Link Proc"
    assert detail["raised_by_name"]
    assert detail["risks"] == []
    assert detail["redline_ops"] == []
    assert detail["dispositioned_by_name"] is None

    signed = _sign(client, created["id"]).json()
    assert signed["dispositioned_by_name"] == detail["raised_by_name"]
    assert signed["self_dispositioned"] is True


def test_detail_lists_linked_risks(client):
    issue = client.post("/api/issues", json={"title": "Mitigation"}).json()
    risk = client.post("/api/risks", json={"title": "Cold solder", "probability": 3, "impact": 3})
    assert risk.status_code == 201, risk.text
    link = client.post(f"/api/risks/{risk.json()['id']}/issues", json={"issue_id": issue["id"]})
    assert link.status_code in (200, 201), link.text
    detail = client.get(f"/api/issues/{issue['id']}").json()
    assert [r["risk_number"] for r in detail["risks"]] == [risk.json()["risk_number"]]
    assert detail["risks"][0]["relation"] == "mitigation"


def test_patch_null_clears_links_and_assignee(client):
    proc_id, wo_id = _wo(client, "WO-ISS-2")
    me = client.get("/api/users/directory").json()[0]["id"]
    issue = client.post(
        "/api/issues",
        json={
            "title": "Clearable",
            "procedure_id": proc_id,
            "procedure_instance_id": wo_id,
            "assigned_to_id": me,
        },
    ).json()
    assert issue["assigned_to_id"] == me

    cleared = client.patch(
        f"/api/issues/{issue['id']}",
        json={"assigned_to_id": None, "procedure_id": None, "procedure_instance_id": None},
    ).json()
    assert cleared["assigned_to_id"] is None
    assert cleared["procedure_id"] is None
    assert cleared["procedure_instance_id"] is None

    # An omitted field is untouched.
    again = client.patch(f"/api/issues/{issue['id']}", json={"title": "Renamed"}).json()
    assert again["title"] == "Renamed"


def test_cannot_detach_work_order_while_blocking(client):
    _, wo_id = _wo(client, "WO-ISS-3")
    issue = client.post(
        "/api/issues",
        json={"title": "Holds", "containment": "wo", "procedure_instance_id": wo_id},
    ).json()
    resp = client.patch(f"/api/issues/{issue['id']}", json={"procedure_instance_id": None})
    assert resp.status_code == 400
    assert "undispositioned" in resp.json()["detail"]

    _sign(client, issue["id"])
    resp = client.patch(f"/api/issues/{issue['id']}", json={"procedure_instance_id": None})
    assert resp.status_code == 200


def test_patch_rejects_unknown_link_targets(client):
    issue = client.post("/api/issues", json={"title": "Bad link"}).json()
    for field in ("part_id", "procedure_id", "procedure_instance_id", "assigned_to_id"):
        resp = client.patch(f"/api/issues/{issue['id']}", json={field: 999999})
        assert resp.status_code == 400, field


def test_steps_endpoint_lists_work_order_steps(client):
    _, wo_id = _wo(client, "WO-ISS-4")
    issue = client.post(
        "/api/issues",
        json={"title": "Steps", "containment": "step", "procedure_instance_id": wo_id},
    ).json()
    steps = client.get(f"/api/issues/{issue['id']}/steps").json()
    assert [s["title"] for s in steps] == ["Step 1"]
    unlinked = client.post("/api/issues", json={"title": "No WO"}).json()
    assert client.get(f"/api/issues/{unlinked['id']}/steps").json() == []

    # Binding the boundary to one of those steps works and is labelled.
    bound = client.post(
        f"/api/issues/{issue['id']}/containment",
        json={"containment": "step", "containment_step_id": steps[0]["id"]},
    ).json()
    assert bound["containment_step_label"] == steps[0]["label"]


def test_list_default_order_puts_blocking_first(client):
    client.post("/api/issues", json={"title": "Advisory old"})
    blocking = client.post("/api/issues", json={"title": "Blocking", "containment": "wo"}).json()
    client.post("/api/issues", json={"title": "Advisory new"})
    items = client.get("/api/issues").json()["items"]
    assert items[0]["id"] == blocking["id"]


def test_list_sort_search_and_assignee_filter(client):
    me = client.get("/api/users/directory").json()[0]["id"]
    a = client.post("/api/issues", json={"title": "Bravo", "priority": "low"}).json()
    b = client.post(
        "/api/issues", json={"title": "Alpha", "priority": "critical", "assigned_to_id": me}
    ).json()

    by_title = client.get("/api/issues", params={"sort": "title", "dir": "asc"}).json()["items"]
    assert [i["title"] for i in by_title][:2] == ["Alpha", "Bravo"]
    by_pri = client.get("/api/issues", params={"sort": "priority", "dir": "desc"}).json()["items"]
    assert by_pri[0]["id"] == b["id"]
    assert client.get("/api/issues", params={"sort": "bogus"}).status_code == 400

    mine = client.get("/api/issues", params={"assigned_to_id": me}).json()["items"]
    assert [i["id"] for i in mine] == [b["id"]]
    found = client.get("/api/issues", params={"search": a["issue_number"]}).json()["items"]
    assert [i["id"] for i in found] == [a["id"]]


def test_comments_carry_author_name(client):
    issue = client.post("/api/issues", json={"title": "Chatty"}).json()
    client.post(f"/api/issues/{issue['id']}/comments", json={"body": "hello"})
    comments = client.get(f"/api/issues/{issue['id']}/comments").json()
    assert comments[0]["user_name"]


def test_work_order_supplies_procedure(client):
    proc_id, wo_id = _wo(client, "WO-ISS-5")
    created = client.post("/api/issues", json={"title": "Derived", "procedure_instance_id": wo_id})
    assert created.json()["procedure_id"] == proc_id

    loose = client.post("/api/issues", json={"title": "Later"}).json()
    linked = client.patch(f"/api/issues/{loose['id']}", json={"procedure_instance_id": wo_id})
    assert linked.json()["procedure_id"] == proc_id
    assert linked.json()["procedure_name"] == "Link Proc"
