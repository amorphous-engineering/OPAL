"""Requirement linter — SP-2016-6105 Rev 2 Appendix C, automatable subset.

Rule metadata (ids, severities, term lists) lives in lint_rules.yaml next to
this module; the check logic lives here, keyed by rule name. Findings never
block save — `warn` is advisory everywhere, `block_baseline` findings are
what opal.se.lifecycle.baseline_blockers() reports for statement-bearing
objects. The non-lintable half of Appendix C (needs-vs-wants, tolerance
defensibility) is judgment and stays out of code.
"""

import re
from dataclasses import asdict, dataclass
from datetime import UTC, datetime
from importlib import resources
from typing import Any

import yaml


@dataclass(frozen=True)
class LintFinding:
    """One lint finding. severity is 'warn' or 'block_baseline'.

    span is (start, end) character offsets into the *statement* — the only
    span-bearing field. Field-level findings (rationale, TBD/TBR, verification
    method, req number) carry no span and surface in the baseline panel only.
    """

    rule: str
    name: str
    severity: str
    message: str
    span: tuple[int, int] | None = None

    def to_dict(self) -> dict[str, Any]:
        data = asdict(self)
        if self.span is None:
            del data["span"]
        return data


def _load_rules() -> dict[str, dict[str, Any]]:
    raw = resources.files("opal.se").joinpath("lint_rules.yaml").read_text(encoding="utf-8")
    return {rule["name"]: rule for rule in yaml.safe_load(raw)["rules"]}


_RULES = _load_rules()


def _finding(
    name: str,
    message: str,
    severity: str | None = None,
    span: tuple[int, int] | None = None,
) -> LintFinding:
    rule = _RULES[name]
    return LintFinding(
        rule=rule["id"],
        name=name,
        severity=severity or rule["severity"],
        message=message,
        span=span,
    )


_SHALL = re.compile(r"\bshall\b", re.IGNORECASE)
_INDEFINITE_START = re.compile(r"^\s*(this|these|it|they|there)\b", re.IGNORECASE)
_BARE_SHALL_START = re.compile(r"^\s*shall\b", re.IGNORECASE)
_EMBEDDED_RATIONALE = re.compile(r"\bbecause\b|\bin order to\b", re.IGNORECASE)
_SHALL_NOT = re.compile(r"\bshall\s+not\b", re.IGNORECASE)
_IMPLEMENTATION = re.compile(
    r"\bby using\b|\bvia\b|\bimplemented as\b|\bby means of\b", re.IGNORECASE
)
_OPERATIONS_SUBJECT = re.compile(r"^\s*the\s+(operator|user|crew)\b", re.IGNORECASE)
#: Designator tokens (REQ-0042, ICD-0007, PO/1-001) are references, not quantities.
_DESIGNATOR = re.compile(r"\b[A-Z]{2,}[-/][\dA-Z/-]*\d\b")
_NUMBER = re.compile(r"\d+(?:\.\d+)?")
_BOUND_MARKERS = re.compile(
    r"±|\+/-|<=|>=|≤|≥|<|>"
    r"|\bwithin\b|\bno (?:more|less|greater|fewer) than\b|\bat (?:least|most)\b"
    r"|\bbetween\b|\bunder\b|\bover\b|\bup to\b|\bbelow\b|\babove\b"
    r"|\bmax(?:imum)?\b|\bmin(?:imum)?\b|\btolerance\b|\bexactly\b",
    re.IGNORECASE,
)


def _lint_banned_terms(statement: str) -> list[LintFinding]:
    """One finding per banned-term occurrence; longer phrases shadow their substrings."""
    rule = _RULES["banned_ambiguity_terms"]
    block_terms = list(rule.get("terms", []))
    warn_terms = list(rule.get("warn_terms", []))
    findings: list[LintFinding] = []
    covered: list[tuple[int, int]] = []
    for term in sorted(block_terms + warn_terms, key=len, reverse=True):
        # \b only works against word characters; "etc." and "and/or" end without one.
        head = r"\b" if term[0].isalnum() else ""
        tail = r"\b" if term[-1].isalnum() else ""
        spans = [
            m.span()
            for m in re.finditer(head + re.escape(term) + tail, statement, re.IGNORECASE)
            if not any(m.start() >= s and m.end() <= e for s, e in covered)
        ]
        if not spans:
            continue
        covered.extend(spans)
        severity = "warn" if term in warn_terms else None
        findings.extend(
            _finding(
                "banned_ambiguity_terms",
                f'ambiguous term "{term}" — replace with a verifiable formulation',
                severity=severity,
                span=span,
            )
            for span in spans
        )
    return findings


def _unbounded_number_span(statement: str) -> tuple[int, int] | None:
    """Span of the first numeric value outside a designator, or None.

    Designators are masked by span comparison rather than substitution so the
    offsets returned index into the original statement.
    """
    designator_spans = [m.span() for m in _DESIGNATOR.finditer(statement)]
    for m in _NUMBER.finditer(statement):
        if not any(s <= m.start() and m.end() <= e for s, e in designator_spans):
            return m.span()
    return None


