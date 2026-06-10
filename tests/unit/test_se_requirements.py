"""SE module Phase 1: Requirement model, lifecycle machinery, yaml importer."""

import pytest
from sqlalchemy.exc import IntegrityError
from sqlalchemy.orm import Session

from opal.core.designators import generate_requirement_number
from opal.db.base import LifecycleState
from opal.db.models import Part, PartRequirement, Requirement, User
from opal.project import ProjectConfig, RequirementConfig
from opal.se.import_requirements import import_requirements_from_config
from opal.se.lifecycle import LifecycleError, baseline, cancel, ensure_mutable, revise


def _make_requirement(db: Session, **overrides) -> Requirement:
    values = {
        "req_number": generate_requirement_number(db),
        "title": "Chamber pressure",
        "statement": "The engine shall sustain a chamber pressure of 20 bar ± 1 bar.",
        "rationale": "Sized from thrust target and injector pressure drop budget.",
        "category": "performance",
        "level": 1,
        "verification_method": "test",
    }
    values.update(overrides)
    req = Requirement(**values)
    db.add(req)
    db.flush()
    return req


# ============ Designators ============


def test_requirement_number_format(db_session):
    assert generate_requirement_number(db_session) == "REQ-0001"
    assert generate_requirement_number(db_session) == "REQ-0002"


# ============ Model ============


def test_requirement_defaults(db_session):
    req = _make_requirement(db_session)
    assert req.lifecycle_state == LifecycleState.DRAFT.value
    assert req.revision == 1
    assert req.supersedes_id is None
    assert req.is_mutable
    assert not req.is_baselined


def test_req_number_revision_unique(db_session):
    req = _make_requirement(db_session)
    db_session.add(
        Requirement(
            req_number=req.req_number,
            revision=1,
            title="dup",
            statement="The duplicate shall not exist.",
        )
    )
    with pytest.raises(IntegrityError):
        db_session.flush()


def test_flowdown_hierarchy(db_session):
    root = _make_requirement(db_session, level=0)
    child = _make_requirement(db_session, parent_id=root.id, level=1)
    db_session.flush()
    assert child.parent.id == root.id
    assert [c.id for c in root.children] == [child.id]


# ============ Lifecycle ============


def test_baseline_requires_rationale(db_session, test_user):
    req = _make_requirement(db_session, rationale=None)
    with pytest.raises(LifecycleError, match="rationale"):
        baseline(db_session, req, test_user.id)


def test_baseline_blocks_tbd_and_unowned_tbr(db_session, test_user):
    req = _make_requirement(db_session, tbd=True)
    with pytest.raises(LifecycleError, match="TBD"):
        baseline(db_session, req, test_user.id)

    req2 = _make_requirement(db_session, tbr=True)
    with pytest.raises(LifecycleError, match="TBR requires an owner"):
        baseline(db_session, req2, test_user.id)


def test_baseline_sets_fields_and_locks(db_session, test_user):
    req = _make_requirement(db_session)
    baseline(db_session, req, test_user.id)

    assert req.is_baselined
    assert req.baselined_at is not None
    assert req.baselined_by_id == test_user.id
    with pytest.raises(LifecycleError, match="immutable"):
        ensure_mutable(req)
    # Cannot baseline twice
    with pytest.raises(LifecycleError, match="cannot baseline"):
        baseline(db_session, req, test_user.id)


def test_revise_requires_baseline(db_session):
    req = _make_requirement(db_session)
    with pytest.raises(LifecycleError, match="only baselined"):
        revise(db_session, req)


def test_revision_chain(db_session, test_user):
    rev1 = _make_requirement(db_session)
    baseline(db_session, rev1, test_user.id)

    rev2 = revise(
        db_session,
        rev1,
        statement="The engine shall sustain a chamber pressure of 25 bar ± 1 bar.",
    )
    assert rev2.id != rev1.id
    assert rev2.req_number == rev1.req_number
    assert rev2.revision == 2
    assert rev2.supersedes_id == rev1.id
    assert rev2.lifecycle_state == LifecycleState.DRAFT.value
    assert "25 bar" in rev2.statement
    assert rev2.rationale == rev1.rationale  # data columns copied

    # Predecessor remains the effective baseline until rev2 baselines.
    assert rev1.is_baselined
    baseline(db_session, rev2, test_user.id)
    assert rev1.lifecycle_state == LifecycleState.SUPERSEDED.value
    assert rev2.is_baselined


def test_revise_rejects_lifecycle_overrides(db_session, test_user):
    req = _make_requirement(db_session)
    baseline(db_session, req, test_user.id)
    with pytest.raises(LifecycleError, match="lifecycle-managed"):
        revise(db_session, req, revision=99)


