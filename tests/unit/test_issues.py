"""Issues API tests.

Two gates, not one: raised → UNDISPOSITIONED → DISPOSITIONED → CLOSED.
"""


def _sign(client, issue_id, dtype="use_as_is", rationale="acceptable as built"):
    return client.post(
        f"/api/issues/{issue_id}/disposition",
        json={"disposition_type": dtype, "disposition_rationale": rationale},
    )


def test_create_issue(client):
    """Test creating a new issue."""
    response = client.post(
        "/api/issues",
        json={
            "title": "Test Bug",
            "description": "Something is broken",
            "issue_type": "bug",
            "priority": "high",
        },
    )
    assert response.status_code == 201

    data = response.json()
    assert data["title"] == "Test Bug"
    assert data["description"] == "Something is broken"
    assert data["issue_type"] == "bug"
    assert data["priority"] == "high"
    assert data["status"] == "open"
    assert data["containment"] == "advisory"
    assert data["disp_state"] == "undispositioned"


def test_list_issues(client):
    """Test listing issues."""
    client.post("/api/issues", json={"title": "Issue A"})
    client.post("/api/issues", json={"title": "Issue B"})

    response = client.get("/api/issues")
    assert response.status_code == 200

    data = response.json()
    assert data["total"] >= 2


def test_filter_issues_by_type(client):
    """Test filtering issues by type."""
    client.post("/api/issues", json={"title": "Bug 1", "issue_type": "bug"})
    client.post("/api/issues", json={"title": "Task 1", "issue_type": "task"})

    response = client.get("/api/issues?issue_type=bug")
    assert response.status_code == 200

    data = response.json()
    assert all(i["issue_type"] == "bug" for i in data["items"])


def test_filter_issues_by_disp_state(client):
    """disp_state is derived: undispositioned until signed, then dispositioned."""
    client.post("/api/issues", json={"title": "Undispositioned Issue"})
    issue2 = client.post("/api/issues", json={"title": "Dispositioned Issue"}).json()
    assert _sign(client, issue2["id"]).status_code == 200

    response = client.get("/api/issues?disp_state=undispositioned")
    assert response.status_code == 200
    items = response.json()["items"]
    assert all(i["disp_state"] == "undispositioned" for i in items)
    assert not any(i["id"] == issue2["id"] for i in items)

    response = client.get("/api/issues?disp_state=dispositioned")
    assert any(i["id"] == issue2["id"] for i in response.json()["items"])


def test_get_issue(client):
    """Test getting a specific issue."""
    create_response = client.post(
        "/api/issues",
        json={"title": "Specific Issue"},
    )
    issue_id = create_response.json()["id"]

    response = client.get(f"/api/issues/{issue_id}")
    assert response.status_code == 200
    assert response.json()["title"] == "Specific Issue"


def test_update_issue(client):
    """Test updating an issue."""
    create_response = client.post(
        "/api/issues",
        json={"title": "Original Title"},
    )
    issue_id = create_response.json()["id"]

    response = client.patch(
        f"/api/issues/{issue_id}",
        json={
            "title": "Updated Title",
            "priority": "critical",
        },
    )
    assert response.status_code == 200

    data = response.json()
    assert data["title"] == "Updated Title"
    assert data["priority"] == "critical"


def test_delete_issue(client):
    """Test soft deleting an issue."""
    create_response = client.post(
        "/api/issues",
        json={"title": "To Be Deleted"},
    )
    issue_id = create_response.json()["id"]

    response = client.delete(f"/api/issues/{issue_id}")
    assert response.status_code == 204

    # Should not be found
    get_response = client.get(f"/api/issues/{issue_id}")
    assert get_response.status_code == 404


def test_issue_with_part_link(client):
    """Test creating an issue linked to a part."""
    # Create part
    part_response = client.post("/api/parts", json={"name": "Widget"})
    part_id = part_response.json()["id"]

    # Create issue linked to part
    response = client.post(
        "/api/issues",
        json={"title": "Part Issue", "part_id": part_id},
    )
    assert response.status_code == 201
    assert response.json()["part_id"] == part_id


