"""Unit tests for the risk domain package (opal.risks) and Risk model properties.

Covers the scenario linter, the generated statement, acceptance readiness,
the disposition state machine, acceptance invalidation, and review stamping.
"""

import itertools

import pytest
from sqlalchemy.orm import Session

from opal.core.audit import get_model_dict
from opal.db.models import AuditLog, Issue, Part, Risk, User
from opal.db.models.issue import IssueStatus
from opal.db.models.risk import RiskDisposition, RiskIssueLink, RiskIssueRole, severity_for
from opal.risks.dispositions import (
    OPEN_DISPOSITIONS,
    RiskDispositionError,
    accept,
    apply_acceptance_invalidation,
    open_links,
    set_disposition,
    stamp_review,
)
from opal.risks.lint import accept_lint_blockers, lint_scenario
from opal.risks.readiness import acceptance_blockers, readiness

_counter = itertools.count(1)


def make_risk(db: Session, **kwargs) -> Risk:
    """Persist a Risk with unique risk_number; kwargs override defaults."""
    n = next(_counter)
    defaults = {"risk_number": f"RISK-9{n:04d}", "title": f"Test risk {n}"}
    defaults.update(kwargs)
    risk = Risk(**defaults)
    db.add(risk)
    db.flush()
    return risk


def make_issue(db: Session, status: IssueStatus = IssueStatus.OPEN, **kwargs) -> Issue:
    n = next(_counter)
    defaults = {"issue_number": f"IT-9{n:04d}", "title": f"Test issue {n}", "status": status}
    defaults.update(kwargs)
    issue = Issue(**defaults)
    db.add(issue)
    db.flush()
    return issue


def make_user(db: Session) -> User:
    n = next(_counter)
    user = User(name=f"Risk Owner {n}", username=f"risk.owner.{n}")
    db.add(user)
    db.flush()
    return user


def link_issue(db: Session, risk: Risk, issue: Issue, role: str) -> RiskIssueLink:
    link = RiskIssueLink(risk_id=risk.id, issue_id=issue.id, role=role)
    db.add(link)
    db.flush()
    db.refresh(risk)
    return link


SCENARIO = {
    "condition": "Valve seat 3 shows erosion after every hot-fire test",
    "departure": "the valve fails to seal during a flight burn",
    "asset_text": "propulsion schedule",
    "consequence": "loss of vehicle",
}


def make_ready_risk(db: Session, owner: User, **overrides) -> Risk:
    """A risk passing every acceptance readiness check."""
    fields = {
        **SCENARIO,
        "owner_id": owner.id,
        "acceptance_rationale": "Residual exposure within program tolerance",
        **overrides,
    }
    return make_risk(db, **fields)


# ============ Lint ============


def test_lint_rl01_speculation_in_condition():
    text = "Valve seat erosion might recur"
    findings = lint_scenario(condition=text)
    assert len(findings["condition"]) == 1
    finding = findings["condition"][0]
    assert finding.rule == "RL-01"
    assert finding.severity == "block_accept"
    start = text.index("might")
    assert finding.span == (start, start + len("might"))
    assert findings["departure"] == []
    assert findings["consequence"] == []


def test_lint_rl02_response_language_in_departure():
    text = "seal fails unless we add a backup"
    findings = lint_scenario(departure=text, consequence="loss of vehicle")
    assert len(findings["departure"]) == 1
    finding = findings["departure"][0]
    assert finding.rule == "RL-02"
    assert finding.severity == "warn"
    start = text.index("unless")
    assert finding.span == (start, start + len("unless"))


def test_lint_rl03_unmeasurable_consequence():
    findings = lint_scenario(consequence="the team becomes sad")
    rules = [f.rule for f in findings["consequence"]]
    assert rules == ["RL-03"]
    assert findings["consequence"][0].severity == "warn"


@pytest.mark.parametrize(
    "consequence",
    ["loss of vehicle", "schedule slips by 3 weeks"],
)
def test_lint_rl03_not_fired_when_measurable(consequence: str):
    findings = lint_scenario(consequence=consequence)
    assert all(f.rule != "RL-03" for f in findings["consequence"])


def test_lint_empty_fields_produce_no_findings():
    for kwargs in ({}, {"condition": "", "departure": "   ", "consequence": None}):
        findings = lint_scenario(**kwargs)
        assert all(v == [] for v in findings.values())


def test_accept_lint_blockers_dedups():
    risk = Risk(
        risk_number="RISK-X",
        title="dup",
        condition="it might fail, or might not",
        departure=None,
        consequence=None,
    )
    findings = lint_scenario(condition=risk.condition)
    assert len(findings["condition"]) == 2  # per-occurrence for span rendering
    blockers = accept_lint_blockers(risk)
    assert len(blockers) == 1
    assert "might" in blockers[0]


