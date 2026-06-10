"""Readiness checks: structured re-grouping of the baseline gate."""

from datetime import UTC, datetime, timedelta

import pytest

from opal.core.designators import generate_requirement_number
from opal.db.models import Requirement
from opal.se.lifecycle import LifecycleError, baseline
from opal.se.readiness import readiness, ready_requirement_ids

GOOD = "The engine shall sustain a chamber pressure of 20 bar ± 1 bar."


def _make_req(db, **overrides) -> Requirement:
    values = {
        "req_number": generate_requirement_number(db),
        "title": "Chamber pressure",
        "statement": GOOD,
        "rationale": "Sized from the mission delta-v budget.",
        "verification_method": "test",
    }
    values.update(overrides)
    req = Requirement(**values)
    db.add(req)
    db.flush()
    return req


def _checks(db, req) -> dict[str, dict]:
    return {c["key"]: c for c in readiness(db, req)["checks"]}


def test_clean_draft_is_ready_with_all_checks_passing(db_session):
    req = _make_req(db_session)
    result = readiness(db_session, req)
    assert result["ready"]
    assert all(c["passed"] for c in result["checks"])
    assert {c["key"] for c in result["checks"]} == {
        "rationale_present",
        "no_tbd",
        "tbr_fields",
        "verification_method",
        "lint_clean",
        "parent_baselined",
    }


@pytest.mark.parametrize(
    ("overrides", "failing_key"),
    [
        ({"rationale": None}, "rationale_present"),
        ({"tbd": True}, "no_tbd"),
        ({"tbr": True}, "tbr_fields"),
        ({"verification_method": None}, "verification_method"),
        ({"statement": "The engine shall maximize thrust."}, "lint_clean"),
    ],
)
def test_each_hard_check_flips_independently(db_session, overrides, failing_key):
    req = _make_req(db_session, **overrides)
    checks = _checks(db_session, req)
    assert not checks[failing_key]["passed"]
    assert checks[failing_key]["detail"]
    for key, check in checks.items():
        if key != failing_key:
            assert check["passed"], key
    assert not readiness(db_session, req)["ready"]


def test_tbr_check_passes_once_owner_and_due_set(db_session, test_user):
    req = _make_req(
        db_session,
        tbr=True,
        tbr_owner_id=test_user.id,
        tbr_due=datetime.now(UTC) + timedelta(days=30),
    )
    assert _checks(db_session, req)["tbr_fields"]["passed"]
    assert readiness(db_session, req)["ready"]


def test_lint_clean_detail_counts_extra_findings(db_session):
    req = _make_req(db_session, statement="It maximizes performance as appropriate.")
    detail = _checks(db_session, req)["lint_clean"]["detail"]
    assert "more)" in detail


def test_parent_warning_never_blocks_ready(db_session):
    parent = _make_req(db_session)  # draft parent
    child = _make_req(db_session, parent_id=parent.id, level=1)
    checks = _checks(db_session, child)
    assert checks["parent_baselined"]["severity"] == "warning"
    assert not checks["parent_baselined"]["passed"]
    assert parent.req_number in checks["parent_baselined"]["detail"]
    assert readiness(db_session, child)["ready"]


def test_parent_check_passes_when_parent_baselined(db_session, test_user):
    parent = _make_req(db_session)
    baseline(db_session, parent, test_user.id)
    child = _make_req(db_session, parent_id=parent.id, level=1)
    assert _checks(db_session, child)["parent_baselined"]["passed"]


def test_ready_iff_baseline_succeeds(db_session, test_user):
    rows = [
        _make_req(db_session),
        _make_req(db_session, rationale=None),
        _make_req(db_session, tbd=True),
        _make_req(db_session, statement="The tank shall be sufficient."),
    ]
    for req in rows:
        expected_ready = readiness(db_session, req)["ready"]
        try:
            baseline(db_session, req, test_user.id)
            baselined = True
        except LifecycleError:
            baselined = False
        assert baselined == expected_ready, req.statement


def test_baselined_row_is_not_ready(db_session, test_user):
    req = _make_req(db_session)
    baseline(db_session, req, test_user.id)
    assert not readiness(db_session, req)["ready"]


def test_ready_requirement_ids_returns_only_clean_editable_rows(db_session, test_user):
    ready_req = _make_req(db_session)
    _make_req(db_session, rationale=None)  # blocked
    done = _make_req(db_session)
    baseline(db_session, done, test_user.id)  # not editable
    assert ready_requirement_ids(db_session) == [ready_req.id]


def test_readiness_endpoint(client, db_session):
    req = _make_req(db_session, verification_method=None)
    db_session.commit()
    resp = client.get(f"/api/requirements/{req.id}/readiness")
    assert resp.status_code == 200
    body = resp.json()
    assert not body["ready"]
    failing = {c["key"] for c in body["checks"] if not c["passed"]}
    assert failing == {"verification_method"}

    assert client.get("/api/requirements/99999/readiness").status_code == 404