def test_cancel_states(db_session, test_user):
    req = _make_requirement(db_session)
    cancel(db_session, req)
    assert req.lifecycle_state == LifecycleState.CANCELLED.value
    with pytest.raises(LifecycleError, match="terminal"):
        cancel(db_session, req)


# ============ Importer ============


def _config(*reqs: RequirementConfig) -> ProjectConfig:
    return ProjectConfig(name="Test Project", requirements=list(reqs))


def test_import_creates_and_relinks(db_session: Session, test_user: User):
    part = Part(name="Injector", internal_pn="PN-1-0001", tier=1)
    db_session.add(part)
    db_session.flush()
    link = PartRequirement(part_id=part.id, requirement_id="REQ-001")
    db_session.add(link)
    db_session.flush()

    config = _config(
        RequirementConfig(
            id="REQ-001",
            title="Leak rate",
            description="The injector shall leak less than 1 sccm at 30 bar.",
            category="performance",
        ),
        RequirementConfig(id="REQ-002", title="Mass budget"),
    )
    result = import_requirements_from_config(db_session, config, user_id=test_user.id)

    assert result.created == ["REQ-001", "REQ-002"]
    assert result.skipped == []
    assert result.relinked == 1

    req = db_session.query(Requirement).filter(Requirement.req_number == "REQ-001").one()
    assert req.statement.startswith("The injector shall leak")
    assert req.level == 0
    assert req.lifecycle_state == LifecycleState.DRAFT.value
    assert link.requirement_ref_id == req.id
    assert link.requirement_ref.req_number == "REQ-001"

    # Title-only entries fall back to title as statement.
    req2 = db_session.query(Requirement).filter(Requirement.req_number == "REQ-002").one()
    assert req2.statement == "Mass budget"


def test_import_is_idempotent(db_session: Session):
    config = _config(RequirementConfig(id="REQ-010", title="Thrust"))
    first = import_requirements_from_config(db_session, config)
    second = import_requirements_from_config(db_session, config)

    assert first.created == ["REQ-010"]
    assert second.created == []
    assert second.skipped == ["REQ-010"]
    count = db_session.query(Requirement).filter(Requirement.req_number == "REQ-010").count()
    assert count == 1


# ============ API ============


def _api_create(client, **overrides):
    payload = {
        "title": "Chamber pressure",
        "statement": "The engine shall sustain a chamber pressure of 20 bar ± 1 bar.",
        "rationale": "Sized from thrust target.",
        "category": "performance",
        "verification_method": "test",
    }
    payload.update(overrides)
    resp = client.post("/api/requirements", json=payload)
    assert resp.status_code == 201, resp.text
    return resp.json()


def test_api_create_and_get(client):
    req = _api_create(client)
    assert req["req_number"] == "REQ-0001"
    assert req["lifecycle_state"] == "draft"
    assert req["revision"] == 1
    assert req["level"] == 0

    got = client.get(f"/api/requirements/{req['id']}").json()
    assert got["statement"].startswith("The engine shall")


def test_api_child_inherits_level(client):
    root = _api_create(client)
    child = _api_create(client, title="Injector dP", parent_id=root["id"])
    assert child["level"] == 1
    assert child["parent_id"] == root["id"]

    listed = client.get("/api/requirements", params={"parent_id": root["id"]}).json()
    assert listed["total"] == 1
    root_detail = client.get(f"/api/requirements/{root['id']}").json()
    assert root_detail["children_count"] == 1


def test_api_update_then_baseline_locks(client):
    req = _api_create(client)
    r = client.patch(f"/api/requirements/{req['id']}", json={"verification_method": "test"})
    assert r.status_code == 200
    assert r.json()["verification_method"] == "test"

    r = client.post(f"/api/requirements/{req['id']}/baseline")
    assert r.status_code == 200
    assert r.json()["lifecycle_state"] == "baselined"

    # Now immutable
    r = client.patch(f"/api/requirements/{req['id']}", json={"title": "nope"})
    assert r.status_code == 409
    assert "immutable" in r.json()["detail"]

    # And undeletable
    assert client.delete(f"/api/requirements/{req['id']}").status_code == 409


def test_api_baseline_blockers_409(client):
    req = _api_create(client, rationale=None, tbd=True)
    r = client.post(f"/api/requirements/{req['id']}/baseline")
    assert r.status_code == 409
    assert "rationale" in r.json()["detail"]
    assert "TBD" in r.json()["detail"]