# ============ Statement & scenario_complete ============


def test_statement_none_while_incomplete():
    risk = Risk(risk_number="RISK-X", title="t", condition="a fact", departure="an event")
    assert risk.scenario_complete is False
    assert risk.statement is None


def test_statement_complete_with_asset_text():
    risk = Risk(
        risk_number="RISK-X",
        title="t",
        condition="Valve seat 3 shows erosion.",
        departure="the valve fails to seal.",
        asset_text="propulsion schedule",
        consequence="loss of vehicle.",
    )
    assert risk.scenario_complete is True
    assert risk.statement == (
        "Given that Valve seat 3 shows erosion, there is a possibility of "
        "the valve fails to seal adversely impacting propulsion schedule, "
        "thereby leading to loss of vehicle."
    )


def test_asset_display_from_part(db_session: Session):
    part = Part(name="Main valve", internal_pn="PO/1-001")
    db_session.add(part)
    db_session.flush()
    risk = make_risk(db_session, **{**SCENARIO, "asset_text": None, "asset_part_id": part.id})
    assert risk.asset_display == "Main valve (PO/1-001)"
    assert risk.statement is not None
    assert "adversely impacting Main valve (PO/1-001)" in risk.statement

    part.internal_pn = None
    db_session.flush()
    assert risk.asset_display == "Main valve"


def test_scenario_incomplete_when_both_asset_forms_set(db_session: Session):
    part = Part(name="Main valve")
    db_session.add(part)
    db_session.flush()
    risk = make_risk(db_session, **{**SCENARIO, "asset_part_id": part.id})
    assert risk.asset_text  # both forms set
    assert risk.scenario_complete is False
    assert risk.statement is None


# ============ Readiness ============


def test_readiness_ready_when_all_checks_pass(db_session: Session):
    owner = make_user(db_session)
    risk = make_ready_risk(db_session, owner)
    result = readiness(db_session, risk)
    assert result["ready"] is True
    assert all(c["passed"] for c in result["checks"])
    assert {c["key"] for c in result["checks"]} == {
        "scenario_complete",
        "owner_assigned",
        "scored",
        "rationale_recorded",
        "lint_clean",
    }
    assert acceptance_blockers(db_session, risk) == []


def check_by_key(result: dict, key: str) -> dict:
    return next(c for c in result["checks"] if c["key"] == key)


def test_readiness_scenario_check_flips(db_session: Session):
    owner = make_user(db_session)
    risk = make_ready_risk(db_session, owner, condition=None)
    result = readiness(db_session, risk)
    check = check_by_key(result, "scenario_complete")
    assert check["passed"] is False
    assert "condition" in check["detail"]
    assert result["ready"] is False


def test_readiness_owner_check_flips(db_session: Session):
    owner = make_user(db_session)
    risk = make_ready_risk(db_session, owner, owner_id=None)
    result = readiness(db_session, risk)
    assert check_by_key(result, "owner_assigned")["passed"] is False
    assert result["ready"] is False


def test_readiness_scored_check_flips(db_session: Session):
    owner = make_user(db_session)
    risk = make_ready_risk(db_session, owner)
    risk.probability = 0  # out of 1-5 band
    result = readiness(db_session, risk)
    assert check_by_key(result, "scored")["passed"] is False
    assert result["ready"] is False


def test_readiness_rationale_check_flips(db_session: Session):
    owner = make_user(db_session)
    risk = make_ready_risk(db_session, owner, acceptance_rationale="   ")
    result = readiness(db_session, risk)
    assert check_by_key(result, "rationale_recorded")["passed"] is False
    assert result["ready"] is False


def test_readiness_lint_check_flips(db_session: Session):
    owner = make_user(db_session)
    risk = make_ready_risk(db_session, owner, condition="the valve might be eroded")
    result = readiness(db_session, risk)
    check = check_by_key(result, "lint_clean")
    assert check["passed"] is False
    assert "might" in check["detail"]
    assert result["ready"] is False


@pytest.mark.parametrize("disposition", ["accepted", "realized"])
def test_readiness_not_ready_from_terminal_dispositions(db_session: Session, disposition: str):
    owner = make_user(db_session)
    risk = make_ready_risk(db_session, owner, disposition=disposition)
    result = readiness(db_session, risk)
    assert all(c["passed"] for c in result["checks"])  # checks pass...
    assert result["ready"] is False  # ...but disposition forbids acceptance
    assert any(disposition in b for b in acceptance_blockers(db_session, risk))


