"""Acceptance readiness as structured checks — the panel and accept gate.

Mirrors opal.se.readiness: hard checks here are exactly what
dispositions.accept() enforces, by construction — both consume the same
fields and the same lint findings, so the panel and the gate cannot drift.

Payload shape is shared with the requirements baseline panel:

    {ready: bool, checks: [{key, label, passed, severity, detail}]}
"""

from typing import Any

from sqlalchemy.orm import Session

from opal.db.models.risk import Risk, RiskDisposition
from opal.risks.lint import accept_lint_blockers

#: Dispositions a risk cannot be accepted from.
_UNACCEPTABLE = (RiskDisposition.ACCEPTED.value, RiskDisposition.REALIZED.value)


def _scenario_detail(risk: Risk) -> str | None:
    """Name what is missing from the scenario, or None when complete."""
    missing = [
        label
        for label, value in (
            ("condition", risk.condition),
            ("departure", risk.departure),
            ("consequence", risk.consequence),
        )
        if not (value or "").strip()
    ]
    has_part = risk.asset_part_id is not None
    has_text = bool((risk.asset_text or "").strip())
    if not has_part and not has_text:
        missing.append("asset")
    if not missing and has_part and has_text:
        return "both asset part and asset text set — exactly one names the asset"
    if missing:
        return "missing: " + ", ".join(missing)
    return None


def readiness(db: Session, risk: Risk) -> dict[str, Any]:
    """Structured pass/fail checks for accepting one risk.

    All checks are hard — acceptance is a signature; nothing advisory
    belongs on it. db is unused today but keeps the signature parallel to
    se.readiness for callers that treat the two generically.
    """
    scenario_detail = _scenario_detail(risk)
    lint_blockers = accept_lint_blockers(risk)
    lint_detail = (
        lint_blockers[0] + (f" (+{len(lint_blockers) - 1} more)" if len(lint_blockers) > 1 else "")
        if lint_blockers
        else None
    )

    checks = [
        {
            "key": "scenario_complete",
            "label": "scenario complete (condition · departure · asset · consequence)",
            "passed": scenario_detail is None,
            "severity": "hard",
            "detail": scenario_detail,
        },
        {
            "key": "owner_assigned",
            "label": "owner assigned",
            "passed": risk.owner_id is not None,
            "severity": "hard",
            "detail": None if risk.owner_id is not None else "a risk has exactly one owner",
        },
        {
            "key": "scored",
            "label": "scored (probability × impact)",
            "passed": 1 <= risk.probability <= 5 and 1 <= risk.impact <= 5,
            "severity": "hard",
            "detail": None,
        },
        {
            "key": "rationale_recorded",
            "label": "acceptance rationale recorded",
            "passed": bool((risk.acceptance_rationale or "").strip()),
            "severity": "hard",
            "detail": None,
        },
        {
            "key": "lint_clean",
            "label": "scenario lint clean",
            "passed": not lint_blockers,
            "severity": "hard",
            "detail": lint_detail,
        },
    ]

    ready = risk.disposition not in _UNACCEPTABLE and all(c["passed"] for c in checks)
    return {"ready": ready, "checks": checks}


def acceptance_blockers(db: Session, risk: Risk) -> list[str]:
    """Failing-check messages — what accept() reports on refusal."""
    blockers = []
    if risk.disposition in _UNACCEPTABLE:
        blockers.append(f"cannot accept from disposition '{risk.disposition}'")
    for check in readiness(db, risk)["checks"]:
        if not check["passed"]:
            blockers.append(check["detail"] or check["label"].split(" (")[0] + " required")
    return blockers