def test_api_revise_chain_and_supersede(client):
    rev1 = _api_create(client)
    client.post(f"/api/requirements/{rev1['id']}/baseline")

    r = client.post(f"/api/requirements/{rev1['id']}/revise")
    assert r.status_code == 201
    rev2 = r.json()
    assert rev2["revision"] == 2
    assert rev2["req_number"] == rev1["req_number"]
    assert rev2["lifecycle_state"] == "draft"
    assert rev2["supersedes_id"] == rev1["id"]

    # Default list hides nothing yet (rev1 still baselined until rev2 baselines)
    client.post(f"/api/requirements/{rev2['id']}/baseline")
    listed = client.get("/api/requirements").json()
    numbers = [(i["req_number"], i["revision"]) for i in listed["items"]]
    assert (rev1["req_number"], 2) in numbers
    assert (rev1["req_number"], 1) not in numbers  # superseded hidden by default

    revs = client.get(f"/api/requirements/{rev2['id']}/revisions").json()
    assert [r["revision"] for r in revs] == [1, 2]
    assert revs[0]["lifecycle_state"] == "superseded"


def test_api_cancel(client):
    req = _api_create(client)
    r = client.post(f"/api/requirements/{req['id']}/cancel")
    assert r.status_code == 200
    assert r.json()["lifecycle_state"] == "cancelled"
    assert client.post(f"/api/requirements/{req['id']}/cancel").status_code == 409


def test_api_invalid_verification_method(client):
    resp = client.post(
        "/api/requirements",
        json={"title": "Bad", "statement": "The thing shall work.", "verification_method": "vibes"},
    )
    assert resp.status_code == 400


def test_api_allocation_by_req_number(client):
    req = _api_create(client)
    part = client.post("/api/parts", json={"name": "Injector", "tier": 1}).json()

    r = client.post(
        f"/api/requirements/parts/{part['id']}", json={"requirement_id": req["req_number"]}
    )
    assert r.status_code == 201, r.text
    alloc = r.json()
    assert alloc["requirement_ref_id"] == req["id"]
    assert alloc["requirement_title"] == "Chamber pressure"

    # Cross-check allocation count and verify flow via /allocations
    detail = client.get(f"/api/requirements/{req['id']}").json()
    assert detail["allocation_count"] == 1

    r = client.post(f"/api/requirements/allocations/{alloc['id']}/verify", json={})
    assert r.status_code == 200
    assert r.json()["status"] == "verified"

    assert client.delete(f"/api/requirements/allocations/{alloc['id']}").status_code == 204


def test_api_allocation_unknown_number_400(client):
    part = client.post("/api/parts", json={"name": "Orphan", "tier": 3}).json()
    r = client.post(f"/api/requirements/parts/{part['id']}", json={"requirement_id": "REQ-9999"})
    assert r.status_code == 400


# ============ Web pages ============


def test_web_pages_render(client, test_user):
    client.cookies.set("opal_user_id", str(test_user.id))
    req = _api_create(client)
    client.post(f"/api/requirements/{req['id']}/baseline")

    page = client.get("/requirements")
    assert page.status_code == 200
    assert "REQUIREMENTS" in page.text
    assert req["req_number"] in page.text  # tree renders rows server-side

    list_page = client.get("/requirements/list")
    assert list_page.status_code == 200
    assert "REQUIREMENTS" in list_page.text

    rows = client.get("/requirements/table")
    assert rows.status_code == 200
    assert req["req_number"] in rows.text
    assert "BASELINED" in rows.text

    detail = client.get(f"/requirements/{req['id']}")
    assert detail.status_code == 200
    assert "SHALL STATEMENT" in detail.text
    assert "REVISE" in detail.text
    assert "REVISION HISTORY" in detail.text

    new_page = client.get("/requirements/new")
    assert new_page.status_code == 200
    assert "CREATE DRAFT" in new_page.text


def test_tree_page_nests_children_and_renders_lint(client, test_user):
    client.cookies.set("opal_user_id", str(test_user.id))
    parent = _api_create(client, title="Mission")
    child = _api_create(
        client,
        title="Vague child",
        statement="The engine shall vent as appropriate.",
        parent_id=parent["id"],
    )

    page = client.get("/requirements")
    assert page.status_code == 200
    # Parent row precedes the child row, and the child sits inside the
    # parent's children container.
    assert page.text.index(parent["req_number"]) < page.text.index(child["req_number"])
    assert f'id="children-{parent["id"]}"' in page.text
    # The draft child's banned term renders with a lint underline span.
    assert 'class="lint-block"' in page.text
    assert "as appropriate</span>" in page.text
    # Ghost row offers flow-down from the parent.
    assert f"flow down from {parent['req_number']}" in page.text


# ============ MCP tools ============