# ============ Dispositions ============


def test_open_dispositions_excludes_closed_and_realized():
    assert "closed" not in OPEN_DISPOSITIONS
    assert "realized" not in OPEN_DISPOSITIONS
    assert "open" in OPEN_DISPOSITIONS and "accepted" in OPEN_DISPOSITIONS


def test_mitigate_refused_without_link_and_residual(db_session: Session):
    user = make_user(db_session)
    risk = make_risk(db_session)
    with pytest.raises(RiskDispositionError) as exc:
        set_disposition(db_session, risk, "mitigate", user.id)
    message = str(exc.value)
    assert "mitigation" in message  # names the link requirement
    assert "residual" in message  # names the residual requirement
    assert risk.disposition == "open"


def test_mitigate_refused_when_only_link_is_closed(db_session: Session):
    user = make_user(db_session)
    risk = make_risk(db_session, residual_probability=1, residual_impact=2)
    issue = make_issue(db_session, status=IssueStatus.CLOSED)
    link_issue(db_session, risk, issue, RiskIssueRole.MITIGATION.value)
    assert open_links(risk, RiskIssueRole.MITIGATION.value) == []
    with pytest.raises(RiskDispositionError, match="mitigation"):
        set_disposition(db_session, risk, "mitigate", user.id)


def test_mitigate_allowed_with_open_link_and_residual(db_session: Session):
    user = make_user(db_session)
    risk = make_risk(db_session, residual_probability=1, residual_impact=2)
    issue = make_issue(db_session)
    link_issue(db_session, risk, issue, RiskIssueRole.MITIGATION.value)
    set_disposition(db_session, risk, "mitigate", user.id)
    assert risk.disposition == "mitigate"
    assert risk.residual_score == 2
    assert risk.residual_severity == "low"


def test_watch_refused_without_observable_and_threshold(db_session: Session):
    user = make_user(db_session)
    risk = make_risk(db_session)
    with pytest.raises(RiskDispositionError) as exc:
        set_disposition(db_session, risk, "watch", user.id)
    message = str(exc.value)
    assert "observable" in message
    assert "threshold" in message

    risk.watch_observable = "chamber pressure decay rate"
    risk.watch_threshold = "> 2 psi/s"
    set_disposition(db_session, risk, "watch", user.id)
    assert risk.disposition == "watch"


def test_research_refused_without_link_or_narrative(db_session: Session):
    user = make_user(db_session)
    risk = make_risk(db_session, description=None)
    with pytest.raises(RiskDispositionError, match="research"):
        set_disposition(db_session, risk, "research", user.id)

    risk.description = "Need coupon testing to bound erosion rate."
    set_disposition(db_session, risk, "research", user.id)
    assert risk.disposition == "research"


def test_research_allowed_with_research_link(db_session: Session):
    user = make_user(db_session)
    risk = make_risk(db_session, description=None)
    issue = make_issue(db_session)
    link_issue(db_session, risk, issue, RiskIssueRole.RESEARCH.value)
    set_disposition(db_session, risk, "research", user.id)
    assert risk.disposition == "research"


def test_closed_requires_note(db_session: Session):
    user = make_user(db_session)
    risk = make_risk(db_session)
    with pytest.raises(RiskDispositionError, match="note"):
        set_disposition(db_session, risk, "closed", user.id)
    set_disposition(db_session, risk, "closed", user.id, note="Superseded by RISK-00007")
    assert risk.disposition == "closed"


def test_realized_requires_issue_and_is_terminal(db_session: Session):
    user = make_user(db_session)
    risk = make_risk(db_session)
    with pytest.raises(RiskDispositionError, match="issue"):
        set_disposition(db_session, risk, "realized", user.id)

    issue = make_issue(db_session)
    risk.realized_issue_id = issue.id
    set_disposition(db_session, risk, "realized", user.id)
    assert risk.disposition == "realized"

    for target in ("open", "mitigate", "watch", "research", "accepted", "closed"):
        with pytest.raises(RiskDispositionError, match="terminal"):
            set_disposition(db_session, risk, target, user.id, note="trying anyway")
    assert risk.disposition == "realized"


def test_accepted_unreachable_via_set_disposition(db_session: Session):
    user = make_user(db_session)
    risk = make_risk(db_session)
    with pytest.raises(RiskDispositionError, match="accept action"):
        set_disposition(db_session, risk, "accepted", user.id)


def test_accept_refuses_without_user(db_session: Session):
    owner = make_user(db_session)
    risk = make_ready_risk(db_session, owner)
    with pytest.raises(RiskDispositionError, match="requires a user"):
        accept(db_session, risk, None)
    assert risk.disposition == "open"


