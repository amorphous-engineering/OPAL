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