def test_issue_with_procedure_link(client):
    """Test creating an issue linked to a procedure."""
    # Create procedure
    proc_response = client.post("/api/procedures", json={"name": "Test Proc"})
    proc_id = proc_response.json()["id"]

    # Create issue linked to procedure
    response = client.post(
        "/api/issues",
        json={"title": "Procedure Issue", "procedure_id": proc_id},
    )
    assert response.status_code == 201
    assert response.json()["procedure_id"] == proc_id


def test_get_issue_types(client):
    """Test getting issue types."""
    response = client.get("/api/issues/types")
    assert response.status_code == 200

    types = response.json()
    assert "non_conformance" in types
    assert "bug" in types
    assert "task" in types
    assert "improvement" in types


def test_get_issue_statuses(client):
    """Status is open|closed — the disposition gate is derived, not a status."""
    response = client.get("/api/issues/statuses")
    assert response.status_code == 200
    assert response.json() == ["open", "closed"]


def test_get_disposition_types(client):
    """MIL-STD-1520 disposition set."""
    response = client.get("/api/issues/disposition-types")
    assert response.status_code == 200
    assert set(response.json()) == {
        "use_as_is",
        "rework",
        "repair",
        "scrap",
        "return_to_supplier",
        "no_defect",
    }


def test_get_containments(client):
    response = client.get("/api/issues/containments")
    assert response.status_code == 200
    assert set(response.json()) == {"step", "op", "wo", "advisory"}


def test_get_issue_priorities(client):
    """Test getting issue priorities."""
    response = client.get("/api/issues/priorities")
    assert response.status_code == 200

    priorities = response.json()
    assert "low" in priorities
    assert "medium" in priorities
    assert "high" in priorities
    assert "critical" in priorities


def test_create_issue_comment(client):
    """Test adding a comment to an issue."""
    issue = client.post("/api/issues", json={"title": "Comment Test"}).json()

    response = client.post(
        f"/api/issues/{issue['id']}/comments",
        json={"body": "This is a test comment"},
    )
    assert response.status_code == 201

    data = response.json()
    assert data["body"] == "This is a test comment"
    assert data["issue_id"] == issue["id"]


def test_list_issue_comments(client):
    """Test listing comments on an issue in chronological order."""
    issue = client.post("/api/issues", json={"title": "Comments List Test"}).json()

    client.post(f"/api/issues/{issue['id']}/comments", json={"body": "First comment"})
    client.post(f"/api/issues/{issue['id']}/comments", json={"body": "Second comment"})

    response = client.get(f"/api/issues/{issue['id']}/comments")
    assert response.status_code == 200

    data = response.json()
    assert len(data) == 2
    assert data[0]["body"] == "First comment"
    assert data[1]["body"] == "Second comment"


# ============ Disposition — the signature moment ============


def test_sign_disposition(client):
    """Signing sets the derived gate; the issue remains open."""
    issue = client.post("/api/issues", json={"title": "Disposition Test"}).json()
    assert issue["dispositioned"] is False

    response = _sign(client, issue["id"], "rework", "rework per redline")
    assert response.status_code == 200

    data = response.json()
    assert data["disposition_type"] == "rework"
    assert data["disposition_rationale"] == "rework per redline"
    assert data["dispositioned"] is True
    assert data["disp_state"] == "dispositioned"
    assert data["status"] == "open"
    assert data["dispositioned_by_id"] is not None
    assert data["dispositioned_at"] is not None


def test_sign_disposition_requires_rationale(client):
    issue = client.post("/api/issues", json={"title": "No Rationale"}).json()
    response = client.post(
        f"/api/issues/{issue['id']}/disposition",
        json={"disposition_type": "use_as_is", "disposition_rationale": ""},
    )
    assert response.status_code == 422


def test_signed_disposition_is_immutable(client):
    """A different decision is a new signature, not an edit."""
    issue = client.post("/api/issues", json={"title": "Immutable"}).json()
    assert _sign(client, issue["id"]).status_code == 200

    response = client.patch(
        f"/api/issues/{issue['id']}",
        json={"disposition_type": "scrap"},
    )
    assert response.status_code == 400

    response = _sign(client, issue["id"], "scrap", "second thoughts")
    assert response.status_code == 400