def _mcp(handler, db, args):
    import asyncio
    import json as _json

    result = asyncio.run(handler(db, args))
    return _json.loads(result[0].text)


def test_mcp_create_list_get(db_session):
    from opal.mcp import server as mcp

    created = _mcp(
        mcp._create_requirement,
        db_session,
        {
            "title": "Thrust",
            "statement": "The engine shall produce 2.5 kN ± 0.1 kN of thrust.",
            "rationale": "Mission delta-v budget.",
            "category": "performance",
            "verification_method": "test",
        },
    )
    assert created["success"]
    req = created["requirement"]
    assert req["req_number"].startswith("REQ-")
    assert req["lifecycle_state"] == "draft"

    child = _mcp(
        mcp._create_requirement,
        db_session,
        {
            "title": "Injector dP",
            "statement": "The injector shall drop 20%.",
            "parent_id": req["id"],
        },
    )
    assert child["requirement"]["level"] == 1

    listed = _mcp(mcp._list_requirements, db_session, {"query": "thrust"})
    assert listed["count"] == 1

    detail = _mcp(mcp._get_requirement, db_session, {"req_number": req["req_number"]})
    assert len(detail["children"]) == 1
    assert detail["revisions"][0]["revision"] == 1


def test_mcp_baseline_requires_human(db_session, test_user):
    from opal.mcp import server as mcp

    created = _mcp(
        mcp._create_requirement,
        db_session,
        {
            "title": "Mass",
            "statement": "The stage shall mass under 40 kg.",
            "rationale": "Lift.",
            "verification_method": "analysis",
        },
    )
    rid = created["requirement"]["id"]

    # No user id → refused with guidance
    refused = _mcp(mcp._baseline_requirement, db_session, {"requirement_id": rid})
    assert "human user" in refused["error"]

    # Unknown user id → refused
    refused = _mcp(mcp._baseline_requirement, db_session, {"requirement_id": rid, "user_id": 99999})
    assert "error" in refused

    # Real human user → baselined
    ok = _mcp(
        mcp._baseline_requirement,
        db_session,
        {"requirement_id": rid, "user_id": test_user.id},
    )
    assert ok["success"]
    assert ok["requirement"]["lifecycle_state"] == "baselined"

    # Now immutable via MCP update
    blocked = _mcp(mcp._update_requirement, db_session, {"requirement_id": rid, "title": "nope"})
    assert "immutable" in blocked["error"]


def test_mcp_baseline_blockers_reported(db_session, test_user):
    from opal.mcp import server as mcp

    created = _mcp(
        mcp._create_requirement,
        db_session,
        {"title": "Vague", "statement": "The thing shall work.", "tbd": True},
    )
    refused = _mcp(
        mcp._baseline_requirement,
        db_session,
        {"requirement_id": created["requirement"]["id"], "user_id": test_user.id},
    )
    assert "rationale" in refused["error"]
    assert "TBD" in refused["error"]


def test_mcp_revise_and_cancel(db_session, test_user):
    from opal.mcp import server as mcp

    created = _mcp(
        mcp._create_requirement,
        db_session,
        {
            "title": "Burn time",
            "statement": "The engine shall burn 8 s ± 1 s.",
            "rationale": "Combustion stability data needs full duration.",
            "verification_method": "test",
        },
    )
    rid = created["requirement"]["id"]
    _mcp(mcp._baseline_requirement, db_session, {"requirement_id": rid, "user_id": test_user.id})

    revised = _mcp(mcp._revise_requirement, db_session, {"requirement_id": rid})
    assert revised["success"]
    assert revised["requirement"]["revision"] == 2
    assert revised["requirement"]["lifecycle_state"] == "draft"

    cancelled = _mcp(
        mcp._cancel_requirement, db_session, {"requirement_id": revised["requirement"]["id"]}
    )
    assert cancelled["requirement"]["lifecycle_state"] == "cancelled"


def test_mcp_assign_links_first_class_row(db_session, test_user):
    from opal.db.models import Part
    from opal.mcp import server as mcp

    part = Part(name="Chamber", tier=1)
    db_session.add(part)
    db_session.flush()

    created = _mcp(
        mcp._create_requirement,
        db_session,
        {"title": "Proof", "statement": "The chamber shall survive 1.5x MEOP.", "rationale": "x"},
    )
    req = created["requirement"]

    assigned = _mcp(
        mcp._assign_requirement,
        db_session,
        {"part_id": part.id, "requirement_id": req["req_number"]},
    )
    assert "error" not in assigned, assigned

    from opal.db.models import PartRequirement

    link = db_session.query(PartRequirement).filter(PartRequirement.part_id == part.id).one()
    assert link.requirement_ref_id == req["id"]
