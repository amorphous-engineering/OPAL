"""Requirement linter: SP-6105 App. C automatable subset + MCP lint/flowdown tools."""

import json
from datetime import UTC, datetime, timedelta

import pytest

from opal.se.lint import lint_requirement, lint_statement

GOOD = "The engine shall sustain a chamber pressure of 20 bar ± 1 bar."


def _names(findings) -> set[str]:
    return {f.name for f in findings}


def _by_name(findings, name):
    return [f for f in findings if f.name == name]


# ============ Statement rules ============


def test_clean_statement_has_no_text_findings():
    assert lint_statement(GOOD) == []


def test_shall_form_missing_and_multiple():
    none = _by_name(lint_statement("The engine sustains 20 bar."), "shall_form")
    assert len(none) == 1 and none[0].severity == "block_baseline"

    multi = _by_name(lint_statement("The engine shall start and shall stop."), "shall_form")
    assert len(multi) == 1
    assert "2" in multi[0].message


def test_active_subject_warns_on_indefinite_pronoun_and_bare_shall():
    assert "active_subject" in _names(lint_statement("It shall be robust enough."))
    assert "active_subject" in _names(lint_statement("shall survive launch loads."))
    assert "active_subject" not in _names(lint_statement(GOOD))


def test_banned_terms_block_and_longest_match_wins():
    findings = _by_name(
        lint_statement("The GSE shall vent as appropriate."), "banned_ambiguity_terms"
    )
    # "as appropriate" matched once; "appropriate" not double-reported inside it
    assert len(findings) == 1
    assert "as appropriate" in findings[0].message
    assert findings[0].severity == "block_baseline"


def test_banned_terms_support_and_robust_are_warn_only():
    findings = _by_name(
        lint_statement("The frame shall support the tank with robust margins."),
        "banned_ambiguity_terms",
    )
    assert {f.severity for f in findings} == {"warn"}


def test_single_thought_semicolon_and_embedded_rationale():
    names = _names(lint_statement("The tank shall hold LOX; the lines shall drain."))
    assert "single_thought" in names

    findings = _by_name(
        lint_statement("The valve shall close in order to stop flow."), "single_thought"
    )
    assert len(findings) == 1


def test_quantitative_bounds():
    bare = _by_name(
        lint_statement("The engine shall burn for 8 seconds."), "quantitative_has_bounds"
    )
    assert len(bare) == 1 and bare[0].severity == "block_baseline"

    for ok in (
        GOOD,
        "The stage shall mass under 40 kg.",
        "The valve shall close within 50 ms.",
        "The line shall hold at least 60 bar.",
    ):
        assert "quantitative_has_bounds" not in _names(lint_statement(ok)), ok

    # Designator references are not quantities
    assert "quantitative_has_bounds" not in _names(
        lint_statement("The injector shall satisfy the interface in ICD-0007.")
    )


def test_positive_statement_warns_on_shall_not():
    findings = _by_name(lint_statement("The vent shall not open in flight."), "positive_statement")
    assert len(findings) == 1 and findings[0].severity == "warn"


def test_implementation_and_operations_language_warn():
    assert "no_implementation_language" in _names(
        lint_statement("The controller shall close the valve via a solenoid.")
    )
    assert "no_operations_language" in _names(
        lint_statement("The operator shall verify tank pressure before fill.")
    )


# ============ Spans ============


def test_spans_point_at_the_offending_text():
    stmt = "The GSE shall vent as appropriate."
    (banned,) = _by_name(lint_statement(stmt), "banned_ambiguity_terms")
    assert stmt[slice(*banned.span)] == "as appropriate"

    stmt = "The engine shall burn for 8 seconds."
    (bare,) = _by_name(lint_statement(stmt), "quantitative_has_bounds")
    assert stmt[slice(*bare.span)] == "8"

    stmt = "The vent shall not open in flight."
    (neg,) = _by_name(lint_statement(stmt), "positive_statement")
    assert stmt[slice(*neg.span)] == "shall not"


def test_banned_term_used_twice_yields_two_spanned_findings():
    stmt = "The link shall be rapid and rapid again."
    findings = _by_name(lint_statement(stmt), "banned_ambiguity_terms")
    assert len(findings) == 2
    assert [stmt[slice(*f.span)] for f in findings] == ["rapid", "rapid"]


def test_field_rules_carry_no_span():
    findings = lint_requirement(GOOD)
    assert all(f.span is None for f in findings)
    assert all("span" not in f.to_dict() for f in findings)


# ============ Requirement-level rules ============


def test_rationale_missing_and_restated():
    missing = _by_name(lint_requirement(GOOD, verification_method="test"), "rationale_present")
    assert len(missing) == 1
    assert missing[0].message == "rationale is required to baseline"

    restated = _by_name(
        lint_requirement(GOOD, rationale=GOOD.upper(), verification_method="test"),
        "rationale_present",
    )
    assert len(restated) == 1
    assert "restates" in restated[0].message


def test_tbd_tbr_discipline():
    findings = lint_requirement(GOOD, rationale="r", verification_method="test", tbd=True)
    assert any("TBD" in f.message and f.severity == "block_baseline" for f in findings)

    findings = lint_requirement(GOOD, rationale="r", verification_method="test", tbr=True)
    messages = [f.message for f in _by_name(findings, "tbd_tbr_discipline")]
    assert "TBR requires an owner before baselining" in messages
    assert "TBR requires a closure due date before baselining" in messages

    overdue = lint_requirement(
        GOOD,
        rationale="r",
        verification_method="test",
        tbr=True,
        tbr_owner_id=1,
        tbr_due=datetime.now(UTC) - timedelta(days=3),
    )
    flags = _by_name(overdue, "tbd_tbr_discipline")
    assert len(flags) == 1 and flags[0].severity == "warn" and "overdue" in flags[0].message