def test_disposition_draft_via_patch(client):
    """Type and rationale can be drafted before the signature; drafting alone
    does not disposition the issue."""
    issue = client.post("/api/issues", json={"title": "Draft Test"}).json()

    response = client.patch(
        f"/api/issues/{issue['id']}",
        json={
            "root_cause": "Material defect",
            "corrective_action": "Replace batch",
            "disposition_type": "rework",
            "disposition_rationale": "Rework per procedure",
        },
    )
    assert response.status_code == 200

    data = response.json()
    assert data["root_cause"] == "Material defect"
    assert data["disposition_type"] == "rework"
    assert data["dispositioned"] is False
    assert data["disp_state"] == "undispositioned"


# ============ Close — disposition first, always ============


def test_close_requires_disposition(client):
    """(§10.4) Closing an undispositioned issue is impossible."""
    issue = client.post("/api/issues", json={"title": "Close Attempt"}).json()
    response = client.patch(f"/api/issues/{issue['id']}", json={"status": "closed"})
    assert response.status_code == 400
    assert "undispositioned" in response.json()["detail"]

    assert _sign(client, issue["id"]).status_code == 200
    response = client.patch(f"/api/issues/{issue['id']}", json={"status": "closed"})
    assert response.status_code == 200
    assert response.json()["disp_state"] == "closed"


def test_nc_close_requires_corrective_action(client):
    """(§10.4) NC-type issues require corrective action text to close."""
    issue = client.post(
        "/api/issues", json={"title": "NC Close", "issue_type": "non_conformance"}
    ).json()
    assert _sign(client, issue["id"]).status_code == 200

    response = client.patch(f"/api/issues/{issue['id']}", json={"status": "closed"})
    assert response.status_code == 400
    assert "corrective action" in response.json()["detail"]

    response = client.patch(
        f"/api/issues/{issue['id']}",
        json={"status": "closed", "corrective_action": "Updated torque spec in template"},
    )
    assert response.status_code == 200


def test_cannot_sign_closed_issue(client):
    issue = client.post("/api/issues", json={"title": "Closed Sign"}).json()
    assert _sign(client, issue["id"]).status_code == 200
    client.patch(f"/api/issues/{issue['id']}", json={"status": "closed"})

    response = client.post(
        f"/api/issues/{issue['id']}/disposition",
        json={"disposition_type": "scrap", "disposition_rationale": "x"},
    )
    assert response.status_code == 400


# ============ Containment changes ============


def test_widening_containment_is_one_click(client):
    issue = client.post("/api/issues", json={"title": "Widen", "containment": "step"}).json()
    response = client.post(
        f"/api/issues/{issue['id']}/containment",
        json={"containment": "wo"},
    )
    assert response.status_code == 200
    assert response.json()["containment"] == "wo"


def test_narrowing_containment_requires_note(client):
    """Releasing a hold is a decision, not an edit — audited with a note."""
    # Needs a real hold: an execution-raised NC with step containment.
    proc = client.post("/api/procedures", json={"name": "Containment Proc"}).json()
    client.post(f"/api/procedures/{proc['id']}/steps", json={"title": "Step 1"})
    client.post(f"/api/procedures/{proc['id']}/publish")
    instance = client.post("/api/procedure-instances", json={"procedure_id": proc["id"]}).json()
    client.post(f"/api/procedure-instances/{instance['id']}/steps/1/start")
    issue = client.post(
        f"/api/procedure-instances/{instance['id']}/steps/1/nc",
        json={"title": "NC", "priority": "medium"},
    ).json()

    response = client.post(
        f"/api/issues/{issue['id']}/containment",
        json={"containment": "advisory"},
    )
    assert response.status_code == 400
    assert "note is required" in response.json()["detail"]

    response = client.post(
        f"/api/issues/{issue['id']}/containment",
        json={"containment": "advisory", "note": "cosmetic only, crew chief concurs"},
    )
    assert response.status_code == 200
    assert response.json()["containment"] == "advisory"

    # The note lands in the activity log.
    comments = client.get(f"/api/issues/{issue['id']}/comments").json()
    assert any("Containment narrowed" in c["body"] for c in comments)


def test_issue_holding_endpoint(client):
    """An advisory issue holds nothing."""
    issue = client.post("/api/issues", json={"title": "Advisory"}).json()
    response = client.get(f"/api/issues/{issue['id']}/holding")
    assert response.status_code == 200
    assert response.json() == []