def lint_statement(statement: str) -> list[LintFinding]:
    """Text-only rules over the shall statement."""
    findings: list[LintFinding] = []
    shall_matches = list(_SHALL.finditer(statement))
    if not shall_matches:
        findings.append(
            _finding("shall_form", 'statement contains no "shall" — not a verifiable requirement')
        )
    elif len(shall_matches) > 1:
        findings.append(
            _finding(
                "shall_form",
                f'statement contains {len(shall_matches)} "shall" clauses — split into separate '
                "requirements",
                span=shall_matches[1].span(),
            )
        )

    if m := _INDEFINITE_START.match(statement):
        findings.append(
            _finding(
                "active_subject",
                "statement starts with an indefinite pronoun — name the product "
                '("The <product> shall ...")',
                span=m.span(),
            )
        )
    elif m := _BARE_SHALL_START.match(statement):
        findings.append(
            _finding("active_subject", 'statement has no subject before "shall"', span=m.span())
        )

    findings.extend(_lint_banned_terms(statement))

    if (semi := statement.find(";")) != -1:
        findings.append(
            _finding(
                "single_thought",
                "semicolon-chained statement — split into one requirement per thought",
                span=(semi, semi + 1),
            )
        )
    if m := _EMBEDDED_RATIONALE.search(statement):
        findings.append(
            _finding(
                "single_thought",
                'embedded rationale ("because" / "in order to") — move it to the rationale field',
                span=m.span(),
            )
        )

    if (number_span := _unbounded_number_span(statement)) and not _BOUND_MARKERS.search(statement):
        findings.append(
            _finding(
                "quantitative_has_bounds",
                "numeric value without a tolerance or bound (±, <=, within, ...) is unverifiable",
                span=number_span,
            )
        )

    if m := _SHALL_NOT.search(statement):
        findings.append(
            _finding(
                "positive_statement",
                '"shall not" is hard to verify — restate positively where possible',
                span=m.span(),
            )
        )

    if m := _IMPLEMENTATION.search(statement):
        findings.append(
            _finding(
                "no_implementation_language",
                "implementation language — state WHAT is required, not HOW it is achieved",
                span=m.span(),
            )
        )

    if m := _OPERATIONS_SUBJECT.match(statement):
        findings.append(
            _finding(
                "no_operations_language",
                "operations language — operator/user tasks belong in the ConOps or a procedure",
                span=m.span(),
            )
        )

    return findings


def _normalize(text: str) -> str:
    return re.sub(r"[^a-z0-9]+", " ", text.lower()).strip()


def lint_requirement(
    statement: str,
    *,
    rationale: str | None = None,
    verification_method: str | None = None,
    tbd: bool = False,
    tbr: bool = False,
    tbr_owner_id: int | None = None,
    tbr_due: datetime | None = None,
    req_number: str | None = None,
) -> list[LintFinding]:
    """Full requirement lint: statement text plus baseline-readiness fields.

    Message strings for rationale/TBD/TBR blockers are load-bearing — they are
    what API/MCP callers surface from the baseline endpoint.
    """
    findings = lint_statement(statement)

    if not (rationale or "").strip():
        findings.append(_finding("rationale_present", "rationale is required to baseline"))
    elif _normalize(rationale) == _normalize(statement):
        findings.append(
            _finding(
                "rationale_present",
                "rationale restates the requirement — record why it exists, not what it says",
            )
        )

    if tbd:
        findings.append(
            _finding(
                "tbd_tbr_discipline",
                "statement contains a TBD value; resolve it before baselining",
            )
        )
    if tbr:
        if not tbr_owner_id:
            findings.append(
                _finding("tbd_tbr_discipline", "TBR requires an owner before baselining")
            )
        if not tbr_due:
            findings.append(
                _finding("tbd_tbr_discipline", "TBR requires a closure due date before baselining")
            )
        else:
            due = tbr_due if tbr_due.tzinfo else tbr_due.replace(tzinfo=UTC)
            if due < datetime.now(UTC):
                findings.append(
                    _finding(
                        "tbd_tbr_discipline",
                        f"TBR closure date {due.date().isoformat()} is overdue",
                        severity="warn",
                    )
                )

    if not (verification_method or "").strip():
        findings.append(
            _finding(
                "verification_method_set",
                "verification method (analysis/inspection/demonstration/test) is not set",
            )
        )

    if req_number is not None and not req_number.strip():
        findings.append(_finding("unique_reference", "requirement has no REQ number assigned"))

    return findings


def lint_requirement_row(req: Any) -> list[LintFinding]:
    """Lint an ORM Requirement (or anything with the same fields)."""
    return lint_requirement(
        req.statement,
        rationale=req.rationale,
        verification_method=req.verification_method,
        tbd=req.tbd,
        tbr=req.tbr,
        tbr_owner_id=req.tbr_owner_id,
        tbr_due=req.tbr_due,
        req_number=req.req_number,
    )


def baseline_lint_blockers(req: Any) -> list[str]:
    """Messages of block_baseline findings — what lifecycle.baseline() enforces.

    Deduplicated: findings are per-occurrence (for span rendering), but a term
    used twice is still one blocker.
    """
    messages = [f.message for f in lint_requirement_row(req) if f.severity == "block_baseline"]
    return list(dict.fromkeys(messages))