def test_verification_method_and_req_number():
    findings = lint_requirement(GOOD, rationale="r")
    assert "verification_method_set" in _names(findings)

    findings = lint_requirement(GOOD, rationale="r", verification_method="test", req_number="")
    assert "unique_reference" in _names(findings)

    clean = lint_requirement(GOOD, rationale="r", verification_method="test", req_number="REQ-0001")
    assert clean == []


# ============ Server-side underline markup ============


def test_statement_lint_html_wraps_spans_and_escapes():
    from opal.web.lint_markup import statement_lint_html

    stmt = "The GSE <vent> shall open as appropriate."
    html = str(statement_lint_html(stmt, lint_statement(stmt)))
    assert "&lt;vent&gt;" in html  # escaped outside spans
    assert '<span class="lint-block"' in html
    assert "as appropriate</span>" in html
    assert "LINT-003" in html  # rule id in the tooltip


def test_statement_lint_html_overlap_block_wins():
    from opal.se.lint import LintFinding
    from opal.web.lint_markup import statement_lint_html

    stmt = "abcdef"
    warn = LintFinding(rule="LINT-X", name="w", severity="warn", message="warn", span=(0, 4))
    block = LintFinding(
        rule="LINT-Y", name="b", severity="block_baseline", message="block", span=(2, 6)
    )
    html = str(statement_lint_html(stmt, [warn, block]))
    # Three runs: warn-only, overlap (block wins), block-only.
    assert html.count("<span") == 3
    assert html.index('class="lint-warn"') < html.index('class="lint-block"')


# ============ Lint endpoint ============


def test_lint_endpoint_round_trip(client):
    stmt = "The GSE shall vent as appropriate."
    resp = client.post(
        "/api/requirements/lint",
        json={"statement": stmt, "rationale": "safety"},
    )
    assert resp.status_code == 200
    body = resp.json()
    assert body["would_block_baseline"]
    by_name = {f["name"]: f for f in body["findings"]}
    start = stmt.index("as appropriate")
    assert by_name["banned_ambiguity_terms"]["span"] == [start, start + len("as appropriate")]
    assert "span" not in by_name["verification_method_set"]

    clean = client.post(
        "/api/requirements/lint",
        json={"statement": GOOD, "rationale": "r", "verification_method": "test"},
    ).json()
    assert clean == {"findings": [], "would_block_baseline": False}


# ============ Baseline integration ============


def test_baseline_blocks_on_lint(db_session, test_user):
    from opal.core.designators import generate_requirement_number
    from opal.db.models import Requirement
    from opal.se.lifecycle import LifecycleError, baseline

    req = Requirement(
        req_number=generate_requirement_number(db_session),
        title="Vague",
        statement="The system shall maximize performance.",  # no bound + banned term
        rationale="Because we want it fast.",
    )
    db_session.add(req)
    db_session.flush()

    with pytest.raises(LifecycleError) as err:
        baseline(db_session, req, test_user.id)
    assert "maximize" in str(err.value)
    assert "verification method" in str(err.value)


# ============ MCP tools ============


async def _run(handler, db, args):
    result = await handler(db, args)
    return json.loads(result[0].text)


async def test_mcp_lint_tool_statement_and_row(db_session):
    from opal.mcp import server as mcp

    adhoc = await _run(
        mcp._lint_requirement,
        db_session,
        {"statement": "It shall be sufficient.", "rationale": "r"},
    )
    assert adhoc["subject"] == "(unsaved statement)"
    assert adhoc["would_block_baseline"]
    assert {f["name"] for f in adhoc["findings"]} >= {
        "active_subject",
        "banned_ambiguity_terms",
        "verification_method_set",
    }

    created = await _run(
        mcp._create_requirement,
        db_session,
        {"title": "T", "statement": "The pump shall deliver 3 kg/s ± 5%.", "rationale": "r"},
    )
    assert any(f["name"] == "verification_method_set" for f in created["lint"])

    stored = await _run(
        mcp._lint_requirement,
        db_session,
        {"req_number": created["requirement"]["req_number"]},
    )
    assert stored["subject"].startswith("REQ-")

    missing = await _run(mcp._lint_requirement, db_session, {})
    assert "error" in missing


async def test_mcp_flowdown_tree(db_session):
    from opal.mcp import server as mcp

    root = await _run(
        mcp._create_requirement,
        db_session,
        {"title": "Mission", "statement": "The vehicle shall reach 10 km ± 1 km.", "level": 0},
    )
    child = await _run(
        mcp._create_requirement,
        db_session,
        {
            "title": "Thrust",
            "statement": "The engine shall produce 2.5 kN ± 0.1 kN.",
            "parent_id": root["requirement"]["id"],
        },
    )
    await _run(
        mcp._create_requirement,
        db_session,
        {
            "title": "Injector",
            "statement": "The injector shall drop at least 20% of chamber pressure.",
            "parent_id": child["requirement"]["id"],
        },
    )

    full = await _run(mcp._flowdown_tree, db_session, {})
    assert full["count"] == 3
    assert len(full["tree"]) == 1
    assert full["tree"][0]["children"][0]["children"][0]["title"] == "Injector"

    rooted = await _run(
        mcp._flowdown_tree, db_session, {"requirement_id": child["requirement"]["id"]}
    )
    assert rooted["tree"][0]["title"] == "Thrust"
    assert len(rooted["tree"][0]["children"]) == 1

    missing = await _run(mcp._flowdown_tree, db_session, {"req_number": "REQ-9999"})
    assert "error" in missing
