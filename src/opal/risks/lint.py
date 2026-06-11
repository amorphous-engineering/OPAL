"""Risk scenario linter — NASA/SP-2011-3422 §4.2.1.1 discipline.

Same engine pattern as the requirement linter (opal.se.lint): rule metadata
lives in lint_rules.yaml next to this module, check logic lives here keyed
by rule name, and findings reuse the LintFinding shape so the inline
rendering layer (opal.web.lint_markup, the JS overlay) works unchanged.

Findings never block save — `warn` is advisory everywhere, `block_accept`
findings are what opal.risks.dispositions.accept() enforces. Spans index
into the *field* the finding belongs to; lint_scenario returns findings
per field for that reason.
"""

import re
from importlib import resources
from typing import Any

import yaml

from opal.se.lint import LintFinding

#: The lintable scenario fields, in statement order.
SCENARIO_FIELDS = ("condition", "departure", "consequence")


def _load_rules() -> dict[str, dict[str, Any]]:
    raw = resources.files("opal.risks").joinpath("lint_rules.yaml").read_text(encoding="utf-8")
    return {rule["name"]: rule for rule in yaml.safe_load(raw)["rules"]}


_RULES = _load_rules()


def _finding(name: str, message: str, span: tuple[int, int] | None = None) -> LintFinding:
    rule = _RULES[name]
    return LintFinding(
        rule=rule["id"],
        name=name,
        severity=rule["severity"],
        message=message,
        span=span,
    )


def _term_pattern(term: str) -> re.Pattern[str]:
    head = r"\b" if term[0].isalnum() else ""
    tail = r"\b" if term[-1].isalnum() else ""
    return re.compile(head + re.escape(term) + tail, re.IGNORECASE)


def _term_findings(name: str, text: str, message: str) -> list[LintFinding]:
    """One finding per term occurrence, span into text; {term} interpolated."""
    findings: list[LintFinding] = []
    for term in _RULES[name].get("terms", []):
        findings.extend(
            _finding(name, message.format(term=term), span=m.span())
            for m in _term_pattern(term).finditer(text)
        )
    return findings


_NUMBER = re.compile(r"\d")


def _build_measurable_pattern() -> re.Pattern[str]:
    # Suffixes welcome: "delay" should match "delays" and "delayed".
    terms = _RULES["measurable_consequence"].get("terms", [])
    return re.compile("|".join(rf"\b{re.escape(t)}\w*" for t in terms), re.IGNORECASE)


_MEASURABLE = _build_measurable_pattern()


def lint_scenario(
    condition: str | None = None,
    departure: str | None = None,
    consequence: str | None = None,
) -> dict[str, list[LintFinding]]:
    """Findings keyed by scenario field; spans index into that field's text.

    Empty/missing fields produce no findings — completeness is the
    readiness panel's job (scenario_complete), not the linter's.
    """
    findings: dict[str, list[LintFinding]] = {field: [] for field in SCENARIO_FIELDS}

    if condition and condition.strip():
        findings["condition"] = _term_findings(
            "condition_is_fact",
            condition,
            'speculation word "{term}" — conditions are present facts; '
            "the uncertainty belongs in the departure",
        )

    response_message = (
        'response language "{term}" — scenarios presume no response; '
        "responses live in the disposition"
    )
    if departure and departure.strip():
        findings["departure"] = _term_findings("no_response_language", departure, response_message)

    if consequence and consequence.strip():
        findings["consequence"] = _term_findings(
            "no_response_language", consequence, response_message
        )
        if not _MEASURABLE.search(consequence) and not _NUMBER.search(consequence):
            findings["consequence"].append(
                _finding(
                    "measurable_consequence",
                    "consequence names nothing measurable (loss, delay, overrun, failure, "
                    "damage, injury, scrub, or a number) — impact scores this",
                )
            )

    return findings


def lint_risk_row(risk: Any) -> dict[str, list[LintFinding]]:
    """Lint an ORM Risk (or anything with the same scenario fields)."""
    return lint_scenario(
        condition=risk.condition,
        departure=risk.departure,
        consequence=risk.consequence,
    )


def accept_lint_blockers(risk: Any) -> list[str]:
    """Messages of block_accept findings — what dispositions.accept() enforces.

    Deduplicated: findings are per-occurrence (for span rendering), but a
    term used twice is still one blocker.
    """
    messages = [
        finding.message
        for field_findings in lint_risk_row(risk).values()
        for finding in field_findings
        if finding.severity == "block_accept"
    ]
    return list(dict.fromkeys(messages))