def test_accept_refuses_when_not_ready_and_names_blockers(db_session: Session):
    user = make_user(db_session)
    risk = make_risk(db_session)  # no scenario, no owner, no rationale
    with pytest.raises(RiskDispositionError) as exc:
        accept(db_session, risk, user.id)
    message = str(exc.value)
    assert "missing:" in message  # scenario blocker
    assert "owner" in message  # owner blocker
    assert risk.disposition == "open"
    assert risk.accepted_by_id is None


def test_accept_succeeds_and_stamps_signature(db_session: Session):
    owner = make_user(db_session)
    signer = make_user(db_session)
    risk = make_ready_risk(db_session, owner, acceptance_rationale=None)
    accept(db_session, risk, signer.id, rationale="Within program tolerance")
    assert risk.disposition == RiskDisposition.ACCEPTED.value
    assert risk.accepted_by_id == signer.id
    assert risk.accepted_at is not None
    assert risk.acceptance_rationale == "Within program tolerance"


def test_unaccept_requires_note(db_session: Session):
    owner = make_user(db_session)
    risk = make_ready_risk(db_session, owner)
    accept(db_session, risk, owner.id)

    with pytest.raises(RiskDispositionError, match="note"):
        set_disposition(db_session, risk, "open", owner.id)
    set_disposition(db_session, risk, "open", owner.id, note="New test data changes the score")
    assert risk.disposition == "open"


def test_close_accepted_risk_without_note_refused(db_session: Session):
    owner = make_user(db_session)
    risk = make_ready_risk(db_session, owner)
    accept(db_session, risk, owner.id)
    with pytest.raises(RiskDispositionError, match="note"):
        set_disposition(db_session, risk, "closed", owner.id)
    assert risk.disposition == "accepted"


# ============ Acceptance invalidation ============


def latest_risk_audit(db: Session, risk: Risk) -> AuditLog:
    db.flush()
    return (
        db.query(AuditLog)
        .filter(AuditLog.table_name == "risk", AuditLog.record_id == risk.id)
        .order_by(AuditLog.id.desc())
        .first()
    )


def test_acceptance_invalidation_flips_to_open_preserving_signature(db_session: Session):
    owner = make_user(db_session)
    risk = make_ready_risk(db_session, owner)
    accept(db_session, risk, owner.id)
    accepted_at = risk.accepted_at

    old_values = get_model_dict(risk)
    risk.probability = 5
    assert apply_acceptance_invalidation(db_session, risk, old_values, owner.id) is True

    assert risk.disposition == "open"
    # Signature preserved as history — refused, not erased.
    assert risk.accepted_by_id == owner.id
    assert risk.accepted_at == accepted_at
    assert risk.acceptance_rationale is not None

    entry = latest_risk_audit(db_session, risk)
    assert entry is not None
    assert "scenario changed post-acceptance" in entry.new_values["disposition_note"]
    assert "probability" in entry.new_values["disposition_note"]


def test_acceptance_invalidation_noop_when_unchanged(db_session: Session):
    owner = make_user(db_session)
    risk = make_ready_risk(db_session, owner)
    accept(db_session, risk, owner.id)

    old_values = get_model_dict(risk)
    risk.title = "Renamed — not a signature field"
    assert apply_acceptance_invalidation(db_session, risk, old_values, owner.id) is False
    assert risk.disposition == "accepted"


def test_acceptance_invalidation_noop_when_not_accepted(db_session: Session):
    owner = make_user(db_session)
    risk = make_ready_risk(db_session, owner)  # still open

    old_values = get_model_dict(risk)
    risk.probability = 5
    assert apply_acceptance_invalidation(db_session, risk, old_values, owner.id) is False
    assert risk.disposition == "open"


# ============ Review stamping ============


def test_stamp_review_stamps_all_rows(db_session: Session):
    user = make_user(db_session)
    risks = [make_risk(db_session), make_risk(db_session), make_risk(db_session)]
    assert stamp_review(db_session, risks, user.id) == 3
    stamps = {r.last_reviewed_at for r in risks}
    assert len(stamps) == 1  # one ceremony, one timestamp
    assert stamps.pop() is not None
    assert all(r.last_reviewed_by_id == user.id for r in risks)


# ============ Scoring helpers ============


def test_severity_for_buckets():
    assert severity_for(1) == "low"
    assert severity_for(5) == "low"
    assert severity_for(6) == "medium"
    assert severity_for(12) == "medium"
    assert severity_for(13) == "high"
    assert severity_for(25) == "high"
